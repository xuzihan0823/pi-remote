import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Config } from "../config.ts";
import {
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_METHODS,
  relayError,
  relayErrorFrame,
  parseRelayFrame,
  type RelayFrame,
  type RelayHelloFrame,
  type RelayRole,
} from "../protocol/relay-types.ts";
import { SessionRouter, type RelayPeer } from "./session-router.ts";

export interface RelayServerOptions {
  config: Config;
  logger?: (message: string) => void;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxPayloadBytes?: number;
}

export interface RelayServerAddress {
  host: string;
  port: number;
}

interface ClientState {
  socket: WebSocket;
  role: RelayRole;
  peer: SocketPeer | null;
  registered: boolean;
  isAlive: boolean;
}

class SocketPeer implements RelayPeer {
  readonly deviceId: string;
  readonly role: RelayRole;
  readonly socket: WebSocket;

  constructor(deviceId: string, role: RelayRole, socket: WebSocket) {
    this.deviceId = deviceId;
    this.role = role;
    this.socket = socket;
  }

  send(frame: RelayFrame): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }
}

export class RelayServer {
  readonly #config: Config;
  readonly #logger: (message: string) => void;
  readonly #heartbeatIntervalMs: number;
  readonly #maxPayloadBytes: number;
  readonly #router: SessionRouter;
  readonly #httpServer: Server;
  readonly #wssIos: WebSocketServer;
  readonly #wssAgent: WebSocketServer;
  readonly #clients = new Map<WebSocket, ClientState>();
  readonly #startedAt = Date.now();

  #heartbeat: NodeJS.Timeout | null = null;

  constructor(options: RelayServerOptions) {
    this.#config = options.config;
    this.#logger = options.logger ?? ((message) => console.log(message));
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? 4 * 1024 * 1024;
    this.#router = new SessionRouter({ requestTimeoutMs: options.requestTimeoutMs, logger: this.#logger });

    this.#httpServer = createServer((req, res) => this.#handleHttpRequest(req, res));
    this.#httpServer.on("upgrade", (req, socket, head) => this.#handleUpgrade(req, socket, head));

    this.#wssIos = new WebSocketServer({ noServer: true, maxPayload: this.#maxPayloadBytes });
    this.#wssAgent = new WebSocketServer({ noServer: true, maxPayload: this.#maxPayloadBytes });
  }

  get router(): SessionRouter {
    return this.#router;
  }

