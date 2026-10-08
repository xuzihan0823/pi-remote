import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { PiProcessManager, SessionProcessStatus } from "../pi/process-manager.ts";
import { relayError, type RelayErrorCode } from "../protocol/relay-types.ts";
import type { GatewayEvent, UiDialogResponse } from "../protocol/types.ts";
import {
  TerminalBridgeError,
  isTerminalSessionId,
  type TerminalSessionBridge,
  type TerminalSessionMeta,
} from "../terminal/bridge-client.ts";
import type { AgentHandlerResult, AgentRequestHandler } from "./agent-client.ts";
import type { TerminalSessionLauncher } from "../terminal/launcher.ts";
import { HISTORY_PREFIX, type OmpHistoryIndex } from "../history/history-index.ts";
import { HistoryReadError } from "../history/omp-reader.ts";
import { publicModel, publicModels, readModelSelection, TimelineRequestError, type ModelSelection, type RemoteModel } from "../terminal/extension.ts";
import type { HistoryRecoveryCoordinator } from "../terminal/history-recovery.ts";
import { browseProjectDirectory, existingProjects, resolveProjectDirectory } from "../projects.ts";
import type { ModelCatalog } from "../pi/model-catalog.ts";
import { resolveTerminalCwd } from "../terminal/launcher.ts";

export interface PiAgentHandlerOptions {
  manager: PiProcessManager;
  workspaceRoot: string;
  terminalBridge?: TerminalSessionBridge;
  terminalLauncher?: Pick<TerminalSessionLauncher, "start"> & Partial<Pick<TerminalSessionLauncher, "resume">>;
  history?: OmpHistoryIndex;
  recovery?: HistoryRecoveryCoordinator;
  runtime?: "omp" | "pi";
  modelCatalog?: ModelCatalog;
  emitSessionEvent?: (sessionId: string, event: GatewayEvent) => void;
  logger?: (message: string) => void;
}

/**
 * Bridges relay requests to a local PiProcessManager. The returned handler never starts a
 * session on its own: a process is spawned only when a client sends `session.start`.
 * Every GatewayEvent the manager produces is forwarded through `emitSessionEvent` so the
 * caller can relay streaming state, while request responses only acknowledge what was queued.
 */
