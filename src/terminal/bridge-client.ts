import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RelayErrorCode } from "../protocol/relay-types.ts";

/** Every session served by the terminal bridge is addressed with this prefix. */
export const TERMINAL_SESSION_PREFIX = "terminal:";
/** Overrides the bridge directory; both the extension and this client read it. */
export const BRIDGE_DIR_ENV = "PI_REMOTE_BRIDGE_DIR";

const SOCKET_FILE_PREFIX = "b-";
const SOCKET_FILE_SUFFIX = ".sock";
const MAX_SOCKETS_PER_LIST = 64;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export type TerminalActivity = "busy" | "idle" | "unknown";

export interface TerminalSessionMeta {
  sessionId: string;
  title: string;
  cwd: string;
  activity: TerminalActivity;
  /** Present only for the initial session of a gateway-created terminal. */
  launchId?: string;
}

export interface TerminalSnapshotMessage {
  role: "user" | "assistant";
  text: string;
}

export interface TerminalSessionSnapshot {
  sessionId: string;
  activity: TerminalActivity;
  messages: TerminalSnapshotMessage[];
  truncated: boolean;
}

export function isTerminalSessionId(sessionId: string): boolean {
  return sessionId.startsWith(TERMINAL_SESSION_PREFIX);
}

export function defaultBridgeDirs(): string[] {
  const override = process.env[BRIDGE_DIR_ENV];
  if (override !== undefined && override.trim().length > 0) return [override.trim()];
  return [join(homedir(), ".pi", "agent", "pi-remote-bridge"), join(homedir(), ".omp", "agent", "pi-remote-bridge")];
}

export function defaultBridgeDir(): string {
  return defaultBridgeDirs()[0]!;
}

/** Error carrying a relay-compatible code so the agent handler can forward it unchanged. */
export class TerminalBridgeError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = "TerminalBridgeError";
    this.code = code;
  }
}

export interface TerminalSessionBridgeOptions {
  workspaceRoot: string;
  bridgeDir?: string;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  logger?: (message: string) => void;
}

interface DiscoveredSession {
  meta: TerminalSessionMeta;
  socketPath: string;
}

/**
 * Read-only client for the pi terminal bridge extension. Each call opens a short-lived,
 * bounded unix-socket connection, so a hung or stale bridge can never block session.list,
 * and closing the bridge only drops these client sockets — it never signals the user's
 * terminal process.
 */
export class TerminalSessionBridge {
  readonly #workspaceRoot: string;
  readonly #dirs: string[];
  readonly #probeTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #logger: (message: string) => void;
  readonly #sockets = new Set<Socket>();

  #closed = false;
  #realRoot: string | null = null;

  constructor(options: TerminalSessionBridgeOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#dirs = options.bridgeDir ? [options.bridgeDir] : defaultBridgeDirs();
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#logger = options.logger ?? (() => {});
  }

  get bridgeDir(): string {
    return this.#dirs[0]!;
  }

  get bridgeDirs(): readonly string[] {
    return this.#dirs;
  }

  async list(): Promise<TerminalSessionMeta[]> {
    const discovered = await this.#discover();
    const seen = new Set<string>();
    const metas: TerminalSessionMeta[] = [];
    for (const entry of discovered) {
      if (seen.has(entry.meta.sessionId)) continue;
      seen.add(entry.meta.sessionId);
      metas.push(entry.meta);
    }
    return metas;
  }

  async get(sessionId: string): Promise<TerminalSessionMeta> {
    const entry = await this.#resolve(sessionId);
    return entry.meta;
  }

  async snapshot(sessionId: string): Promise<TerminalSessionSnapshot> {
    const entry = await this.#resolve(sessionId);
    const data = await this.#call(entry.socketPath, { op: "snapshot", sessionId }, this.#requestTimeoutMs);
    const snapshot = parseSnapshot(data);
    if (!snapshot || snapshot.sessionId !== sessionId) {
      throw new TerminalBridgeError("internal_error", "terminal bridge returned an invalid snapshot");
    }
    return snapshot;
  }