  async start(): Promise<RelayServerAddress> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#httpServer.once("error", onError);
      this.#httpServer.listen(this.#config.relayPort, this.#config.relayHost, () => {
        this.#httpServer.off("error", onError);
        resolve();
      });
    });

    this.#heartbeat = setInterval(() => this.#heartbeatTick(), this.#heartbeatIntervalMs);
    this.#heartbeat.unref();

    const address = this.#httpServer.address() as AddressInfo;
    this.#logger(`relay listening on ${address.address}:${address.port}`);
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    for (const state of this.#clients.values()) {
      try {
        state.socket.terminate();
      } catch {
        // socket already gone
      }
    }
    this.#clients.clear();
    this.#router.close();

    await new Promise<void>((resolve) => {
      this.#httpServer.close(() => resolve());
      this.#httpServer.closeAllConnections();
    });
  }

  #handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, this.#health());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      if (!this.#authorize(req, url)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      sendJson(res, 200, this.#health());
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  }

  #handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const wss = url.pathname === "/ws/ios" ? this.#wssIos : url.pathname === "/ws/agent" ? this.#wssAgent : null;
    if (!wss) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!this.#authorize(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const role: RelayRole = url.pathname === "/ws/agent" ? "agent" : "ios";
    wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, role));
  }

  #onConnection(socket: WebSocket, role: RelayRole): void {
    const state: ClientState = { socket, role, peer: null, registered: false, isAlive: true };
    this.#clients.set(socket, state);
    this.#logger(`${role} connected`);

    socket.on("pong", () => {
      state.isAlive = true;
    });
    socket.on("message", (data) => this.#onMessage(state, data));
    socket.on("close", () => this.#onClose(state));
    socket.on("error", (error) => this.#logger(`${role} socket error: ${error.message}`));
  }

  #onMessage(state: ClientState, data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      sendFrame(state.socket, relayErrorFrame(relayError("invalid_json", "Message is not valid JSON")));
      return;
    }

    const result = parseRelayFrame(parsed);
    if (!result.ok) {
      const requestId = parsed && typeof parsed === "object" && "requestId" in parsed && typeof parsed.requestId === "string" && parsed.requestId.length <= 128 ? parsed.requestId : undefined;
      sendFrame(state.socket, relayErrorFrame(result.error, { deviceId: state.peer?.deviceId, requestId }));
      return;
    }
    const frame = result.frame;

    if (!state.registered) {
      if (frame.type !== "hello") {
        sendFrame(
          state.socket,
          relayErrorFrame(relayError("hello_required", "Send a hello frame before anything else"), {
            requestId: requestIdOf(frame),
          }),
        );
        return;
      }
      this.#handleHello(state, frame);
      return;
    }

    if (frame.type === "ping") {
      sendFrame(state.socket, { version: RELAY_PROTOCOL_VERSION, type: "pong", payload: {} });
      return;
    }
    if (state.peer) this.#router.handleFrame(state.peer, frame);
  }

  #handleHello(state: ClientState, frame: RelayHelloFrame): void {
    if (frame.payload.role !== state.role) {
      sendFrame(state.socket, relayErrorFrame(relayError("invalid_frame", `role "${frame.payload.role}" does not match endpoint "${state.role}"`)));
      state.socket.close(1008, "role mismatch");
      return;
    }
    if (state.role === "agent" && this.#router.hasAgent()) {
      sendFrame(state.socket, relayErrorFrame(relayError("agent_already_connected", "An agent is already connected")));
      state.socket.close(1008, "agent already connected");
      return;
    }

    const peer = new SocketPeer(frame.deviceId, state.role, state.socket);
    state.peer = peer;
    state.registered = true;

    if (state.role === "agent") this.#router.attachAgent(peer);
    else this.#router.attachIos(peer);

    this.#logger(`${state.role} "${frame.deviceId}" registered`);

    sendFrame(state.socket, {
      version: RELAY_PROTOCOL_VERSION,
      type: "hello_ack",
      deviceId: frame.deviceId,
      payload: {
        role: state.role,
        protocolVersion: RELAY_PROTOCOL_VERSION,
        supportedMethods: [...RELAY_REQUEST_METHODS],
        agentConnected: this.#router.hasAgent(),
        iosClients: this.#router.iosClientCount(),
      },
    });
  }

  #onClose(state: ClientState): void {
    this.#clients.delete(state.socket);
    if (!state.peer) return;
    if (state.peer.role === "agent") this.#router.detachAgent(state.peer);
    else this.#router.detachIos(state.peer);
    this.#logger(`${state.peer.role} "${state.peer.deviceId}" disconnected`);
  }

  #heartbeatTick(): void {
    for (const state of this.#clients.values()) {
      if (!state.isAlive) {
        state.socket.terminate();
        continue;
      }
      state.isAlive = false;
      try {
        state.socket.ping();
      } catch {
        state.socket.terminate();
      }
    }
  }

  #authorize(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    let provided: string | undefined;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      provided = header.slice("Bearer ".length).trim();
    }
    if (!provided) provided = url.searchParams.get("token") ?? undefined;
    return tokenEquals(provided, this.#config.relayToken);
  }

  #health(): Record<string, unknown> {
    return {
      status: "ok",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      uptimeMs: Date.now() - this.#startedAt,
      agentConnected: this.#router.hasAgent(),
      agentDeviceId: this.#router.agentDeviceId() ?? null,
      iosClients: this.#router.iosClientCount(),
    };
  }
}

function sendFrame(socket: WebSocket, frame: RelayFrame): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function tokenEquals(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function requestIdOf(frame: RelayFrame): string | undefined {
  return "requestId" in frame ? frame.requestId : undefined;
}
