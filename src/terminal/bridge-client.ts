import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RelayErrorCode } from "../protocol/relay-types.ts";
import { publicModel, publicModels, type ModelSelection, type RemoteModel, type TimelineItem } from "./extension.ts";
import { sessionRoots, within } from "../session-scope.ts";

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
  runtime?: "omp" | "pi";
  persistedSessionId?: string;
  persistedSessionFile?: string;
  processId?: number;
  instanceId?: string;
  canControl?: boolean;
  error?: string;
  source?: "terminal" | "managed";
  fileIdentity?: string;
  rewriteGeneration?: number;
  subagentModelIsolation?: boolean;
  capabilities?: { timelineV2: boolean; toolDetails: boolean; modelSelection?: boolean };
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
  viewVersion?: number;
  revision?: string;
  branchId?: string;
  availability?: string;
  canControl?: boolean;
  items?: TimelineItem[];
  page?: { hasMoreBefore: boolean; before: string | null };
  generation?: number;
  replacements?: Record<string, string>;
  warnings?: string[];
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
  readonly reason?: string;

  constructor(code: RelayErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "TerminalBridgeError";
    this.code = code;
    this.reason = reason;
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

  #controlGuard: ((meta: TerminalSessionMeta) => Promise<boolean>) | undefined;
  #closed = false;

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

  setControlGuard(guard: (meta: TerminalSessionMeta) => Promise<boolean>): void {
    this.#controlGuard = guard;
  }

  async instances(): Promise<TerminalSessionMeta[]> {
    return (await this.#discover()).map(entry => entry.meta);
  }

  async list(): Promise<TerminalSessionMeta[]> {
    const discovered = await this.instances();
    const metas: TerminalSessionMeta[] = [];
    for (const id of new Set(discovered.map(meta => meta.sessionId))) {
      const candidates = discovered.filter(meta => meta.sessionId === id);
      const meta = candidates[0]!;
      const authorized = await this.canControl(meta);
      const canControl = candidates.length === 1 && authorized;
      metas.push({ ...meta, canControl, ...(!canControl ? { error: "会话正在恢复或存在实例冲突，已禁止控制" } : {}) });
    }
    return metas;
  }

  async canControl(meta: TerminalSessionMeta): Promise<boolean> {
    return !this.#controlGuard || await this.#controlGuard(meta);
  }

  async get(sessionId: string): Promise<TerminalSessionMeta> {
    const entry = await this.#resolve(sessionId);
    return entry.meta;
  }


  async view(sessionId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entry = await this.#resolve(sessionId);
    if (!entry.meta.capabilities?.timelineV2) return { ...await this.snapshot(sessionId), canControl: true, availability: "live" };
    const data = await this.#call(entry.socketPath, { ...params, op: "snapshot", sessionId, viewVersion: 2 }, this.#requestTimeoutMs);
    if (!data || typeof data !== "object" || (data as Record<string, unknown>).sessionId !== sessionId) {
      throw new TerminalBridgeError("internal_error", "terminal bridge returned an invalid timeline");
    }
    return data as Record<string, unknown>;
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
    if (!await this.canControl(entry.meta)) throw new TerminalBridgeError("session_busy", "此实例尚未通过恢复验证，不能发送消息");
    await this.#call(entry.socketPath, { op: "prompt", sessionId, instanceId: entry.meta.instanceId, message }, this.#requestTimeoutMs);
  }

  async abort(sessionId: string): Promise<void> {
    const entry = await this.#resolve(sessionId);
    if (!await this.canControl(entry.meta)) throw new TerminalBridgeError("session_busy", "此实例尚未通过恢复验证，不能停止任务");
    await this.#call(entry.socketPath, { op: "abort", sessionId, instanceId: entry.meta.instanceId }, this.#requestTimeoutMs);
  }

  async models(sessionId: string): Promise<{ sessionId: string; models: RemoteModel[]; model: RemoteModel | null }> {
    const data = await this.#modelRequest(sessionId, "models");
    return { sessionId, models: publicModels(data.models), model: publicModel(data.model) };
  }

  async getModel(sessionId: string): Promise<{ sessionId: string; model: RemoteModel | null }> {
    const data = await this.#modelRequest(sessionId, "get_model");
    return { sessionId, model: publicModel(data.model) };
  }

  async setModel(sessionId: string, selection: ModelSelection): Promise<{ sessionId: string; model: RemoteModel }> {
    const data = await this.#modelRequest(sessionId, "set_model", selection);
    const model = publicModel(data.model);
    if (!model || model.provider !== selection.provider || model.modelId !== selection.modelId) {
      throw new TerminalBridgeError("internal_error", "终端未确认所选模型，请重新读取模型状态");
    }
    return { sessionId, model };
  }

  async #modelRequest(sessionId: string, op: string, model?: ModelSelection): Promise<Record<string, unknown>> {
    const entry = await this.#resolve(sessionId);
    if (op === "set_model" && !await this.canControl(entry.meta)) throw new TerminalBridgeError("session_busy", "此实例尚未通过恢复验证，不能切换模型");
    if (!entry.meta.capabilities?.modelSelection) throw new TerminalBridgeError("not_implemented", "请在 Mac 上更新桥接扩展并执行 /reload 以选择模型");
    const data = await this.#call(entry.socketPath, { op, sessionId, instanceId: entry.meta.instanceId, ...(model ? { model } : {}) }, Math.max(5_000, this.#requestTimeoutMs));
    if (!data || typeof data !== "object" || (data as Record<string, unknown>).sessionId !== sessionId) {
      throw new TerminalBridgeError("internal_error", "终端返回的模型会话不匹配");
    }
    return data as Record<string, unknown>;
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
      if (!(await this.#withinSessionRoots(meta.cwd))) {
        this.#logger(`ignoring terminal bridge socket ${socketPath}: cwd is outside the workspace and temporary directories`);
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
    const entries = discovered.filter(candidate => candidate.meta.sessionId === sessionId);
    if (!entries.length) throw new TerminalBridgeError("unknown_session", "终端会话已离线");
    if (entries.length !== 1) throw new TerminalBridgeError("session_busy", "同一会话存在多个终端实例，请在 Mac 上确认");
    return entries[0]!;
  }

  async #withinSessionRoots(cwd: string): Promise<boolean> {
    try {
      const roots = await sessionRoots(this.#workspaceRoot);
      const realCwd = await realpath(cwd);
      return roots.some(root => within(root, realCwd));
    } catch {
      return false;
    }
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
        if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
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
  return {
    sessionId, title, cwd, activity: parseActivity(record.activity), ...(launchId ? { launchId } : {}),
    ...(record.runtime === "omp" || record.runtime === "pi" ? { runtime: record.runtime } : {}),
    ...(typeof record.persistedSessionId === "string" ? { persistedSessionId: record.persistedSessionId } : {}),
    ...(typeof record.persistedSessionFile === "string" ? { persistedSessionFile: record.persistedSessionFile } : {}),
    ...(typeof record.processId === "number" && Number.isSafeInteger(record.processId) && record.processId > 0 ? { processId: record.processId } : {}),
    ...(typeof record.instanceId === "string" && /^[0-9a-f]{32}$/.test(record.instanceId) ? { instanceId: record.instanceId } : {}),
    ...(typeof record.capabilities === "object" && record.capabilities !== null ? {
      capabilities: {
        timelineV2: (record.capabilities as Record<string, unknown>).timelineV2 === true,
        toolDetails: (record.capabilities as Record<string, unknown>).toolDetails === true,
        ...((record.capabilities as Record<string, unknown>).modelSelection === true ? { modelSelection: true } : {}),
      },
    } : {}),
    ...(record.subagentModelIsolation === true ? { subagentModelIsolation: true } : {}),
  };
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
