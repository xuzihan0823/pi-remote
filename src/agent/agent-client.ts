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
}

const notImplementedHandler: AgentRequestHandler = () => ({
  ok: false,
  error: relayError("not_implemented", "No agent request handler is configured"),
});

/**
 * Outbound WSS client for the Mac agent. It owns connection lifecycle and framing only:
 * every server request is handed to `handler`, which decides what (if anything) to run.
 */
export class AgentClient {
  readonly #options: AgentClientOptions;
  readonly #handler: AgentRequestHandler;
  readonly #logger: (message: string) => void;
  readonly #stateListeners = new Set<(state: AgentConnectionState) => void>();
  readonly #frameListeners = new Set<(frame: RelayFrame) => void>();

  #socket: WebSocket | null = null;
  #state: AgentConnectionState = "idle";

  constructor(options: AgentClientOptions) {
    this.#options = options;
    this.#handler = options.handler ?? notImplementedHandler;
    this.#logger = options.logger ?? (() => {});
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

    socket.on("message", (data) => this.#handleMessage(data.toString()));
    socket.on("close", () => {
      if (this.#socket === socket) this.#socket = null;
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

      socket.on("open", () => {
        this.#setState("connected");
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
    socket.close();
    this.#setState("closed");
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

  #setState(state: AgentConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }
}
