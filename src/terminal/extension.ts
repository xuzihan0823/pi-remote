// pi-remote terminal bridge extension.
//
// This file is self-contained on purpose: the install script copies it to
// `~/.pi/agent/extensions/pi-remote-bridge/index.ts` (or `~/.omp/agent/...`) and each
// runtime loads it directly, so it must not import anything beyond Node builtins. The pi/omp
// extension API is described below with the minimal structural subset this bridge uses; no runtime
// or build-time dependency on either package is required.
//
// The bridge only ever runs inside an interactive TUI session. It reads the live session state
// from the current extension context and forwards prompts/aborts to the very same process, so a
// remote client never becomes a second writer on a session.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Session ids served by this bridge are always prefixed with this value. */
const SESSION_PREFIX = "terminal:";
/** Overrides the bridge directory. The Node agent side reads the same variable. */
const BRIDGE_DIR_ENV = "PI_REMOTE_BRIDGE_DIR";
const SOCKET_FILE_PREFIX = "b-";
const SOCKET_FILE_SUFFIX = ".sock";
const DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_MESSAGES = 100;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 80;

interface TextBlock {
  type?: string;
  text?: string;
}

interface PiMessage {
  role?: string;
  content?: unknown;
}

interface PiSessionEntry {
  type?: string;
  message?: PiMessage;
}

interface PiSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
  getBranch(fromId?: string): PiSessionEntry[];
}

interface PiUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface PiContext {
  hasUI: boolean;
  mode: string;
  /** OMP exposes this identity; older Pi contexts omit it. */
  agent?: { kind: "main" | "sub" };
  cwd: string;
  sessionManager: PiSessionManager;
  ui: PiUi;
  isIdle(): boolean;
  abort(): void;
}

interface PiEvent {
  type: string;
  message?: PiMessage;
}

type PiHandler = (event: PiEvent, ctx: PiContext) => void | Promise<void>;

interface PiApi {
  on(event: string, handler: PiHandler): void;
  sendUserMessage(content: string): void;
}

interface SessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  activity: "busy" | "idle";
  launchId?: string;
}

interface SnapshotMessage {
  role: "user" | "assistant";
  text: string;
}

interface SnapshotData {
  sessionId: string;
  activity: "busy" | "idle";
  messages: SnapshotMessage[];
  truncated: boolean;
}

type ResponseBody = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

interface BridgeRegistry {
  registeredApis: WeakSet<object>;
  owners: Map<string, object>;
}
const BRIDGE_REGISTRY_KEY = Symbol.for("pi-remote.terminalBridge.v1");
// Both the globally installed copy and the explicitly loaded copy share only our own state.
const registryHost = globalThis as typeof globalThis & { [BRIDGE_REGISTRY_KEY]?: BridgeRegistry };
const registry = registryHost[BRIDGE_REGISTRY_KEY] ??= { registeredApis: new WeakSet<object>(), owners: new Map<string, object>() };

