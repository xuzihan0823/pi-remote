import { WebSocket } from "ws";
import type { Config } from "../../src/config.ts";
import type { RelayFrame, RelayHelloFrame, RelayRequestFrame } from "../../src/protocol/relay-types.ts";
import { RelayServer, type RelayServerOptions } from "../../src/relay/server.ts";

export const TEST_TOKEN = "test-token-0123456789abcdef0123456789abcdef";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    relayHost: "127.0.0.1",
    relayPort: 0,
    relayToken: TEST_TOKEN,
    relayUrl: "ws://127.0.0.1/ws/agent",
    agentToken: TEST_TOKEN,
    agentDeviceId: "test-agent",
    piBin: "pi",
    piWorkspaceRoot: "/tmp",
    maxSessions: 4,
    ...overrides,
  };
}

export async function startTestServer(
  overrides: Partial<Config> = {},
  options: Partial<Omit<RelayServerOptions, "config">> = {},
): Promise<{ server: RelayServer; port: number }> {
  const server = new RelayServer({ config: testConfig(overrides), logger: () => {}, ...options });
  const address = await server.start();
  return { server, port: address.port };
}

export class FrameQueue {
  readonly #frames: RelayFrame[] = [];
  readonly #waiters: ((frame: RelayFrame) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as RelayFrame;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#frames.push(frame);
    });
  }

  next(): Promise<RelayFrame> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

export function openSocket(port: number, path: string, token: string | null = TEST_TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const query = token === null ? "" : `?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", (error) => reject(error));
  });
}

export function helloFrame(deviceId: string, role: "ios" | "agent"): RelayHelloFrame {
  return { version: 1, type: "hello", deviceId, payload: { role } };
}

export function requestFrame(
  requestId: string,
  method: RelayRequestFrame["payload"]["method"],
  options: { sessionId?: string; params?: Record<string, unknown> } = {},
): RelayRequestFrame {
  const frame: RelayRequestFrame = {
    version: 1,
    type: "request",
    requestId,
    payload: options.params ? { method, params: options.params } : { method },
  };
  if (options.sessionId) frame.sessionId = options.sessionId;
  return frame;
}

export function send(ws: WebSocket, frame: RelayFrame | Record<string, unknown>): void {
  ws.send(JSON.stringify(frame));
}

export function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once("close", () => resolve()));
}
