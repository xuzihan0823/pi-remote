import { WebSocket } from "ws";
import {
  RELAY_PROTOCOL_VERSION,
  relayError,
  relayResponseFrame,
  parseRelayFrame,
  type RelayErrorInfo,
  type RelayFrame,
  type RelayRequestFrame,
  type RelayResponseFrame,
  type RelaySessionEventFrame,
} from "../protocol/relay-types.ts";

export type AgentConnectionState = "idle" | "connecting" | "connected" | "closed";

export interface AgentHandlerResult {
  ok: boolean;
  data?: unknown;
  error?: RelayErrorInfo;
}

export type AgentRequestHandler = (request: RelayRequestFrame) => AgentHandlerResult | Promise<AgentHandlerResult>;

export interface AgentClientOptions {
  url: string;
  token: string;
  deviceId: string;
  label?: string;
  handler?: AgentRequestHandler;
  logger?: (message: string) => void;
  WebSocketImpl?: typeof WebSocket;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const CLOSE_GRACE_MS = 1_000;

const notImplementedHandler: AgentRequestHandler = () => ({
  ok: false,
  error: relayError("not_implemented", "No agent request handler is configured"),
});

/**
 * Outbound WSS client for the Mac agent. It owns connection lifecycle and framing only:
 * every server request is handed to `handler`, which decides what (if anything) to run.
 * Handshake and heartbeat deadlines turn a silently dead socket (sleep, packet loss, half-open
 * TCP) into a `closed` state so the runtime can reconnect instead of waiting for a close event
 * that never arrives.
 */
export class AgentClient {
  readonly #options: AgentClientOptions;
  readonly #handler: AgentRequestHandler;
  readonly #logger: (message: string) => void;
  readonly #stateListeners = new Set<(state: AgentConnectionState) => void>();
  readonly #frameListeners = new Set<(frame: RelayFrame) => void>();
  readonly #handshakeTimeoutMs: number;
  readonly #heartbeatIntervalMs: number;

  #socket: WebSocket | null = null;
  #state: AgentConnectionState = "idle";
  #handshakeTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #pingSentAt: number | null = null;

