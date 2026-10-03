#!/usr/bin/env node
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { WebSocket } from "ws";
import {
  RELAY_PROTOCOL_VERSION,
  parseRelayFrame,
  type RelayFrame,
  type RelayHelloAckFrame,
  type RelayResponseFrame,
} from "../src/protocol/relay-types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const IOS_DEVICE_ID = "check-relay-ios";

interface Options {
  insecure: boolean;
  timeoutMs: number;
}

function usage(): string {
  return [
    "Usage: node scripts/check-relay.ts [--insecure] [--timeout-ms <ms>]",
    "",
    "Environment:",
    "  RELAY_URL     wss://<domain>/ws/agent (required; /ws/agent is rewritten to /ws/ios)",
    "  RELAY_TOKEN   shared relay token (required; never printed)",
    "  RELAY_TIMEOUT_MS  overall timeout in ms (default 15000)",
    "",
    "RELAY_URL must not contain userinfo, a query string or a fragment.",
    "Checks TLS, /api/health, credential rejection, the iOS WebSocket handshake and",
    "session.list. It never starts a session or calls the model.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    insecure: false,
    timeoutMs: parseTimeoutMs(process.env.RELAY_TIMEOUT_MS),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--insecure") {
      options.insecure = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--timeout-ms requires a value");
      options.timeoutMs = parseTimeoutMs(value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`RELAY_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(raw)}`);
  const value = Number(raw.trim());
  if (value <= 0) throw new Error("RELAY_TIMEOUT_MS must be greater than 0");
  return value;
}

function parseRelayUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RELAY_URL must be a valid ws:// or wss:// URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`RELAY_URL must use ws:// or wss://, got ${JSON.stringify(url.protocol)}`);
  }
  if (url.hostname.length === 0) throw new Error("RELAY_URL must include a host");
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("RELAY_URL must not include userinfo; use RELAY_TOKEN");
  }
  if (raw.includes("?") || raw.includes("#")) {
    throw new Error("RELAY_URL must not include a query string or fragment; use RELAY_TOKEN");
  }
  if (!url.pathname.endsWith("/ws/agent")) {
    throw new Error(`RELAY_URL path must end with /ws/agent, got ${JSON.stringify(url.pathname)}`);
  }
  return url;
}

function iosUrlFrom(agentUrl: URL): URL {
  const url = new URL(agentUrl.toString());
  url.pathname = url.pathname.slice(0, -"/ws/agent".length) + "/ws/ios";
  return url;
}

function httpUrlFrom(agentUrl: URL, path: string): URL {
  const url = new URL(agentUrl.toString());
  url.protocol = agentUrl.protocol === "wss:" ? "https:" : "http:";
  url.pathname = path;
  url.search = "";
  return url;
}

interface HttpResponse {
  status: number;
  body: string;
}

function httpGet(url: URL, token: string | null, options: Options): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const request = isHttps ? httpsRequest : httpRequest;
    const headers = token === null ? undefined : { authorization: `Bearer ${token}` };
    const req = request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port.length > 0 ? url.port : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        ...(isHttps ? { rejectUnauthorized: !options.insecure } : {}),
        ...(headers ? { headers } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`request to ${url.pathname} timed out`)));
    req.on("error", reject);
    req.end();
  });
}

class WsUpgradeRejectedError extends Error {
  readonly statusCode: number;

  constructor(path: string, statusCode: number) {
    super(`WebSocket ${path} upgrade rejected with HTTP ${statusCode}`);
    this.name = "WsUpgradeRejectedError";
    this.statusCode = statusCode;
  }
}

function openSocket(url: URL, token: string | null, options: Options): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.toString(), {
      rejectUnauthorized: !options.insecure,
      ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket ${url.pathname} open timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    socket.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      socket.terminate();
      reject(new WsUpgradeRejectedError(url.pathname, res.statusCode ?? 0));
    });
  });
}