  async prompt(sessionId: string, message: string): Promise<void> {
    const entry = await this.#resolve(sessionId);
    await this.#call(entry.socketPath, { op: "prompt", sessionId, message }, this.#requestTimeoutMs);
  }

  async abort(sessionId: string): Promise<void> {
    const entry = await this.#resolve(sessionId);
    await this.#call(entry.socketPath, { op: "abort", sessionId }, this.#requestTimeoutMs);
  }

  /** Drops in-flight client sockets. It must never touch the terminal process itself. */
  close(): void {
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }

  async #discover(): Promise<DiscoveredSession[]> {
    if (this.#closed) return [];
    const discovered = await Promise.all(this.#dirs.map((dir) => this.#discoverDir(dir)));
    return discovered.flat();
  }

  async #discoverDir(dir: string): Promise<DiscoveredSession[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      this.#logger(`terminal bridge directory ${dir} is unavailable: ${describe(error)}`);
      return [];
    }

    const candidates = names
      .filter((name) => name.startsWith(SOCKET_FILE_PREFIX) && name.endsWith(SOCKET_FILE_SUFFIX))
      .sort()
      .slice(0, MAX_SOCKETS_PER_LIST);

    const settled = await Promise.all(candidates.map((name) => this.#discoverOne(join(dir, name))));
    return settled.filter((entry): entry is DiscoveredSession => entry !== null);
  }

  async #discoverOne(socketPath: string): Promise<DiscoveredSession | null> {
    if (!isPrivateSocket(socketPath)) return null;
    try {
      const data = await this.#call(socketPath, { op: "list" }, this.#probeTimeoutMs);
      const meta = parseSessionMeta(firstSession(data));
      if (!meta) return null;
      if (!(await this.#withinWorkspace(meta.cwd))) {
        this.#logger(`ignoring terminal bridge socket ${socketPath}: cwd is outside the workspace`);
        return null;
      }
      return { meta, socketPath };
    } catch (error) {
      this.#logger(`ignoring terminal bridge socket ${socketPath}: ${describe(error)}`);
      return null;
    }
  }

  async #resolve(sessionId: string): Promise<DiscoveredSession> {
    if (this.#closed) {
      throw new TerminalBridgeError("internal_error", "terminal bridge client is closed");
    }
    const discovered = await this.#discover();
    const entry = discovered.find((candidate) => candidate.meta.sessionId === sessionId);
    if (!entry) {
      throw new TerminalBridgeError("unknown_session", `No live terminal session "${sessionId}"`);
    }
    return entry;
  }