  constructor(options: AgentClientOptions) {
    this.#options = options;
    this.#handler = options.handler ?? notImplementedHandler;
    this.#logger = options.logger ?? (() => {});
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  get state(): AgentConnectionState {
    return this.#state;
  }

  get deviceId(): string {
    return this.#options.deviceId;
  }

  onStateChange(listener: (state: AgentConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  onFrame(listener: (frame: RelayFrame) => void): () => void {
    this.#frameListeners.add(listener);
    return () => {
      this.#frameListeners.delete(listener);
    };
  }

  connect(): Promise<void> {
    if (this.#socket) {
      return Promise.reject(new Error("Agent client is already connected or connecting"));
    }

    const Impl = this.#options.WebSocketImpl ?? WebSocket;
    const url = new URL(this.#options.url);
    url.searchParams.set("token", this.#options.token);

    this.#setState("connecting");
    const socket = new Impl(url.toString());
    this.#socket = socket;

    socket.on("message", (data) => {
      if (this.#socket !== socket) return;
      this.#handleMessage(data.toString());
    });
    socket.on("pong", () => {
      if (this.#socket === socket) this.#pingSentAt = null;
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.#stopTimers();
      this.#socket = null;
      this.#setState("closed");
    });

    return new Promise<void>((resolveConnect, rejectConnect) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) rejectConnect(error);
        else resolveConnect();
      };

      this.#handshakeTimer = setTimeout(() => {
        if (this.#socket !== socket) return;
        this.#handshakeTimer = null;
        const reason = `agent handshake timed out after ${this.#handshakeTimeoutMs}ms`;
        settle(new Error(reason));
        this.#failSocket(socket, reason);
      }, this.#handshakeTimeoutMs);
      this.#handshakeTimer.unref();

      socket.on("open", () => {
        if (this.#socket !== socket) return;
        if (this.#handshakeTimer) {
          clearTimeout(this.#handshakeTimer);
          this.#handshakeTimer = null;
        }
        this.#setState("connected");
        this.#startHeartbeat(socket);
        this.#sendHello();
        settle();
      });
      socket.on("error", (error) => {
        this.#logger(`agent socket error: ${error.message}`);
        settle(error instanceof Error ? error : new Error(String(error)));
      });
      socket.on("close", () => settle(new Error("Agent connection closed before it opened")));
    });
  }

  disconnect(): void {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = null;
    this.#stopTimers();
    this.#setState("closed");

    const forceClose = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);
    forceClose.unref();
    socket.once("close", () => clearTimeout(forceClose));
    try {
      socket.close();
    } catch {
      clearTimeout(forceClose);
      socket.terminate();
    }
  }

  send(frame: RelayFrame): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Agent client is not connected");
    }
    socket.send(JSON.stringify(frame));
  }

  sendSessionEvent(sessionId: string, event: unknown): void {
    const frame: RelaySessionEventFrame = {
      version: RELAY_PROTOCOL_VERSION,
      type: "session_event",
      deviceId: this.#options.deviceId,
      sessionId,
      payload: { event },
    };
    this.send(frame);
  }

  #sendHello(): void {
    this.send({
      version: RELAY_PROTOCOL_VERSION,
      type: "hello",
      deviceId: this.#options.deviceId,
      payload: {
        role: "agent",
        ...(this.#options.label !== undefined ? { label: this.#options.label } : {}),
      },
    });
  }

  #handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#logger("agent received non-JSON frame");
      return;
    }

    const result = parseRelayFrame(parsed);
    if (!result.ok) {
      this.#logger(`agent received invalid frame: ${result.error.message}`);
      return;
    }
    const frame = result.frame;

    if (frame.type === "ping") {
      this.send({ version: RELAY_PROTOCOL_VERSION, type: "pong", payload: {} });
      return;
    }
    if (frame.type === "request") {
      void this.#handleRequest(frame);
      return;
    }
    for (const listener of this.#frameListeners) listener(frame);
  }

  async #handleRequest(request: RelayRequestFrame): Promise<void> {
    let result: AgentHandlerResult;
    try {
      result = await this.#handler(request);
    } catch (error) {
      result = {
        ok: false,
        error: relayError("internal_error", error instanceof Error ? error.message : String(error)),
      };
    }

    const response: RelayResponseFrame = relayResponseFrame(
      request.requestId,
      result.ok
        ? { ok: true, ...(result.data === undefined ? {} : { data: result.data }) }
        : { ok: false, error: result.error ?? relayError("internal_error", "Agent handler failed without an error") },
      {
        deviceId: this.#options.deviceId,
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      },
    );

    try {
      this.send(response);
    } catch (error) {
      this.#logger(`agent failed to send response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #startHeartbeat(socket: WebSocket): void {
    this.#pingSentAt = null;
    this.#heartbeatTimer = setInterval(() => this.#heartbeatTick(socket), this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref();
  }

  #heartbeatTick(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    if (this.#pingSentAt !== null) {
      const elapsedMs = Date.now() - this.#pingSentAt;
      // Sleep or a clock adjustment past the deadline lands here and kills the stale socket
      // instead of waiting for another full cycle.
      if (elapsedMs >= 0 && elapsedMs < this.#heartbeatIntervalMs) return;
      this.#failSocket(
        socket,
        `agent socket did not answer a ping within ${this.#heartbeatIntervalMs}ms; terminating the connection`,
      );
      return;
    }
    this.#pingSentAt = Date.now();
    try {
      socket.ping();
    } catch (error) {
      this.#failSocket(socket, `agent socket ping failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #failSocket(socket: WebSocket, reason: string): void {
    this.#logger(reason);
    this.#stopTimers();
    this.#socket = null;
    this.#setState("closed");
    socket.terminate();
  }

  #stopTimers(): void {
    if (this.#handshakeTimer) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#pingSentAt = null;
  }

  #setState(state: AgentConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }
}
