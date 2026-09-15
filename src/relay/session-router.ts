import {
  RELAY_PROTOCOL_VERSION,
  relayError,
  relayErrorFrame,
  relayResponseFrame,
  type RelayErrorCode,
  type RelayErrorInfo,
  type RelayFrame,
  type RelayRequestFrame,
  type RelayRole,
  type RelaySessionEventFrame,
} from "../protocol/relay-types.ts";

export interface RelayPeer {
  readonly deviceId: string;
  readonly role: RelayRole;
  send(frame: RelayFrame): void;
}

export interface SessionRouterOptions {
  requestTimeoutMs?: number;
  logger?: (message: string) => void;
}

interface PendingRequest {
  peer: RelayPeer;
  sessionId: string | undefined;
  timer: NodeJS.Timeout;
}

export class SessionRouter {
  readonly #requestTimeoutMs: number;
  readonly #logger: (message: string) => void;

  #agent: RelayPeer | null = null;
  readonly #ios = new Map<string, RelayPeer>();
  readonly #subscribers = new Map<string, Set<RelayPeer>>();
  readonly #allSubscribers = new Set<RelayPeer>();
  readonly #sessionOwner = new Map<string, RelayPeer>();
  readonly #pending = new Map<string, PendingRequest>();

  constructor(options: SessionRouterOptions = {}) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#logger = options.logger ?? (() => {});
  }

  attachAgent(peer: RelayPeer): void {
    this.#agent = peer;
  }

  hasAgent(): boolean {
    return this.#agent !== null;
  }

  agentDeviceId(): string | undefined {
    return this.#agent?.deviceId;
  }

  attachIos(peer: RelayPeer): void {
    this.#ios.set(peer.deviceId, peer);
  }

  iosClientCount(): number {
    return this.#ios.size;
  }

  pendingRequestCount(): number {
    return this.#pending.size;
  }

  subscriberCount(sessionId: string): number {
    return this.#subscribers.get(sessionId)?.size ?? 0;
  }

  allSubscriberCount(): number {
    return this.#allSubscribers.size;
  }

  detachIos(peer: RelayPeer): void {
    this.#ios.delete(peer.deviceId);
    this.#allSubscribers.delete(peer);
    for (const [sessionId, peers] of this.#subscribers) {
      peers.delete(peer);
      if (peers.size === 0) this.#subscribers.delete(sessionId);
    }
    for (const [requestId, pending] of this.#pending) {
      if (pending.peer === peer) {
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
      }
    }
  }

  detachAgent(peer: RelayPeer): void {
    if (this.#agent !== peer) return;
    this.#agent = null;
    for (const [sessionId, owner] of this.#sessionOwner) {
      if (owner === peer) this.#sessionOwner.delete(sessionId);
    }
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      this.#replyError(pending.peer, requestId, "agent_disconnected", "Mac agent disconnected before responding", pending.sessionId);
    }
    for (const ios of this.#ios.values()) {
      ios.send(
        relayErrorFrame(relayError("agent_disconnected", "Mac agent disconnected"), { deviceId: ios.deviceId }),
      );
    }
  }

  handleFrame(peer: RelayPeer, frame: RelayFrame): void {
    if (peer.role === "agent") {
      this.#handleAgentFrame(peer, frame);
    } else {
      this.#handleIosFrame(peer, frame);
    }
  }

  close(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#subscribers.clear();
    this.#allSubscribers.clear();
    this.#sessionOwner.clear();
  }

  #handleIosFrame(peer: RelayPeer, frame: RelayFrame): void {
    switch (frame.type) {
      case "request":
        this.#handleIosRequest(peer, frame);
        return;
      case "ping":
        peer.send({ version: RELAY_PROTOCOL_VERSION, type: "pong", payload: {} });
        return;
      case "pong":
        return;
      default:
        this.#replyError(peer, requestIdOf(frame), "invalid_frame", `iOS clients must not send "${frame.type}" frames`);
    }
  }

  #handleAgentFrame(peer: RelayPeer, frame: RelayFrame): void {
    switch (frame.type) {
      case "response":
        this.#handleAgentResponse(peer, frame);
        return;
      case "session_event":
        this.#handleAgentEvent(peer, frame);
        return;
      case "error":
        this.#handleAgentError(peer, frame);
        return;
      case "ping":
        peer.send({ version: RELAY_PROTOCOL_VERSION, type: "pong", payload: {} });
        return;
      case "pong":
        return;
      default:
        this.#logger(`Ignoring unexpected "${frame.type}" frame from agent "${peer.deviceId}"`);
    }
  }

  #handleIosRequest(peer: RelayPeer, frame: RelayRequestFrame): void {
    const { method, params } = frame.payload;

    if (method === "subscribe" || method === "unsubscribe") {
      const sessionId = frame.sessionId ?? stringParam(params, "sessionId");
      if (sessionId) {
        const set = this.#subscribers.get(sessionId) ?? new Set<RelayPeer>();
        if (method === "subscribe") set.add(peer);
        else set.delete(peer);
        if (set.size === 0) this.#subscribers.delete(sessionId);
        else this.#subscribers.set(sessionId, set);
      } else if (method === "subscribe") {
        this.#allSubscribers.add(peer);
      } else {
        this.#allSubscribers.delete(peer);
      }
      peer.send(
        relayResponseFrame(
          frame.requestId,
          { ok: true, data: { subscribed: method === "subscribe", sessionId: sessionId ?? null } },
          { deviceId: peer.deviceId, ...(sessionId ? { sessionId } : {}) },
        ),
      );
      return;
    }

    const validation = validateRoutedRequest(frame);
    if (!validation.ok) {
      this.#replyError(peer, frame.requestId, validation.error.code, validation.error.message, validation.sessionId);
      return;
    }

    if (this.#pending.has(frame.requestId)) {
      this.#replyError(
        peer,
        frame.requestId,
        "duplicate_request_id",
        `requestId "${frame.requestId}" is already in flight`,
        validation.sessionId,
      );
      return;
    }

    const agent = this.#resolveAgent(validation.sessionId);
    if (!agent) {
      this.#replyError(peer, frame.requestId, "no_agent_connected", "No Mac agent is connected", validation.sessionId);
      return;
    }

    const timer = setTimeout(() => {
      const pending = this.#pending.get(frame.requestId);
      if (!pending) return;
      this.#pending.delete(frame.requestId);
      this.#replyError(peer, frame.requestId, "timeout", `No agent response within ${this.#requestTimeoutMs}ms`, pending.sessionId);
    }, this.#requestTimeoutMs);
    this.#pending.set(frame.requestId, { peer, sessionId: validation.sessionId, timer });

    agent.send({ ...frame, deviceId: peer.deviceId });
  }

  #handleAgentResponse(peer: RelayPeer, frame: Extract<RelayFrame, { type: "response" }>): void {
    const pending = this.#pending.get(frame.requestId);
    if (!pending) {
      this.#logger(`Ignoring agent response for unknown requestId "${frame.requestId}"`);
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(frame.requestId);

    const responseSessionId = frame.sessionId ?? this.#sessionIdFromData(frame.payload.data);
    if (responseSessionId) {
      this.#sessionOwner.set(responseSessionId, peer);
      if (frame.payload.ok) this.#subscribeToSession(pending.peer, responseSessionId);
    }

    pending.peer.send(responseSessionId ? { ...frame, sessionId: responseSessionId } : frame);
  }

  #handleAgentEvent(peer: RelayPeer, frame: RelaySessionEventFrame): void {
    this.#sessionOwner.set(frame.sessionId, peer);
    const recipients = new Set<RelayPeer>(this.#subscribers.get(frame.sessionId) ?? []);
    for (const peer2 of this.#allSubscribers) recipients.add(peer2);
    for (const recipient of recipients) recipient.send(frame);
  }

  #handleAgentError(peer: RelayPeer, frame: Extract<RelayFrame, { type: "error" }>): void {
    const requestId = frame.requestId;
    if (requestId && this.#pending.has(requestId)) {
      const pending = this.#pending.get(requestId)!;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.peer.send(frame);
      return;
    }
    for (const ios of this.#ios.values()) ios.send(frame);
  }

  #resolveAgent(sessionId: string | undefined): RelayPeer | null {
    if (sessionId) {
      const owner = this.#sessionOwner.get(sessionId);
      if (owner) return owner;
    }
    return this.#agent;
  }

  #subscribeToSession(peer: RelayPeer, sessionId: string): void {
    const set = this.#subscribers.get(sessionId) ?? new Set<RelayPeer>();
    set.add(peer);
    this.#subscribers.set(sessionId, set);
  }

  #replyError(peer: RelayPeer, requestId: string | undefined, code: RelayErrorCode, message: string, sessionId?: string): void {
    if (requestId) {
      peer.send(
        relayResponseFrame(
          requestId,
          { ok: false, error: relayError(code, message) },
          { deviceId: peer.deviceId, ...(sessionId ? { sessionId } : {}) },
        ),
      );
      return;
    }
    peer.send(relayErrorFrame(relayError(code, message), { deviceId: peer.deviceId, ...(sessionId ? { sessionId } : {}) }));
  }

  #sessionIdFromData(data: unknown): string | undefined {
    if (typeof data !== "object" || data === null) return undefined;
    const sessionId = (data as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  }
}