  async #withinWorkspace(cwd: string): Promise<boolean> {
    try {
      const root = await this.#resolvedRoot();
      const realCwd = await realpath(cwd);
      const rel = relative(root, realCwd);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    } catch {
      return false;
    }
  }

  async #resolvedRoot(): Promise<string> {
    if (this.#realRoot === null) {
      this.#realRoot = await realpath(this.#workspaceRoot).catch(() => this.#workspaceRoot);
    }
    return this.#realRoot;
  }

  #call(socketPath: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new TerminalBridgeError("internal_error", "terminal bridge client is closed"));
    }

    return new Promise<unknown>((resolveCall, rejectCall) => {
      const socket = createConnection(socketPath);
      this.#sockets.add(socket);
      // StringDecoder-backed decoding so a multi-byte character split across two chunks is never
      // mangled into replacement characters before JSON.parse sees it.
      socket.setEncoding("utf8");
      const requestId = randomUUID();
      let buffer = "";
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (error: Error | null, data?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.destroy();
        if (error) rejectCall(error);
        else resolveCall(data);
      };

      timer = setTimeout(() => {
        finish(new TerminalBridgeError("timeout", `terminal bridge ${String(payload.op)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();

      socket.on("close", () => {
        this.#sockets.delete(socket);
        if (!settled) {
          finish(new TerminalBridgeError("unknown_session", `terminal bridge closed before answering ${String(payload.op)}`));
        }
      });
      socket.on("error", (error) => finish(toBridgeError(error)));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_RESPONSE_BYTES) {
          finish(new TerminalBridgeError("internal_error", "terminal bridge response exceeded the size limit"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        let data: unknown;
        try {
          data = parseResponseLine(buffer.slice(0, newline), requestId, payload);
        } catch (error) {
          finish(toBridgeError(error));
          return;
        }
        finish(null, data);
      });
      socket.on("connect", () => {
        try {
          socket.write(`${JSON.stringify({ id: requestId, ...payload })}\n`);
        } catch (error) {
          finish(toBridgeError(error));
        }
      });
    });
  }
}

function parseResponseLine(line: string, requestId: string, payload: Record<string, unknown>): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new TerminalBridgeError("internal_error", "terminal bridge sent a non-JSON response");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TerminalBridgeError("internal_error", "terminal bridge sent an invalid response");
  }
  const record = parsed as Record<string, unknown>;
  if (record.id !== requestId) {
    throw new TerminalBridgeError("internal_error", `terminal bridge response id mismatch for ${String(payload.op)}`);
  }
  if (record.ok === true) return record.data;
  const error = typeof record.error === "object" && record.error !== null ? (record.error as Record<string, unknown>) : {};
  const message = typeof error.message === "string" ? error.message : `terminal bridge rejected ${String(payload.op)}`;
  throw new TerminalBridgeError(mapServerCode(error.code), message);
}

function mapServerCode(code: unknown): RelayErrorCode {
  switch (code) {
    case "session_busy":
      return "session_busy";
    case "stale_session":
    case "session_not_found":
    case "not_found":
      return "unknown_session";
    case "invalid_request":
      return "invalid_frame";
    case "unsupported_op":
      return "not_implemented";
    case "timeout":
      return "timeout";
    case "not_ready":
      return "unknown_session";
    default:
      return "internal_error";
  }
}

function toBridgeError(error: unknown): TerminalBridgeError {
  if (error instanceof TerminalBridgeError) return error;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
      return new TerminalBridgeError("unknown_session", `terminal bridge is not reachable: ${error.message}`);
    }
    return new TerminalBridgeError("internal_error", error.message);
  }
  return new TerminalBridgeError("internal_error", String(error));
}

function isPrivateSocket(socketPath: string): boolean {
  try {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) return false;
    const uid = process.getuid?.();
    return uid === undefined || stat.uid === uid;
  } catch {
    return false;
  }
}

function firstSession(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  const sessions = (data as Record<string, unknown>).sessions;
  return Array.isArray(sessions) ? sessions[0] : undefined;
}

function parseSessionMeta(value: unknown): TerminalSessionMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" && record.sessionId.length > 0 ? record.sessionId : undefined;
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : undefined;
  if (!sessionId || !isTerminalSessionId(sessionId) || !cwd) return null;
  const title = typeof record.title === "string" && record.title.trim().length > 0 ? record.title : sessionId;
  const launchId = typeof record.launchId === "string" && /^[0-9a-f-]{36}$/.test(record.launchId) ? record.launchId : undefined;
  return { sessionId, title, cwd, activity: parseActivity(record.activity), ...(launchId ? { launchId } : {}) };
}

function parseSnapshot(value: unknown): TerminalSessionSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
  if (!Array.isArray(record.messages)) return null;
  const messages: TerminalSnapshotMessage[] = [];
  for (const entry of record.messages) {
    if (typeof entry !== "object" || entry === null) continue;
    const message = entry as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.text !== "string") continue;
    messages.push({ role: message.role, text: message.text });
  }
  return {
    sessionId: record.sessionId,
    activity: parseActivity(record.activity),
    messages,
    truncated: record.truncated === true,
  };
}

function parseActivity(value: unknown): TerminalActivity {
  return value === "busy" || value === "idle" ? value : "unknown";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