export function createPiAgentHandler(options: PiAgentHandlerOptions): AgentRequestHandler {
  const { manager, workspaceRoot, terminalBridge } = options;
  const logger = options.logger ?? (() => {});
  const emitSessionEvent = options.emitSessionEvent ?? (() => {});
  const changingModels = new Set<string>();

  const getModel = async (id: string): Promise<{ sessionId: string; model: RemoteModel | null }> => {
    if (isTerminalSessionId(id)) {
      if (!terminalBridge) throw new HandlerError("unknown_session", "终端连接不可用");
      return terminalBridge.getModel(id);
    }
    const state = await manager.send<{ model?: unknown }>(id, { type: "get_state" });
    return { sessionId: id, model: publicModel(state?.model) };
  };

  const setModel = async (id: string, selection: ModelSelection): Promise<{ sessionId: string; model: RemoteModel }> => {
    if (changingModels.has(id)) throw new HandlerError("session_busy", "模型正在切换，请稍后重试");
    changingModels.add(id);
    try {
      if (isTerminalSessionId(id)) {
        if (!terminalBridge) throw new HandlerError("unknown_session", "终端连接不可用");
        const meta = await terminalBridge.get(id);
        if (await options.history?.hasConflict(meta)) throw new HandlerError("invalid_frame", "会话存在冲突副本，已禁止控制");
        if (meta.canControl === false || options.recovery && !await options.recovery.canControl(meta)) throw new HandlerError("session_busy", "会话尚未通过恢复验证，已禁止控制");
        return await terminalBridge.setModel(id, selection);
      }
      const client = manager.get(id);
      if (!client) throw new HandlerError("unknown_session", "会话已关闭，请刷新列表");
      const ensureIdle = async (): Promise<void> => {
        if (manager.get(id) !== client) throw new HandlerError("unknown_session", "会话已变化，请刷新列表");
        if (manager.isBusy(id)) throw new HandlerError("session_busy", "请等待当前任务完成再切换模型");
        const state = await client.send<{ isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number }>({ type: "get_state" });
        if (manager.get(id) !== client) throw new HandlerError("unknown_session", "会话已变化，请刷新列表");
        if (manager.isBusy(id) || state?.isStreaming || state?.isCompacting || (state?.pendingMessageCount ?? 0) > 0) {
          throw new HandlerError("session_busy", "请等待当前任务完成再切换模型");
        }
      };
      await ensureIdle();
      const available = await client.send<{ models?: unknown }>({ type: "get_available_models" });
      if (!publicModels(available?.models).some(model => model.provider === selection.provider && model.modelId === selection.modelId)) {
        throw new HandlerError("invalid_frame", "所选模型不可用，请刷新模型列表");
      }
      await ensureIdle();
      await client.send({ type: "set_model", provider: selection.provider, modelId: selection.modelId });
      const state = await client.send<{ model?: unknown }>({ type: "get_state" });
      const model = publicModel(state?.model);
      if (manager.get(id) !== client) throw new HandlerError("unknown_session", "会话已变化，请刷新列表");
      if (!model || model.provider !== selection.provider || model.modelId !== selection.modelId) {
        throw new HandlerError("internal_error", "模型未按预期生效，请重新读取状态");
      }
      return { sessionId: id, model };
    } finally { changingModels.delete(id); }
  };

  const startModelResult = async (id: string, selection: ModelSelection | undefined): Promise<Record<string, unknown>> => {
    if (!selection) return {};
    try {
      const { model } = await setModel(id, selection);
      return { modelSelection: { applied: true, model } };
    } catch (error) {
      return { modelSelection: { applied: false, model: null, error: modelError(error).error } };
    }
  };

  manager.onEvent((event) => {
    emitSessionEvent(event.sessionId, event);
  });

  const listSessions = async (): Promise<Record<string, unknown>[]> => {
    const sessions: Record<string, unknown>[] = manager.list().map(toManagedSessionEntry);
    if (!terminalBridge) return sessions;

    let terminalSessions: TerminalSessionMeta[];
    try {
      await options.recovery?.reconcile();
      terminalSessions = await terminalBridge.list();
    } catch (error) {
      logger(`terminal session list failed: ${error instanceof Error ? error.message : String(error)}`);
      return sessions;
    }

    const seen = new Set(sessions.map((entry) => entry.sessionId));
    for (const session of terminalSessions) {
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      // A terminal entry exists only while its bridge socket answers, so it is by definition running.
      const { persistedSessionFile: _file, processId: _pid, instanceId: _instance, launchId: _launch, ...publicSession } = session;
      const canControl = session.canControl !== false && (!options.recovery || await options.recovery.canControl(session));
      sessions.push({ ...publicSession, canControl, source: "terminal", state: "running", ...(!canControl ? { error: "会话尚未通过恢复验证或存在冲突，已禁止控制" } : {}) });
    }
    return sessions;
  };

  return async (request) => {
    const method = request.payload.method;
    const params = request.payload.params ?? {};
    const sessionId = nonEmptyString(request.sessionId) ?? stringParam(params, "sessionId");
    logger(`handling ${method}${sessionId ? ` for session "${sessionId}"` : ""}`);

    try {
      if (sessionId?.startsWith(HISTORY_PREFIX) && method !== "session.get") {
        throw new HandlerError("invalid_frame", "历史会话仅供阅读，不允许启动、发送、停止或回应确认");
      }
      if (sessionId && isTerminalSessionId(sessionId) && ["session.prompt", "session.abort", "ui.response"].includes(method)) {
        if (!terminalBridge) throw new HandlerError("unknown_session", "终端连接不可用");
        const meta = await terminalBridge.get(sessionId);
        if (await options.history?.hasConflict(meta)) throw new HandlerError("invalid_frame", "会话存在冲突副本，已禁止控制");
        if (meta.canControl === false || options.recovery && !await options.recovery.canControl(meta)) throw new HandlerError("session_busy", "会话尚未通过恢复验证，已禁止控制");
      }
      switch (method) {
        case "session.list": {
          if (params.projectView === "directory") {
            try {
              return { ok: true, data: await browseProjectDirectory(workspaceRoot, params.path, params.offset ?? 0) };
            } catch (error) {
              throw new HandlerError("invalid_frame", error instanceof Error ? error.message : "目录不可读取");
            }
          }
          if (params.projectView === "recent") {
            const live = await listSessions();
            const historyPaths = await options.history?.projectDirectories() ?? [];
            const paths = live.flatMap(session => typeof session.cwd === "string" ? [session.cwd] : []);
            return { ok: true, data: { projects: await existingProjects([...paths, ...historyPaths]),
              home: homedir(), defaultDirectory: workspaceRoot } };
          }
          if (params.projectView !== undefined) throw new HandlerError("invalid_frame", "项目列表参数无效");
          const live = await listSessions();
          if (params.viewVersion === 2) {
            for (const session of live) {
              session.availability = "live";
              session.canControl = session.canControl !== false && !(await options.history?.hasConflict(session));
              if (!session.canControl) session.error = "会话存在冲突副本，已禁止控制";
            }
          }
          const capabilities = { timelineV2: true, ompArchiveRead: Boolean(options.history), historyPagination: true, toolDetails: true,
            historyResume: options.runtime === "omp" && Boolean(options.history && options.terminalLauncher?.resume),
            historyRecoveryOperations: options.runtime === "omp" && Boolean(options.recovery), projectSelection: true,
            modelSelection: true, modelCatalog: Boolean(options.modelCatalog) };
          if (params.viewVersion !== 2 || params.includeArchived !== true || !options.history) {
            return { ok: true, data: { sessions: live, capabilities } };
          }
          const archived = await options.history.list(params, live);
          return { ok: true, data: { ...archived, capabilities } };
        }

        case "model.list": {
          if (sessionId) {
            if (params.cwd !== undefined || params.historySessionId !== undefined || params.mode !== undefined) throw new HandlerError("invalid_frame", "会话模型列表不能同时指定新建参数");
            if (isTerminalSessionId(sessionId)) {
              if (!terminalBridge) throw new HandlerError("unknown_session", "终端连接不可用");
              return { ok: true, data: await terminalBridge.models(sessionId) };
            }
            const available = await manager.send<{ models?: unknown }>(sessionId, { type: "get_available_models" });
            return { ok: true, data: { ...await getModel(sessionId), models: publicModels(available?.models) } };
          }
          if (!options.modelCatalog) throw new HandlerError("not_implemented", "此 Mac 助手未配置模型目录");
          const mode = params.mode ?? "terminal";
          if (mode !== "terminal" && mode !== "rpc") throw new HandlerError("invalid_frame", "mode 需要 terminal 或 rpc");
          let models: RemoteModel[];
          if (params.historySessionId !== undefined) {
            if (typeof params.historySessionId !== "string" || !params.historySessionId.startsWith(HISTORY_PREFIX) || params.cwd !== undefined || mode !== "terminal") {
              throw new HandlerError("invalid_frame", "历史模型查询需要有效历史引用，不能指定目录或后台模式");
            }
            if (!options.history || options.runtime !== "omp") throw new HandlerError("not_implemented", "历史模型查询仅支持 OMP");
            models = await options.history.resume(params.historySessionId, async target => {
              const result = await options.modelCatalog!(target.cwd, "terminal");
              await target.verify();
              return result;
            });
          } else {
            const cwd = await resolveTerminalCwd(workspaceRoot, params.cwd);
            models = await options.modelCatalog(cwd, mode);
          }
          return { ok: true, data: { models: publicModels(models) } };
        }

        case "session.get_model":
          if (!sessionId) throw new HandlerError("invalid_frame", "session.get_model requires sessionId");
          return { ok: true, data: await getModel(sessionId) };

        case "session.set_model": {
          if (!sessionId) throw new HandlerError("invalid_frame", "session.set_model requires sessionId");
          const selection = readModelSelection(params.model);
          if (!selection) throw new HandlerError("invalid_frame", "model 需要有效的 provider 和 modelId");
          return { ok: true, data: await setModel(sessionId, selection) };
        }

        case "session.get": {
          if (!sessionId) throw new HandlerError("invalid_frame", "session.get requires sessionId");
          if (sessionId.startsWith(HISTORY_PREFIX)) {
            if (!options.history) throw new HandlerError("not_implemented", "OMP 历史阅读不可用");
            return { ok: true, data: await options.history.get(sessionId, params) };
          }
          if (terminalBridge && isTerminalSessionId(sessionId)) {
            const data = params.viewVersion === 2 ? await terminalBridge.view(sessionId, params) : await terminalBridge.snapshot(sessionId);
            const meta = await terminalBridge.get(sessionId);
            if (await options.history?.hasConflict(meta) || options.recovery && !await options.recovery.canControl(meta)) {
              return { ok: true, data: { ...data, canControl: false } };
            }
            return { ok: true, data };
          }
          return {
            ok: false,
            error: relayError(
              "not_implemented",
              "session.get is only implemented for terminal sessions; managed sessions have no history API",
            ),
          };
        }

        case "session.start": {
          const selection = params.model === undefined ? undefined : readModelSelection(params.model);
          if (selection === null) throw new HandlerError("invalid_frame", "model 需要有效的 provider 和 modelId");
          const mode = params.mode === undefined ? "rpc" : params.mode;
          if (mode !== "rpc" && mode !== "terminal") throw new HandlerError("invalid_frame", "params.mode must be terminal or rpc");
          if (params.historySessionId !== undefined && mode !== "terminal") throw new HandlerError("invalid_frame", "历史恢复仅支持终端模式");
          if (mode === "terminal") {
            if (params.args !== undefined) throw new HandlerError("invalid_frame", "terminal mode does not accept remote args");
            if (sessionId) throw new HandlerError("invalid_frame", "terminal mode creates a new session and does not accept sessionId");
            if (!options.terminalLauncher) throw new HandlerError("not_implemented", "terminal session creation is unavailable");
            if (params.operationId !== undefined && params.historySessionId === undefined) {
              if (!options.recovery || params.recoveryVersion !== 1 || typeof params.operationId !== "string" || params.cwd !== undefined) throw new HandlerError("invalid_frame", "恢复查询参数无效");
              return { ok: true, data: await options.recovery.query(params.operationId, selection) };
            }
            let session: TerminalSessionMeta;
            if (params.historySessionId !== undefined) {
              if (typeof params.historySessionId !== "string" || !params.historySessionId.startsWith(HISTORY_PREFIX) || params.cwd !== undefined) {
                throw new HandlerError("invalid_frame", "历史恢复需要有效的历史引用，不能指定工作目录");
              }
              if (options.runtime !== "omp" || !options.history || !options.terminalLauncher.resume) throw new HandlerError("not_implemented", "请更新 Mac 助手并选择 OMP 以继续历史会话");
              if (options.recovery) {
                const operation = await options.recovery.start(params.historySessionId, params.operationId, params.retry === true || params.recoveryVersion !== 1, selection);
                if (params.recoveryVersion === 1) return { ok: true, data: operation };
                const result = await options.recovery.wait(operation.operationId as string);
                if (result.recoveryState !== "ready") throw new HandlerError("session_busy", result.message as string ?? "恢复结果尚未确认，请检查 Mac 后刷新");
                return { ok: true, data: result };
              }
              session = await options.history.resume(params.historySessionId, target => options.terminalLauncher!.resume!(target));
            } else {
              session = await options.terminalLauncher.start(params.cwd);
            }
            const { persistedSessionFile: _file, processId: _pid, instanceId: _instance, launchId: _launch, ...status } = session;
            const modelResult = await startModelResult(session.sessionId, selection);
            return { ok: true, data: { sessionId: session.sessionId, source: "terminal", status: { ...status, source: "terminal", state: "running", availability: "live", canControl: true }, ...modelResult } };
          }
          if (sessionId && isTerminalSessionId(sessionId)) throw new HandlerError("invalid_frame", "RPC mode cannot create or resume a terminal session");
          const startedId = sessionId ?? randomUUID();
          const cwd = await resolveWorkspaceCwd(workspaceRoot, params.cwd);
          const args = stringArrayParam(params, "args");
          const status = await manager.start(startedId, { cwd, ...(args ? { args } : {}) });
          return { ok: true, data: { sessionId: startedId, source: "managed", status, ...await startModelResult(startedId, selection) } };
        }

        case "session.prompt": {
          if (!sessionId) throw new HandlerError("invalid_frame", "session.prompt requires sessionId");
          if (changingModels.has(sessionId)) throw new HandlerError("session_busy", "模型正在切换，请等待确认后发送");
          const message = stringParam(params, "message");
          if (!message) throw new HandlerError("invalid_frame", "session.prompt requires a non-empty message");
          if (terminalBridge && isTerminalSessionId(sessionId)) {
            await terminalBridge.prompt(sessionId, message);
            return { ok: true, data: { sessionId, queued: true } };
          }
          await manager.prompt(sessionId, message, Array.isArray(params.images) ? { images: params.images } : {});
          return { ok: true, data: { sessionId, queued: true } };
        }

        case "session.abort": {
          if (!sessionId) throw new HandlerError("invalid_frame", "session.abort requires sessionId");
          if (terminalBridge && isTerminalSessionId(sessionId)) {
            await terminalBridge.abort(sessionId);
            return { ok: true, data: { sessionId, aborted: true } };
          }
          await manager.abort(sessionId);
          return { ok: true, data: { sessionId, aborted: true } };
        }

        case "ui.response": {
          if (!sessionId) throw new HandlerError("invalid_frame", "ui.response requires sessionId");
          const requestId = stringParam(params, "requestId");
          if (!requestId) throw new HandlerError("invalid_frame", "ui.response requires a non-empty requestId");
          if (terminalBridge && isTerminalSessionId(sessionId)) {
            return {
              ok: false,
              error: relayError(
                "not_implemented",
                "extension UI prompts for terminal sessions must be answered in the Mac terminal",
              ),
            };
          }
          const client = manager.get(sessionId);
          if (!client) throw new HandlerError("unknown_session", `No pi process for session "${sessionId}"`);
          client.respondToUi(requestId, asDialogResponse(params.response));
          return { ok: true, data: { sessionId, requestId } };
        }

        default:
          return {
            ok: false,
            error: relayError("not_implemented", `Method "${method}" is not implemented by the agent`),
          };
      }
    } catch (error) {
      if (["model.list", "session.get_model", "session.set_model"].includes(method)) return modelError(error);
      if ((sessionId?.startsWith(HISTORY_PREFIX) || params.historySessionId !== undefined) &&
        !(error instanceof HistoryReadError || error instanceof TimelineRequestError || error instanceof HandlerError || error instanceof TerminalBridgeError)) {
        return { ok: false, error: relayError("invalid_frame", "历史暂不可恢复或读取，请刷新或检查本机目录权限") };
      }
      return toHandlerError(error);
    }
  };
}

