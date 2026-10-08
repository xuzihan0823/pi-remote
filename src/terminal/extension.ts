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
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

export interface PiMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  stopReason?: string;
}

export interface PiSessionEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: PiMessage;
  summary?: string;
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
  hasPendingMessages?(): boolean;
  model?: unknown;
  models?: { list(): unknown[] | Promise<unknown[]>; current(): unknown };
  modelRegistry?: { getAvailable(): unknown[] | Promise<unknown[]> };
}

interface PiEvent {
  type: string;
  message?: PiMessage;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: boolean;
}

type PiHandler = (event: PiEvent, ctx: PiContext) => void | Promise<void>;

interface PiApi {
  on(event: string, handler: PiHandler): void;
  sendUserMessage(content: string): void;
  setModel?(model: unknown): Promise<boolean>;
}

export interface ModelSelection { provider: string; modelId: string }
export interface RemoteModel extends ModelSelection {
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export function readModelSelection(value: unknown): ModelSelection | null {
  const record = asRecord(value);
  const valid = (part: unknown, max: number): part is string =>
    typeof part === "string" && part.length > 0 && part.length <= max && !/[\s\x00-\x1f\x7f]/u.test(part);
  return record && valid(record.provider, 128) && valid(record.modelId, 512)
    ? { provider: record.provider, modelId: record.modelId } : null;
}

// Runtime model objects may contain credentials and headers. Only these fields cross the bridge.
export function publicModel(value: unknown): RemoteModel | null {
  const record = asRecord(value);
  if (!record) return null;
  const selection = readModelSelection({ provider: record.provider, modelId: record.id ?? record.modelId });
  if (!selection) return null;
  return {
    ...selection,
    name: typeof record.name === "string" ? record.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256) : selection.modelId,
    ...(typeof record.reasoning === "boolean" ? { reasoning: record.reasoning } : {}),
    ...(typeof record.contextWindow === "number" && Number.isSafeInteger(record.contextWindow) && record.contextWindow > 0
      ? { contextWindow: record.contextWindow } : {}),
  };
}

export function publicModels(values: unknown): RemoteModel[] {
  if (!Array.isArray(values)) throw new Error("模型列表格式无效");
  const models = new Map<string, RemoteModel>();
  for (const value of values) {
    const model = publicModel(value);
    if (model) models.set(JSON.stringify([model.provider, model.modelId]), model);
  }
  return [...models.values()];
}

interface SessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  activity: "busy" | "idle";
  launchId?: string;
  runtime?: "omp" | "pi";
  persistedSessionId?: string;
  persistedSessionFile?: string;
  processId?: number;
  instanceId: string;
  capabilities?: { timelineV2: boolean; toolDetails: boolean; modelSelection?: boolean };
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
  instanceId?: string;
}
const BRIDGE_REGISTRY_KEY = Symbol.for("pi-remote.terminalBridge.v1");
// Both the globally installed copy and the explicitly loaded copy share only our own state.
const registryHost = globalThis as typeof globalThis & { [BRIDGE_REGISTRY_KEY]?: BridgeRegistry };
const registry = registryHost[BRIDGE_REGISTRY_KEY] ??= { registeredApis: new WeakSet<object>(), owners: new Map<string, object>() };
const processInstanceId = registry.instanceId ??= randomBytes(16).toString("hex");