export default function piRemoteBridge(pi: PiApi): void {
  if (registry.registeredApis.has(pi)) return;
  registry.registeredApis.add(pi);
  const instance = {};
  let leasedSessionId: string | null = null;
  let duplicate = false;
  let latestContext: PiContext | null = null;
  let server: Server | null = null;
  let socketPath: string | null = null;
  let partialAssistant = "";
  let warned = false;
  const clientSockets = new Set<Socket>();
  // Binding to the exec'd PID prevents inherited launch metadata from exposing child agents.
  const launchOwner = process.env.PI_REMOTE_LAUNCH_PID;
  const launchId = process.env.PI_REMOTE_LAUNCH_ID;
  const ownsLaunch = launchOwner === undefined || launchOwner === String(process.pid);
  let initialSessionId: string | null = null;
  let launchSessionReplaced = false;

  function isUserTerminal(ctx: PiContext): boolean {
    if (duplicate || ctx.mode !== "tui" || !ctx.hasUI || ctx.agent?.kind === "sub" || !ownsLaunch) return false;
    let id: string;
    try { id = ctx.sessionManager.getSessionId(); }
    catch { return false; }
    if (typeof id !== "string" || !id) return false;
    const owner = registry.owners.get(id);
    if (owner && owner !== instance) {
      // Once identified as a second copy, stay suppressed across /new and shutdown/restart.
      duplicate = true;
      return false;
    }
    if (leasedSessionId !== null && leasedSessionId !== id && registry.owners.get(leasedSessionId) === instance) {
      registry.owners.delete(leasedSessionId);
    }
    registry.owners.set(id, instance);
    leasedSessionId = id;
    return true;
  }

  function currentSessionId(): string | null {
    const ctx = latestContext;
    if (!ctx) return null;
    try {
      const id = ctx.sessionManager.getSessionId();
      return typeof id === "string" && id.length > 0 ? `${SESSION_PREFIX}${id}` : null;
    } catch {
      return null;
    }
  }

  function currentActivity(): "busy" | "idle" {
    const ctx = latestContext;
    if (!ctx) return "idle";
    try {
      return ctx.isIdle() ? "idle" : "busy";
    } catch {
      return "idle";
    }
  }

  function currentTitle(): string {
    const ctx = latestContext;
    if (!ctx) return "";
    try {
      const name = ctx.sessionManager.getSessionName();
      if (typeof name === "string" && name.trim().length > 0) return truncateTitle(name);
    } catch {
      // fall through to the last user text
    }
    const lastUserText = findLastUserText(ctx);
    if (lastUserText) return truncateTitle(lastUserText);
    return currentSessionId() ?? "";
  }

  function reportError(error: unknown): void {
    if (warned) return;
    warned = true;
    try {
      latestContext?.ui.notify(`pi-remote bridge: ${describe(error)}`, "warning");
    } catch {
      // notification is best-effort only
    }
  }

  function stopBridge(): void {
    if (leasedSessionId !== null && registry.owners.get(leasedSessionId) === instance) registry.owners.delete(leasedSessionId);
    leasedSessionId = null;
    const existing = server;
    const path = socketPath;
    server = null;
    socketPath = null;
    if (existing) {
      try {
        existing.close();
      } catch {
        // already closed
      }
    }
    if (path) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
    for (const socket of clientSockets) {
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    }
    clientSockets.clear();
  }

  function startBridge(ctx: PiContext): void {
    // Only the user's interactive terminal gets a bridge. RPC mode reports hasUI too, but the
    // agent already manages those processes, so exposing them again would duplicate sessions.
    if (!isUserTerminal(ctx)) return;
    if (server) return;

    const dir = bridgeDir();
    try {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      chmodSync(dir, DIR_MODE);
    } catch (error) {
      reportError(error);
      return;
    }

    const path = join(dir, `${SOCKET_FILE_PREFIX}${randomBytes(8).toString("hex")}${SOCKET_FILE_SUFFIX}`);
    const created = createServer((socket) => handleConnection(socket));
    created.on("error", (error) => {
      reportError(error);
      stopBridge();
    });
    created.listen(path, () => {
      try {
        chmodSync(path, SOCKET_MODE);
      } catch (error) {
        reportError(error);
        stopBridge();
      }
    });
    server = created;
    socketPath = path;
  }

  function handleConnection(socket: Socket): void {
    clientSockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("close", () => clientSockets.delete(socket));
    socket.on("error", () => {
      clientSockets.delete(socket);
      socket.destroy();
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        writeResponse(socket, { id: null, ok: false, error: { code: "invalid_request", message: "request exceeded the size limit" } });
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void handleLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
  }

  async function handleLine(socket: Socket, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeResponse(socket, { id: null, ok: false, error: { code: "invalid_request", message: "request is not valid JSON" } });
      return;
    }
    const request = asRecord(parsed);
    const id = request && typeof request.id === "string" ? request.id : null;
    const body = await buildResponse(request);
    writeResponse(socket, id === null ? body : { id, ...body });
  }

  async function buildResponse(request: Record<string, unknown> | null): Promise<ResponseBody> {
    if (!request) return failure("invalid_request", "request must be a JSON object");
    const ctx = latestContext;
    if (!ctx) return failure("not_ready", "the pi session is not ready yet");
    const sessionId = currentSessionId();
    if (!sessionId) return failure("not_ready", "the current session id is unavailable");

    const requested = typeof request.sessionId === "string" && request.sessionId.length > 0 ? request.sessionId : undefined;
    if (requested !== undefined && requested !== sessionId) {
      return failure("stale_session", `request targets "${requested}" but the current session is "${sessionId}"`);
    }
    // Control operations must name the target session explicitly; a request bound to a replaced id
    // is rejected above instead of silently acting on whatever session is current now.
    if (requested === undefined && (request.op === "prompt" || request.op === "abort")) {
      return failure("invalid_request", `${request.op} requires an explicit sessionId`);
    }

    try {
      switch (request.op) {
        case "list":
          return success({ sessions: [sessionMeta(ctx, sessionId)] });
        case "get":
          return success(sessionMeta(ctx, sessionId));
        case "snapshot":
          return success(buildSnapshot(ctx, sessionId));
        case "prompt": {
          const message = request.message;
          if (typeof message !== "string" || message.trim().length === 0) {
            return failure("invalid_request", "prompt requires a non-empty message");
          }
          if (!ctx.isIdle()) {
            return failure("session_busy", "the terminal session is busy; wait for the current turn to settle");
          }
          pi.sendUserMessage(message);
          return success({ sessionId, queued: true });
        }
        case "abort":
          ctx.abort();
          return success({ sessionId, aborted: true });
        default:
          return failure("unsupported_op", `unsupported op ${JSON.stringify(request.op)}`);
      }
    } catch (error) {
      return failure("internal_error", describe(error));
    }
  }

  function sessionMeta(ctx: PiContext, sessionId: string): SessionMeta {
    if (sessionId !== initialSessionId) launchSessionReplaced = true;
    return {
      sessionId, cwd: ctx.cwd, title: currentTitle(), activity: currentActivity(),
      ...(!launchSessionReplaced && launchId && /^[0-9a-f-]{36}$/.test(launchId) && sessionId === initialSessionId ? { launchId } : {}),
    };
  }

  function buildSnapshot(ctx: PiContext, sessionId: string): SnapshotData {
    const history: SnapshotMessage[] = [];
    let branch: PiSessionEntry[];
    try {
      branch = ctx.sessionManager.getBranch() ?? [];
    } catch {
      branch = [];
    }
    for (const entry of branch) {
      if (!entry || entry.type !== "message" || !entry.message) continue;
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractText(entry.message.content);
      if (text.length === 0) continue;
      history.push({ role, text });
    }
    if (partialAssistant.trim().length > 0) history.push({ role: "assistant", text: partialAssistant });
    const limited = limitMessages(history);
    return { sessionId, activity: currentActivity(), messages: limited.messages, truncated: limited.truncated };
  }

  pi.on("session_start", (_event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    partialAssistant = "";
    const sessionId = currentSessionId();
    if (initialSessionId !== null && sessionId !== initialSessionId) launchSessionReplaced = true;
    initialSessionId ??= sessionId;
    startBridge(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    stopBridge();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    partialAssistant = "";
  });

  pi.on("message_update", (event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    if (event.message?.role === "assistant") partialAssistant = extractText(event.message.content);
  });

  // The assistant message is persisted right after this handler returns, so clearing the partial
  // here keeps snapshots from ever repeating the same streaming text.
  pi.on("message_end", (event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    if (event.message?.role === "assistant") partialAssistant = "";
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    partialAssistant = "";
  });
}

function bridgeDir(): string {
  const override = process.env[BRIDGE_DIR_ENV];
  if (override !== undefined && override.trim().length > 0) return override.trim();
  const runtime = basename(process.execPath) === "omp" || process.argv.some((arg) => arg.includes("omp-darwin") || arg.includes("omp-linux")) ? ".omp" : ".pi";
  return join(homedir(), runtime, "agent", "pi-remote-bridge");
}

function findLastUserText(ctx: PiContext): string | null {
  try {
    const branch = ctx.sessionManager.getBranch() ?? [];
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "user") continue;
      const text = extractText(entry.message.content).replace(/\s+/g, " ").trim();
      if (text.length > 0) return text;
    }
  } catch {
    // treat unreadable history as empty
  }
  return null;
}