function modelError(error: unknown): AgentHandlerResult {
  if (error instanceof HandlerError || error instanceof TerminalBridgeError || error instanceof HistoryReadError || error instanceof TimelineRequestError) return toHandlerError(error);
  if ((error as { code?: string } | null)?.code === "session_not_found") return { ok: false, error: relayError("unknown_session", "会话已关闭，请刷新列表") };
  return { ok: false, error: relayError("internal_error", "模型操作失败，请检查 Mac 上的模型配置并重新读取状态") };
}

class HandlerError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = "HandlerError";
    this.code = code;
  }
}

function toHandlerError(error: unknown): AgentHandlerResult {
  if (error instanceof TimelineRequestError || error instanceof HistoryReadError) {
    return { ok: false, error: relayError("invalid_frame", error.message) };
  }
  if (error instanceof TerminalBridgeError) {
    return { ok: false, error: relayError(error.code, error.message) };
  }
  if (error instanceof HandlerError) {
    return { ok: false, error: relayError(error.code, error.message) };
  }

  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;

  switch (code) {
    case "session_not_found":
      return { ok: false, error: relayError("unknown_session", message) };
    case "session_busy":
    case "session_already_running":
      return { ok: false, error: relayError("session_busy", message) };
    default:
      return { ok: false, error: relayError("internal_error", message) };
  }
}

function toManagedSessionEntry(status: SessionProcessStatus): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    ...status,
    source: "managed",
    title: status.title ?? status.sessionId,
    activity: status.state === "running" && status.busy ? "busy" : "idle",
  };
  if (status.cwd) entry.cwd = status.cwd;
  return entry;
}

async function resolveWorkspaceCwd(defaultDirectory: string, requested: unknown): Promise<string> {
  try {
    return await resolveProjectDirectory(defaultDirectory, requested);
  } catch (error) {
    throw new HandlerError("invalid_frame", error instanceof Error ? error.message : "项目目录不可用");
  }
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function asDialogResponse(value: unknown): UiDialogResponse {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const response: UiDialogResponse = {};
  if (typeof record.value === "string") response.value = record.value;
  if (typeof record.confirmed === "boolean") response.confirmed = record.confirmed;
  if (typeof record.cancelled === "boolean") response.cancelled = record.cancelled;
  return response;
}