export default function piRemoteBridge(pi: PiApi): void {
  if (registry.registeredApis.has(pi)) return;
  registry.registeredApis.add(pi);
  const instance = { id: randomBytes(8).toString("hex") };
  let leasedSessionId: string | null = null;
  let duplicate = false;
  let latestContext: PiContext | null = null;
  let changingModel = false;
  let server: Server | null = null;
  let socketPath: string | null = null;
  let partialAssistant = "";
  let warned = false;
  let streaming: { id: string; message: PiMessage; final: boolean; baseIds: Set<string>; persistedId?: string } | null = null;
  let streamGeneration = 0;
  let streamOrdinal = 0;
  const toolStates = new Map<string, ToolStatus>();
  const viewService = new TimelineViewService();
  let branchIdentity = randomBytes(8).toString("hex");
  let previousLeaf: string | undefined;
  const stagedResults = new Map<string, PiSessionEntry>();
  const clientSockets = new Set<Socket>();
  // Binding to the exec'd PID prevents inherited launch metadata from exposing child agents.
  const launchOwner = process.env.PI_REMOTE_LAUNCH_PID;
  const launchId = process.env.PI_REMOTE_LAUNCH_ID;
  const ownsLaunch = launchOwner === undefined || launchOwner === String(process.pid);
  let initialSessionId: string | null = null;
  let launchSessionReplaced = false;
  const launchStatusPath = process.env.PI_REMOTE_LAUNCH_STATUS_PATH;

  function recordLaunchStage(stage: string, ctx?: PiContext): void {
    if (!launchStatusPath || !ownsLaunch || !launchId || !/^[0-9a-f-]{36}$/.test(launchId)) return;
    try {
      const path = `${launchStatusPath}.bridge.${instance.id}`;
      writeFileSync(`${path}.tmp`, JSON.stringify({ stage, launchId, instanceId: processInstanceId, extensionInstanceId: instance.id, processId: process.pid,
        mode: ctx?.mode === "tui" || ctx?.mode === "rpc" || ctx?.mode === "print" ? ctx.mode : "unknown", hasUI: ctx?.hasUI === true,
        ownsLease: leasedSessionId !== null && registry.owners.get(leasedSessionId) === instance, listening: server?.listening === true,
        agentKind: ctx?.agent?.kind === "main" || ctx?.agent?.kind === "sub" ? ctx.agent.kind : "unknown" }), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch {}
  }
  recordLaunchStage("extension_loaded");

  function isUserTerminal(ctx: PiContext): boolean {
    if (duplicate || ctx.mode !== "tui" || !ctx.hasUI || ctx.agent?.kind === "sub" || !ownsLaunch) {
      recordLaunchStage(duplicate ? "duplicate_extension" : "non_user_terminal", ctx);
      return false;
    }
    let id: string;
    try { id = ctx.sessionManager.getSessionId(); }
    catch { recordLaunchStage("session_identity_unavailable", ctx); return false; }
    if (typeof id !== "string" || !id) { recordLaunchStage("session_identity_unavailable", ctx); return false; }
    const owner = registry.owners.get(id);
    if (owner && owner !== instance) {
      // Once identified as a second copy, stay suppressed across /new and shutdown/restart.
      duplicate = true;
      recordLaunchStage("duplicate_extension", ctx);
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
    const socketLimit = process.platform === "darwin" ? 104 : 108;
    if (Buffer.byteLength(path) >= socketLimit) {
      recordLaunchStage("socket_path_too_long", ctx);
      reportError(new Error("bridge directory path exceeds the local socket length limit"));
      stopBridge();
      return;
    }
    const created = createServer((socket) => handleConnection(socket));
    created.on("error", (error) => {
      reportError(error);
      recordLaunchStage("bridge_bind_failed", ctx);
      stopBridge();
    });
    created.listen(path, () => {
      try {
        chmodSync(path, SOCKET_MODE);
        recordLaunchStage("bridge_ready", ctx);
      } catch (error) {
        reportError(error);
        recordLaunchStage("bridge_bind_failed", ctx);
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
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
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
    if (request.instanceId !== undefined && request.instanceId !== processInstanceId) {
      return failure("stale_session", "终端实例已变化，请重新连接");
    }
    // Control operations must name the target session explicitly; a request bound to a replaced id
    // is rejected above instead of silently acting on whatever session is current now.
    if (requested === undefined && ["prompt", "abort", "set_model", "get_model", "models"].includes(String(request.op))) {
      return failure("invalid_request", `${request.op} requires an explicit sessionId`);
    }

    try {
      switch (request.op) {
        case "list":
          return success({ sessions: [sessionMeta(ctx, sessionId)] });
        case "get":
          return success(sessionMeta(ctx, sessionId));
        case "snapshot":
          return success(request.viewVersion === 2 ? buildTimeline(ctx, sessionId, request) : buildSnapshot(ctx, sessionId));
        case "get_model":
          if (!supportsModels(ctx)) return failure("unsupported_op", "请更新终端运行时与桥接扩展以选择模型");
          return success({ sessionId, model: publicModel(currentModel(ctx)) });
        case "models": {
          if (!supportsModels(ctx)) return failure("unsupported_op", "请更新终端运行时与桥接扩展以选择模型");
          const models = publicModels(await availableModels(ctx));
          if (currentSessionId() !== sessionId) return failure("stale_session", "读取模型期间会话已切换");
          return success({ sessionId, models, model: publicModel(currentModel(ctx)) });
        }
        case "set_model": {
          const selection = readModelSelection(request.model);
          if (!selection) return failure("invalid_request", "model 需要有效的 provider 和 modelId");
          if (!supportsModels(ctx) || !pi.setModel) return failure("unsupported_op", "请更新终端运行时与桥接扩展以选择模型");
          if (changingModel || !ctx.isIdle() || ctx.hasPendingMessages?.()) return failure("session_busy", "请等待当前任务和模型切换完成");
          changingModel = true;
          try {
            const models = await availableModels(ctx);
            const selected = models.find(value => {
              const model = publicModel(value);
              return model?.provider === selection.provider && model.modelId === selection.modelId;
            });
            if (!selected) return failure("invalid_request", "所选模型不可用，请刷新模型列表");
            if (currentSessionId() !== sessionId) return failure("stale_session", "选择模型期间会话已切换");
            if (!ctx.isIdle() || ctx.hasPendingMessages?.()) return failure("session_busy", "请等待当前任务完成");
            if (!await pi.setModel(selected)) return failure("invalid_request", "所选模型未配置可用凭据");
            if (currentSessionId() !== sessionId) return failure("stale_session", "切换模型期间会话已切换，请重新读取状态");
            const model = publicModel(currentModel(ctx));
            if (model?.provider !== selection.provider || model.modelId !== selection.modelId) {
              return failure("internal_error", "模型未按预期生效，请重新读取状态");
            }
            return success({ sessionId, model });
          } catch {
            return failure("internal_error", "模型切换失败，请检查 Mac 上的模型配置并重新读取状态");
          } finally { changingModel = false; }
        }
        case "prompt": {
          const message = request.message;
          if (typeof message !== "string" || message.trim().length === 0) {
            return failure("invalid_request", "prompt requires a non-empty message");
          }
          if (changingModel || !ctx.isIdle()) {
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
      return failure("internal_error", ["models", "get_model"].includes(String(request.op)) ? "无法读取模型，请检查 Mac 上的模型配置" : describe(error));
    }
  }

  function supportsModels(ctx: PiContext): boolean {
    return typeof pi.setModel === "function" &&
      (typeof ctx.models?.list === "function" || typeof ctx.modelRegistry?.getAvailable === "function");
  }

  function availableModels(ctx: PiContext): Promise<unknown[]> {
    return Promise.resolve(ctx.models ? ctx.models.list() : ctx.modelRegistry!.getAvailable());
  }

  function currentModel(ctx: PiContext): unknown {
    return ctx.models ? ctx.models.current() : ctx.model;
  }

  function sessionMeta(ctx: PiContext, sessionId: string): SessionMeta {
    if (sessionId !== initialSessionId) launchSessionReplaced = true;
    return {
      sessionId, cwd: ctx.cwd, title: currentTitle(), activity: currentActivity(),
      runtime: runtimeName(), persistedSessionId: ctx.sessionManager.getSessionId(),
      persistedSessionFile: ctx.sessionManager.getSessionFile(),
      processId: process.pid,
      instanceId: processInstanceId,
      capabilities: { timelineV2: true, toolDetails: true, ...(supportsModels(ctx) ? { modelSelection: true } : {}) },
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

  function buildTimeline(ctx: PiContext, sessionId: string, request: Record<string, unknown>): Record<string, unknown> {
    const branch = ctx.sessionManager.getBranch() ?? [];
    if (previousLeaf && !branch.some(entry => entry.id === previousLeaf)) {
      branchIdentity = randomBytes(8).toString("hex");
      streamGeneration += 1;
      streaming = null;
      toolStates.clear();
      stagedResults.clear();
    }
    previousLeaf = branch.at(-1)?.id;
    const replacements: Record<string, string> = {};
    if (streaming) {
      const candidates = branch.filter(entry => entry.id && !streaming!.baseIds.has(entry.id) &&
        entry.type === "message" && entry.message?.role === "assistant");
      const committed = candidates.find(entry => entry.message === streaming!.message ||
        (typeof streaming!.message.timestamp === "number" && entry.message?.timestamp === streaming!.message.timestamp)) ??
        (streaming.final && candidates.length === 1 ? candidates[0] : undefined);
      if (committed?.id) {
        streaming.persistedId = committed.id;
        replacements[streaming.id] = committed.id;
      }
    }
    const entries = [...branch];
    if (streaming && !streaming.persistedId) entries.push({ type: "message", id: streaming.id, message: streaming.message });
    for (const [callId, result] of stagedResults) {
      if (branch.some(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === callId)) {
        stagedResults.delete(callId);
      } else {
        entries.push(result);
      }
    }
    const projection = projectTranscript(entries, { toolStates });
    const branchId = branchIdentity;
    const revision = createHash("sha256").update(`${branchIdentity}:${streamGeneration}:`).update(JSON.stringify(projection)).digest("hex");
    return viewService.respond({
      sessionId, branchId, revision, availability: "live", canControl: true,
      activity: currentActivity(), generation: streamGeneration, replacements,
    }, projection, request);
  }

  pi.on("session_start", (_event, ctx) => {
    recordLaunchStage("session_seen", ctx);
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    partialAssistant = "";
    streaming = null;
    streamGeneration += 1;
    toolStates.clear();
    stagedResults.clear();
    previousLeaf = undefined;
    branchIdentity = randomBytes(8).toString("hex");
    const sessionId = currentSessionId();
    if (initialSessionId !== null && sessionId !== initialSessionId) launchSessionReplaced = true;
    initialSessionId ??= sessionId;
    startBridge(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    recordLaunchStage("shutdown", ctx);
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    stopBridge();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    partialAssistant = "";
    streamGeneration += 1;
    streaming = null;
    toolStates.clear();
    stagedResults.clear();
  });


  pi.on("message_start", (event, ctx) => {
    if (!isUserTerminal(ctx) || event.message?.role !== "assistant") return;
    latestContext = ctx;
    streaming = {
      id: `stream:${streamGeneration}:${++streamOrdinal}`, message: event.message, final: false,
      baseIds: new Set(ctx.sessionManager.getBranch().flatMap(entry => entry.id ? [entry.id] : [])),
    };
  });
  pi.on("message_update", (event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    if (event.message?.role === "assistant") {
      partialAssistant = extractText(event.message.content);
      streaming ??= {
        id: `stream:${streamGeneration}:${++streamOrdinal}`, message: event.message, final: false,
        baseIds: new Set(ctx.sessionManager.getBranch().flatMap(entry => entry.id ? [entry.id] : [])),
      };
      streaming.message = event.message;
      const content = event.message.content;
      if (Array.isArray(content)) for (const raw of content) {
        const block = asRecord(raw);
        if (block?.type === "toolCall" && typeof block.id === "string" && !toolStates.has(block.id)) toolStates.set(block.id, "requested");
      }
    }
  });

  // The assistant message is persisted right after this handler returns, so clearing the partial
  // here keeps snapshots from ever repeating the same streaming text.
  pi.on("message_end", (event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    if (event.message?.role === "assistant") {
      partialAssistant = "";
      if (streaming) {
        streaming.message = event.message;
        streaming.final = true;
      }
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!isUserTerminal(ctx)) return;
    latestContext = ctx;
    partialAssistant = "";
  });

  for (const eventName of ["tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    pi.on(eventName, (event, ctx) => {
      if (!isUserTerminal(ctx) || !event.toolCallId) return;
      latestContext = ctx;
      if (eventName === "tool_execution_end") {
        const result = asRecord(event.result);
        if (result && (Array.isArray(result.content) || typeof result.content === "string")) {
          stagedResults.set(event.toolCallId, {
            type: "message", id: `stream:tool:${streamGeneration}:${event.toolCallId}`,
            message: { role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
              content: result.content, isError: event.isError === true },
          });
        } else {
          toolStates.set(event.toolCallId, "unknown");
        }
      } else {
        toolStates.set(event.toolCallId, "running");
      }
    });
  }
}

function bridgeDir(): string {
  const override = process.env[BRIDGE_DIR_ENV];
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return join(homedir(), runtimeName() === "omp" ? ".omp" : ".pi", "agent", "pi-remote-bridge");
}

function runtimeName(): "omp" | "pi" {
  return basename(process.execPath) === "omp" ||
    process.argv.some(arg => arg.includes("omp-darwin") || arg.includes("omp-linux")) ? "omp" : "pi";
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
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
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

export type ToolStatus = "requested" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface TimelineItem {
  id: string;
  kind: "message" | "toolCall" | "toolResult" | "boundary" | "unsupported";
  role?: "user" | "assistant";
  text?: string;
  name?: string;
  toolCallId?: string;
  status?: ToolStatus;
  preview?: string;
  detailId?: string;
  truncated?: boolean;
  sourceTruncated?: boolean;
  isError?: boolean;
}
export interface ProjectedTranscript {
  items: TimelineItem[];
  details: Record<string, { arguments?: string; result?: string; error?: string; sourceTruncated?: boolean }>;
  warnings: string[];
  offset?: number;
  total?: number;
}

export function safeText(text: string): string {
  return text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[已隐藏]")
    .replace(/([?&](?:token|key|secret|password|access_token)=)[^&#\s)]+/gi, "$1[已隐藏]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[凭据已隐藏]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[私钥已隐藏]");
}

function safeArguments(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[内容已隐藏]";
  if (typeof value === "string") return safeText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => safeArguments(item, depth + 1));
  const record = asRecord(value);
  if (!record) return "[未记录]";
  return Object.fromEntries(Object.entries(record).slice(0, 1000).map(([key, item]) => [
    safeText(key),
    /token|password|secret|credential|authorization|api.?key|signature|providerPayload|thinking/i.test(key)
      ? "[已隐藏]" : safeArguments(item, depth + 1),
  ]));
}

export function projectTranscript(
  entries: readonly PiSessionEntry[],
  options: { live?: boolean; toolStates?: ReadonlyMap<string, ToolStatus> } = {},
): ProjectedTranscript {
  const items: TimelineItem[] = [];
  const details: ProjectedTranscript["details"] = {};
  const warnings: string[] = [];
  const calls = new Map<string, TimelineItem[]>();
  const results = new Map<string, TimelineItem[]>();
  for (const [ordinal, entry] of entries.entries()) {
    const entryId = entry.id ?? `legacy:${ordinal}`;
    if (entry.type === "compaction" || entry.type === "reset_boundary" || entry.type === "branch_summary") {
      const id = `${entryId}:boundary`;
      const summary = typeof entry.summary === "string" ? safeText(entry.summary) : "";
      items.push({
        id, kind: "boundary", text: entry.type === "compaction" ? "上下文已压缩" :
          entry.type === "reset_boundary" ? "上下文已清空" : "分支摘要",
        ...(summary ? { preview: truncateBytes(summary, 1024), detailId: id } : {}),
      });
      if (summary) details[id] = { result: summary };
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] :
      Array.isArray(message.content) ? message.content : [];
    if (message.role === "toolResult") {
      const id = `${entryId}:block-0`;
      const result = safeText(extractText(message.content));
      const item: TimelineItem = {
        id, kind: "toolResult", toolCallId: message.toolCallId, name: safeText(message.toolName ?? "工具"),
        isError: message.isError === true, preview: truncateBytes(result || "未记录文字结果（附件未载入）", 1024),
        detailId: id, sourceTruncated: /(?:\[.{0,80}truncated.{0,80}\]|输出已截断)/i.test(result),
      };
      items.push(item);
      details[id] = { result, ...(message.isError ? { error: result } : {}), sourceTruncated: item.sourceTruncated };
      if (item.toolCallId) results.set(item.toolCallId, [...(results.get(item.toolCallId) ?? []), item]);
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    for (const [blockOrdinal, raw] of blocks.entries()) {
      const block = asRecord(raw);
      if (!block) continue;
      const id = `${entryId}:block-${blockOrdinal}`;
      if (block.type === "text" && typeof block.text === "string") {
        const text = safeText(block.text);
        if (!text) continue;
        const truncated = byteLength(text) > 4096;
        items.push({ id, kind: "message", role: message.role, text: truncateBytes(text, 4096),
          ...(truncated ? { truncated: true, detailId: id } : {}) });
        if (truncated) details[id] = { result: text };
      } else if (message.role === "assistant" && block.type === "toolCall" &&
        typeof block.id === "string" && typeof block.name === "string") {
        const args = block.arguments === undefined ? undefined : JSON.stringify(safeArguments(block.arguments), null, 2);
        const item: TimelineItem = {
          id, kind: "toolCall", name: truncateBytes(safeText(block.name), 100), toolCallId: block.id, detailId: id,
          status: options.toolStates?.get(block.id) ?? (options.live ? "requested" : "unknown"),
          preview: args ? truncateBytes(args, 256) : "未记录参数",
        };
        items.push(item);
        details[id] = { ...(args ? { arguments: args } : {}) };
        calls.set(block.id, [...(calls.get(block.id) ?? []), item]);
      } else if (!["thinking", "redactedThinking"].includes(String(block.type))) {
        items.push({ id, kind: "unsupported", text: "附件或未知内容未载入" });
      }
    }
  }
  for (const [callId, callItems] of calls) {
    const resultItems = results.get(callId) ?? [];
    if (callItems.length > 1 || resultItems.length > 1) {
      warnings.push("工具调用 ID 或结果冲突，未自动配对");
      for (const item of callItems) item.status = "unknown";
    } else if (resultItems[0]) {
      const call = callItems[0]!;
      const result = resultItems[0];
      call.status = result.isError ? "failed" : "succeeded";
      result.status = call.status;
      details[call.id] = { ...details[call.id], ...details[result.id] };
    }
  }
  for (const [callId, resultItems] of results) {
    if (!calls.has(callId)) for (const result of resultItems) result.status = "unknown";
  }
  return { items, details, warnings: [...new Set(warnings)] };
}

export interface TimelineContext {
  sessionId: string;
  branchId: string;
  revision: string;
  availability: "live" | "archived";
  canControl: boolean;
  activity?: string;
  generation?: number;
  replacements?: Record<string, string>;
}

export class TimelineRequestError extends Error {}

export class TimelineViewService {
  readonly #secret = randomBytes(32);

  #token(context: TimelineContext, value: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify({ ...value, expires: (Math.floor(Date.now() / 900_000) + 2) * 900_000,
      session: context.sessionId, branch: context.branchId, revision: context.revision, viewVersion: 2 })).toString("base64url");
    return `${body}.${createHmac("sha256", this.#secret).update(body).digest("base64url")}`;
  }

  #decode(context: TimelineContext, raw: unknown): Record<string, unknown> {
    if (typeof raw !== "string" || raw.length > 4096) throw new TimelineRequestError("无效的历史引用");
    const [body, signature] = raw.split(".");
    if (!body || !signature || createHmac("sha256", this.#secret).update(body).digest("base64url") !== signature) {
      throw new TimelineRequestError("无效的历史引用");
    }
    const value = asRecord(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!value || value.session !== context.sessionId || value.branch !== context.branchId ||
      value.revision !== context.revision || value.viewVersion !== 2 || Number(value.expires) < Date.now()) {
      throw new TimelineRequestError("历史已变化或引用过期，请刷新");
    }
    return value;
  }

  pageRange(context: TimelineContext, total: number, params: Record<string, unknown>): { start: number; end: number } {
    let end = total;
    if (params.before != null) {
      const cursor = this.#decode(context, params.before);
      if (cursor.kind !== "timeline") throw new TimelineRequestError("无效的时间线分页");
      end = Number(cursor.end);
    }
    if (!Number.isSafeInteger(end) || end < 0 || end > total) throw new TimelineRequestError("无效的时间线边界");
    const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 50;
    return { start: Math.max(0, end - limit), end };
  }

  detailItemId(context: TimelineContext, params: Record<string, unknown>): string {
    const reference = this.#decode(context, params.detailId);
    if (reference.kind !== "detail" || typeof reference.id !== "string") throw new TimelineRequestError("无效的详情引用");
    return reference.id;
  }

  respond(context: TimelineContext, projection: ProjectedTranscript, params: Record<string, unknown>): Record<string, unknown> {
    if (params.view === "tool") {
      if (params.revision !== context.revision) throw new TimelineRequestError("详情已变化，请刷新");
      const reference = this.#decode(context, params.detailId);
      if (reference.kind !== "detail" || typeof reference.id !== "string") throw new TimelineRequestError("无效的详情引用");
      const detail = projection.details[reference.id];
      if (!detail) throw new TimelineRequestError("详情未记录");
      const field = params.field === "arguments" || params.field === "error" ? params.field : "result";
      let offset = 0;
      if (params.cursor != null) {
        const cursor = this.#decode(context, params.cursor);
        if (cursor.kind !== "tool" || cursor.id !== reference.id || cursor.field !== field) throw new TimelineRequestError("无效的详情分页");
        offset = Number(cursor.offset);
      }
      const text = detail[field];
      if (text === undefined) return { ...context, field, recorded: false, totalBytes: 0, returnedBytes: 0 };
      const bytes = Buffer.from(text);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new TimelineRequestError("无效的详情偏移");
      const remaining = bytes.subarray(offset).toString("utf8");
      let budget = 60 * 1024;
      const makeDetail = (): Record<string, unknown> => {
        const value = truncateBytes(remaining, budget);
        const returnedBytes = byteLength(value);
        const hasMore = offset + returnedBytes < bytes.length;
        return {
          ...context, field, recorded: true, text: value, totalBytes: bytes.length, returnedBytes,
          truncated: hasMore, sourceTruncated: detail.sourceTruncated ?? false,
          nextCursor: hasMore ? this.#token(context, { kind: "tool", id: reference.id, field, offset: offset + returnedBytes }) : null,
        };
      };
      let response = makeDetail();
      while (byteLength(JSON.stringify(response)) > 64 * 1024 && budget > 1) {
        budget = Math.floor(budget * 0.75);
        response = makeDetail();
      }
      if (byteLength(JSON.stringify(response)) > 64 * 1024) throw new TimelineRequestError("详情元数据超过预算");
      return response;
    }
    if (params.view !== undefined && params.view !== "timeline") throw new TimelineRequestError("不支持的历史视图");
    const range = this.pageRange(context, projection.total ?? projection.items.length, params);
    const end = range.end;
    let start = range.start;
    const makePage = (): Record<string, unknown> => {
      const items = projection.items.slice(start - (projection.offset ?? 0), end - (projection.offset ?? 0)).map(item => ({
        ...item, ...(item.detailId ? { detailId: this.#token(context, { kind: "detail", id: item.detailId }) } : {}),
      }));
      const messages = items.flatMap(item => item.kind === "message" ? [{ role: item.role, text: item.text }] : []);
      return { ...context, viewVersion: 2, items, messages, truncated: items.some(item => item.truncated),
        warnings: projection.warnings.slice(0, 20),
        page: { hasMoreBefore: start > 0, before: start > 0 ? this.#token(context, { kind: "timeline", end: start }) : null } };
    };
    let page = makePage();
    while (byteLength(JSON.stringify(page)) > 256 * 1024 && start < end - 1) page = (start++, makePage());
    if (byteLength(JSON.stringify(page)) > 256 * 1024) throw new TimelineRequestError("时间线元数据超过预算");
    return page;
  }
}