class FrameQueue {
  readonly #frames: RelayFrame[] = [];
  readonly #waiters: Array<(frame: RelayFrame) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const result = parseRelayFrame(parsed);
      if (!result.ok) return;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(result.frame);
      else this.#frames.push(result.frame);
    });
  }

  next(timeoutMs: number): Promise<RelayFrame> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`no relay frame within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (next: RelayFrame): void => {
        clearTimeout(timer);
        resolve(next);
      };
      this.#waiters.push(waiter);
    });
  }
}

function pass(message: string): void {
  console.log(`  PASS  ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runChecks(options: Options): Promise<void> {
  const rawUrl = (process.env.RELAY_URL ?? "").trim();
  const token = (process.env.RELAY_TOKEN ?? "").trim();
  if (rawUrl.length === 0) throw new Error("RELAY_URL is required");
  if (token.length === 0) throw new Error("RELAY_TOKEN is required");

  const agentUrl = parseRelayUrl(rawUrl);
  const iosUrl = iosUrlFrom(agentUrl);
  const healthUrl = httpUrlFrom(agentUrl, "/api/health");
  const statusUrl = httpUrlFrom(agentUrl, "/api/status");

  console.log(`Checking relay ${healthUrl.origin} (agent path ${agentUrl.pathname})`);
  if (options.insecure) console.log("  WARN  TLS certificate verification is disabled (--insecure)");

  const health = await httpGet(healthUrl, null, options);
  if (health.status !== 200) fail(`GET /api/health returned ${health.status}, expected 200`);
  let healthBody: Record<string, unknown>;
  try {
    healthBody = JSON.parse(health.body) as Record<string, unknown>;
  } catch {
    fail("/api/health did not return JSON");
  }
  if (healthBody.status !== "ok") fail(`/api/health reported status ${JSON.stringify(healthBody.status)}, expected "ok"`);
  pass(`TLS + /api/health ok (agentConnected=${healthBody.agentConnected === true})`);

  const unauthorized = await httpGet(statusUrl, null, options);
  if (unauthorized.status !== 401) fail(`GET /api/status without credentials returned ${unauthorized.status}, expected 401`);
  pass("/api/status rejected without credentials (401)");

  const probe = await openSocket(iosUrl, null, options).then(
    (socket) => ({ accepted: true as const, socket }),
    (error: unknown) => ({ accepted: false as const, error }),
  );
  if (probe.accepted) {
    probe.socket.terminate();
    fail("WebSocket upgrade without credentials was accepted");
  }
  if (!(probe.error instanceof WsUpgradeRejectedError) || probe.error.statusCode !== 401) {
    fail(`WebSocket upgrade without credentials was not rejected with HTTP 401 (${describeError(probe.error)})`);
  }
  pass("/ws/ios upgrade rejected without credentials (401)");

  const ios = await openSocket(iosUrl, token, options);
  try {
    const queue = new FrameQueue(ios);
    ios.send(
      JSON.stringify({
        version: RELAY_PROTOCOL_VERSION,
        type: "hello",
        deviceId: IOS_DEVICE_ID,
        payload: { role: "ios" },
      }),
    );
    const ack = await queue.next(options.timeoutMs);
    if (ack.type !== "hello_ack") fail(`expected hello_ack, got ${ack.type}`);
    const helloAck = ack as RelayHelloAckFrame;
    if (helloAck.payload.role !== "ios") fail(`hello_ack role was ${helloAck.payload.role}, expected "ios"`);
    pass(`iOS WebSocket handshake ok (agentConnected=${helloAck.payload.agentConnected === true})`);

    const requestId = `check-${Date.now()}`;
    ios.send(
      JSON.stringify({
        version: RELAY_PROTOCOL_VERSION,
        type: "request",
        requestId,
        payload: { method: "session.list" },
      }),
    );
    const frame = await queue.next(options.timeoutMs);
    if (frame.type !== "response") fail(`expected a response to session.list, got ${frame.type}`);
    const response = frame as RelayResponseFrame;
    if (response.requestId !== requestId) {
      fail(`session.list response requestId ${JSON.stringify(response.requestId)} does not match ${JSON.stringify(requestId)}`);
    }
    if (!response.payload.ok) {
      const error = response.payload.error;
      fail(`session.list failed (${error?.code ?? "unknown"}): ${error?.message ?? "no message"}`);
    }
    const data = response.payload.data;
    const sessions =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>).sessions : undefined;
    if (!Array.isArray(sessions)) fail("session.list response did not include a sessions array");
    pass(`session.list ok: Mac agent is online (${sessions.length} active session(s))`);
  } finally {
    ios.close();
  }
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    return 2;
  }

  const timer = setTimeout(() => {
    console.error(`FAILED: overall timeout after ${options.timeoutMs}ms`);
    process.exit(1);
  }, options.timeoutMs);

  try {
    await runChecks(options);
    clearTimeout(timer);
    console.log("OK: relay reachable, credentials enforced, Mac agent online");
    return 0;
  } catch (error) {
    clearTimeout(timer);
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