/** Only text blocks become message text; thinking and tool calls are deliberately excluded. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const candidate = block as TextBlock;
    if (candidate.type === "text" && typeof candidate.text === "string") text += candidate.text;
  }
  return text;
}

function limitMessages(messages: SnapshotMessage[]): { messages: SnapshotMessage[]; truncated: boolean } {
  let truncated = false;
  let kept = messages;
  if (kept.length > MAX_MESSAGES) {
    kept = kept.slice(kept.length - MAX_MESSAGES);
    truncated = true;
  }

  let totalBytes = 0;
  for (const message of kept) totalBytes += byteLength(message.text);
  let start = 0;
  while (start < kept.length - 1 && totalBytes > MAX_TEXT_BYTES) {
    totalBytes -= byteLength(kept[start]!.text);
    start += 1;
    truncated = true;
  }
  if (totalBytes > MAX_TEXT_BYTES) {
    const last = kept[start]!;
    return { messages: [{ role: last.role, text: truncateBytes(last.text, MAX_TEXT_BYTES) }], truncated: true };
  }
  return { messages: kept.slice(start), truncated };
}

function truncateTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TITLE_LENGTH ? collapsed.slice(0, MAX_TITLE_LENGTH) : collapsed;
}

function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  return buffer.length <= maxBytes ? text : buffer.subarray(0, maxBytes).toString("utf8");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function writeResponse(socket: Socket, body: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify(body)}\n`);
  } catch {
    // the peer went away
  }
}

function success(data: unknown): ResponseBody {
  return { ok: true, data };
}

function failure(code: string, message: string): ResponseBody {
  return { ok: false, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