type ValidationResult =
  | { ok: true; sessionId: string | undefined }
  | { ok: false; error: RelayErrorInfo; sessionId: string | undefined };

function validateRoutedRequest(frame: RelayRequestFrame): ValidationResult {
  const params = frame.payload.params;
  const sessionId = frame.sessionId ?? stringParam(params, "sessionId");

  switch (frame.payload.method) {
    case "session.list":
      return { ok: true, sessionId };
    case "session.start":
      return { ok: true, sessionId };
    case "session.prompt": {
      if (!sessionId) return invalid("session.prompt requires sessionId", sessionId);
      if (!stringParam(params, "message") || stringParam(params, "message")!.length === 0) {
        return invalid("session.prompt requires a non-empty params.message", sessionId);
      }
      return { ok: true, sessionId };
    }
    case "session.abort":
      if (!sessionId) return invalid("session.abort requires sessionId", sessionId);
      return { ok: true, sessionId };
    case "ui.response":
      if (!sessionId) return invalid("ui.response requires sessionId", sessionId);
      if (!stringParam(params, "requestId")) return invalid("ui.response requires a params.requestId", sessionId);
      return { ok: true, sessionId };
    default:
      return invalid(`Unsupported method ${frame.payload.method}`, sessionId);
  }
}

function invalid(message: string, sessionId: string | undefined): ValidationResult {
  return { ok: false, error: relayError("invalid_frame", message), sessionId };
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requestIdOf(frame: RelayFrame): string | undefined {
  return "requestId" in frame ? frame.requestId : undefined;
}
