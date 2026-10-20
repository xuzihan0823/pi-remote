import { createHash, createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { AgentRequestHandler } from "./agent-client.ts";
import { relayError } from "../protocol/relay-types.ts";
import { readModelSelection, safeText, TimelineRequestError } from "../terminal/extension.ts";
import { DesktopTimeline } from "../desktop/timeline.ts";
import { currentDesktopModel, listDesktopModels, readDesktopPermission, type RemoteModel } from "../desktop/models.ts";
import {
  DesktopInteractionError,
  readDesktopInteractions,
  resolveDesktopInteraction,
} from "../desktop/interactions.ts";
import type { DesktopUiResponse } from "../protocol/types.ts";

export const DESKTOP_SESSION_PREFIX = "managed:desktop:";
export interface DesktopControlClient {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

const CONTROL_OPERATIONS = {
  providersList: "providers/list",
  providersListModels: "providers/listModels",
  sessionCreate: "session/create",
  sessionSetModel: "session/setModel",
  pendingInteractions: "agent/pendingInteractive",
  resolvePermission: "tool/resolvePermission",
  resolveQuestion: "agent/askTool/resolve",
} as const;

const MAX_DESCRIBED_OPERATIONS = 1024;

export const desktopCapabilities = {
  sessionScope: "pi-desktop", desktopSessions: true, sessionCreation: true,
  timelineV2: true, timelineAnchors: true, ompArchiveRead: false,
  historyPagination: true, toolDetails: true, historyResume: false,
  historyRecoveryOperations: false, projectSelection: true, projectDirectoryBrowsing: false,
  modelSelection: false, modelCatalog: false, modelSelectionOnCreate: false,
  sessionControls: true, remoteApprovals: false,
};

function describeCapabilities(operations: ReadonlySet<string> | null) {
  const catalog = operations?.has(CONTROL_OPERATIONS.providersList) === true &&
    operations.has(CONTROL_OPERATIONS.providersListModels);
  return {
    ...desktopCapabilities,
    modelCatalog: catalog,
    modelSelectionOnCreate: catalog && operations?.has(CONTROL_OPERATIONS.sessionCreate) === true,
    modelSelection: catalog && operations?.has(CONTROL_OPERATIONS.sessionSetModel) === true,
    sessionControls: true,
    remoteApprovals: operations?.has(CONTROL_OPERATIONS.pendingInteractions) === true &&
      operations.has(CONTROL_OPERATIONS.resolvePermission) &&
      operations.has(CONTROL_OPERATIONS.resolveQuestion),
  };
}

async function describeOperations(client: DesktopControlClient): Promise<Set<string>> {
  const raw = await client.call("pi_control_describe");
  if (!Array.isArray(raw)) throw new Error("Pi Desktop 控制目录无效");
  if (raw.length > MAX_DESCRIBED_OPERATIONS) throw new Error("Pi Desktop 控制目录超过读取上限");
  const operations = new Set<string>();
  for (const value of raw) {
    const operation = record(value);
    if (typeof operation.id !== "string" || operation.id.length === 0 || operation.id.length > 256) {
      throw new Error("Pi Desktop 控制目录包含无效操作");
    }
    operations.add(operation.id);
  }
  return operations;
}

function assertParams(params: Record<string, unknown>, allowed: readonly string[], message: string): void {
  if (Object.keys(params).some(key => !allowed.includes(key))) throw new ScopeError(message);
}

function strictModelSelection(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = value as Record<string, unknown>;
  if (Object.keys(model).some(key => key !== "provider" && key !== "modelId")) return null;
  return readModelSelection(model);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi Desktop 返回的数据格式无效");
  return value as Record<string, unknown>;
}

function desktopSession(value: unknown): Record<string, unknown> {
  const session = record(value);
  if (typeof session.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session.id) ||
    session.source !== undefined && session.source !== "desktop" || session.remoteHostKey !== undefined) {
    throw new ScopeError("此会话不属于本机 Pi Desktop，已禁止访问");
  }
  return session;
}

function nativeSessionId(publicId: unknown): string {
  if (typeof publicId !== "string" || !publicId.startsWith(DESKTOP_SESSION_PREFIX)) throw new ScopeError("仅支持 Pi Desktop 会话，请刷新会话列表");
  const id = publicId.slice(DESKTOP_SESSION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ScopeError("Pi Desktop 会话引用无效");
  return id;
}

function publicSession(session: Record<string, unknown>, status?: Record<string, unknown>): Record<string, unknown> {
  const permissions = session.capabilities && typeof session.capabilities === "object" ? session.capabilities as Record<string, unknown> : {};
  const busy = status?.isRunning === true;
  const cwd = typeof session.projectPath === "string" ? session.projectPath : undefined;
  return {
    sessionId: `${DESKTOP_SESSION_PREFIX}${session.id}`, title: safeText(typeof session.title === "string" ? session.title : "Pi Desktop 会话").slice(0, 160),
    source: "managed", runtime: "pi-desktop", historyOrigin: "pi-desktop", state: "running",
    availability: "live", canControl: permissions.canPrompt !== false,
    activity: status ? busy ? "busy" : "idle" : "unknown",
    ...(cwd ? { cwd, project: safeText(basename(cwd)) } : {}),
    startedAt: typeof session.updatedAt === "string" ? session.updatedAt : session.createdAt,
    hasPendingApproval: typeof status?.pendingToolConfirmations === "number" && status.pendingToolConfirmations > 0,
  };
}

function desktopResultTooLarge(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "result_too_large");
}

function safeTooLargeMessage(): string {
  return "Pi Desktop 返回内容过大，暂时无法读取，请稍后在 Pi Desktop 查看";
}

class ScopeError extends Error {}
class CapabilityError extends Error {}

export function createDesktopAgentHandler(options: { client: DesktopControlClient; workspaceRoot: string }): AgentRequestHandler {
  const { client, workspaceRoot } = options;
  const timeline = new DesktopTimeline(client);
  const secret = randomBytes(32);
  const mutations = new Set<string>();
  const getSession = async (id: string): Promise<Record<string, unknown>> => {
    const result = record(await client.call("pi_session_get", { id, messageLimit: 1, contentLimit: 256 }));
    const session = desktopSession(result.session);
    if (session.id !== id) throw new ScopeError("Pi Desktop 会话身份已变化，请刷新");
    return session;
  };
  const findSession = async (id: string): Promise<Record<string, unknown>> => {
    const result = record(await client.call("pi_session_list"));
    if (!Array.isArray(result.sessions)) throw new Error("Pi Desktop 会话列表无效");
    for (const value of result.sessions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      if (candidate.id === id) return desktopSession(candidate);
    }
    throw new ScopeError("Pi Desktop 会话不存在，请刷新会话列表");
  };
  const probeOperations = async (): Promise<Set<string> | null> => {
    try { return await describeOperations(client); } catch { return null; }
  };
  const requiredOperations = async (message: string): Promise<Set<string>> => {
    try { return await describeOperations(client); } catch (error) {
      throw new CapabilityError(`${message}：${error instanceof Error ? error.message : "控制目录不可用"}`);
    }
  };
  const catalogModels = async (operations: ReadonlySet<string>): Promise<RemoteModel[]> => {
    if (!operations.has(CONTROL_OPERATIONS.providersList) || !operations.has(CONTROL_OPERATIONS.providersListModels)) {
      throw new CapabilityError("当前 Pi Desktop 版本不支持模型目录，请更新桌面端");
    }
    return listDesktopModels(client);
  };
  const statusFor = async (id: string): Promise<Record<string, unknown>> => {
    const response = record(await client.call("pi_agent_status", { sessionId: id }));
    const status = record(response.status);
    if (status.sessionId !== id || typeof status.isRunning !== "boolean") throw new Error("Pi Desktop 运行状态无效，请刷新后重试");
    return status;
  };
  const cursorFor = (offset: number, revision: string): string => {
    const body = Buffer.from(JSON.stringify({ offset, revision })).toString("base64url");
    return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };

  return async request => {
    const method = request.payload.method;
    const params = request.payload.params ?? {};
    const requestedSessionId: unknown = request.sessionId ?? params.sessionId;
    try {
      if (requestedSessionId !== undefined && typeof requestedSessionId !== "string") throw new ScopeError("会话引用无效");
      const sessionId: string | undefined = requestedSessionId;
      if (request.sessionId !== undefined && params.sessionId !== undefined && request.sessionId !== params.sessionId) throw new ScopeError("会话参数不一致");
      const id = sessionId === undefined ? undefined : nativeSessionId(sessionId);
      if (method === "session.list") {
        if (sessionId !== undefined) throw new ScopeError("会话列表不接受会话引用");
        if (params.projectView === "directory") return { ok: false, error: relayError("not_implemented", "当前仅支持选择 Pi Desktop 已有项目，请先在桌面端打开项目") };
        if (params.projectView === "recent") {
          const response = record(await client.call("pi_project_list"));
          const projects = Array.isArray(response.projects) ? response.projects.flatMap(value => {
            const project = record(value);
            const path = typeof project.path === "string" ? project.path : typeof project.projectPath === "string" ? project.projectPath : undefined;
            return path ? [{ path, name: safeText(typeof project.name === "string" ? project.name : basename(path)) }] : [];
          }) : [];
          return { ok: true, data: { projects, home: homedir(), defaultDirectory: workspaceRoot } };
        }
        if (params.projectView !== undefined) throw new ScopeError("项目查询参数无效");
        const operations = await probeOperations();
        const capabilities = describeCapabilities(operations);
        const result = record(await client.call("pi_session_list"));
        if (!Array.isArray(result.sessions)) throw new Error("Pi Desktop 会话列表无效");
        const sessions = result.sessions.flatMap(value => {
          try { const session = desktopSession(value); return session.scheduledRun === true ? [] : [session]; }
          catch (error) { if (error instanceof ScopeError) return []; throw error; }
        }).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || String(a.id).localeCompare(String(b.id)));
        if (sessions.length > 10_000) throw new Error("Pi Desktop 会话数量超过读取上限");
        const revision = createHash("sha256").update(JSON.stringify(sessions.map(session => session.id))).digest("hex");
        let offset = 0;
        if (params.cursor != null) {
          if (typeof params.cursor !== "string" || params.cursor.length > 2048) throw new ScopeError("会话分页引用无效");
          const [body, signature] = params.cursor.split(".");
          if (!body || signature !== createHmac("sha256", secret).update(body).digest("base64url")) throw new ScopeError("会话分页引用无效");
          const cursor = record(JSON.parse(Buffer.from(body, "base64url").toString()));
          if (cursor.revision !== revision || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > sessions.length) throw new ScopeError("会话列表已变化，请刷新");
          offset = Number(cursor.offset);
        }
        const limit = typeof params.limit === "number" && Number.isSafeInteger(params.limit) ? Math.max(1, Math.min(50, params.limit)) : 30;
        const page = sessions.slice(offset, offset + limit);
        const entries = await Promise.all(page.map(async session => {
          const nativeId = String(session.id);
          const publicId = `${DESKTOP_SESSION_PREFIX}${nativeId}`;
          let status: Record<string, unknown> | undefined;
          let entry: Record<string, unknown>;
          try {
            status = await statusFor(nativeId);
            entry = publicSession(session, status);
          } catch {
            entry = { ...publicSession(session), canControl: false, error: "无法确认 Pi Desktop 状态，请打开会话后重试" };
          }
          if (capabilities.remoteApprovals) {
            try {
              const pending = await readDesktopInteractions(client, nativeId, publicId);
              entry.hasPendingApproval = entry.hasPendingApproval === true || pending.length > 0;
              entry.pendingStateKnown = status !== undefined;
            } catch {
              entry.pendingStateKnown = false;
            }
          } else if (status === undefined || operations === null) {
            // A failed catalog probe cannot rule out remote questions, so status alone must not clear pending state.
            entry.pendingStateKnown = false;
          }
          return entry;
        }));
        return { ok: true, data: { sessions: entries, capabilities, indexState: "ready", warnings: [],
          nextCursor: offset + limit < sessions.length ? cursorFor(offset + limit, revision) : null } };
      }
      if (method === "session.start") {
        if (sessionId !== undefined || params.mode !== "desktop" || Object.keys(params).some(key => !["mode", "cwd", "model"].includes(key))) throw new ScopeError("只能新建 Pi Desktop 会话，不支持 CLI 参数或历史恢复");
        const selection = params.model === undefined ? undefined : strictModelSelection(params.model);
        if (params.model !== undefined && !selection) throw new ScopeError("model 需要有效的 provider 和 modelId");
        const input: Record<string, unknown> = {};
        if (params.cwd !== undefined) {
          if (typeof params.cwd !== "string" || !params.cwd.startsWith("/") || params.cwd.includes("\0") || params.cwd.length > 4096) throw new ScopeError("项目目录无效");
          const projects = record(await client.call("pi_project_list"));
          if (!Array.isArray(projects.projects) || !projects.projects.some(value => {
            const project = record(value); return (project.path ?? project.projectPath) === params.cwd;
          })) throw new ScopeError("请先在 Pi Desktop 中打开该项目，再从手机选择");
          input.projectPath = params.cwd;
        }
        let models: RemoteModel[] | undefined;
        if (selection) {
          const operations = await requiredOperations("Pi Desktop 模型目录不可用");
          models = await catalogModels(operations);
          if (!models.some(model => model.provider === selection.provider && model.modelId === selection.modelId)) {
            throw new ScopeError("所选模型不可用，请刷新模型列表");
          }
          input.providerId = selection.provider;
          input.modelId = selection.modelId;
        }
        const created = record(await client.call("pi_session_create", input));
        const session = desktopSession(created.session);
        let status: Record<string, unknown>;
        try { status = publicSession(session, await statusFor(String(session.id))); }
        catch { status = { ...publicSession(session), canControl: false, error: "会话已创建，暂时无法确认状态，请刷新后继续" }; }
        let modelSelection: Record<string, unknown> | undefined;
        if (selection) {
          try {
            const confirmed = await findSession(String(session.id));
            if (confirmed.providerId === selection.provider && confirmed.modelId === selection.modelId) {
              modelSelection = { applied: true, model: currentDesktopModel(confirmed, models) };
            } else {
              modelSelection = { applied: false, error: { message: "模型尚未确认生效，请重新读取状态" } };
            }
          } catch (error) {
            modelSelection = {
              applied: false,
              error: { message: safeText(error instanceof Error ? error.message : "模型尚未确认生效，请重新读取状态") },
            };
          }
        }
        return { ok: true, data: { sessionId: status.sessionId, source: "managed", status, ...(modelSelection ? { modelSelection } : {}) } };
      }
      if (method === "model.list") {
        if (id === undefined) {
          assertParams(params, ["mode", "cwd"], "模型目录参数无效");
          if (params.mode !== "desktop") throw new ScopeError("仅支持 Pi Desktop 模型目录");
          if (params.cwd !== undefined && (typeof params.cwd !== "string" || !params.cwd.startsWith("/") ||
            params.cwd.includes("\0") || params.cwd.length > 4096)) throw new ScopeError("项目目录无效");
          const models = await catalogModels(await requiredOperations("Pi Desktop 模型目录不可用"));
          return { ok: true, data: { models } };
        }
        assertParams(params, ["sessionId"], "会话模型列表参数无效");
        const models = await catalogModels(await requiredOperations("Pi Desktop 模型目录不可用"));
        const session = await getSession(id);
        return { ok: true, data: { models, model: currentDesktopModel(session, models) } };
      }
      if (id === undefined || sessionId === undefined) throw new ScopeError("此操作需要 Pi Desktop 会话引用");
      if (method === "session.get" && params.view === "controls") {
        const metadata = await findSession(id);
        const status = await statusFor(id);
        const permission = await readDesktopPermission(client, metadata);
        const operations = await requiredOperations("Pi Desktop 交互能力不可用");
        const interactionsSupported = describeCapabilities(operations).remoteApprovals;
        const pendingInteractions = interactionsSupported
          ? await readDesktopInteractions(client, id, sessionId)
          : [];
        const capabilitiesOfSession = metadata.capabilities && typeof metadata.capabilities === "object"
          ? metadata.capabilities as Record<string, unknown> : {};
        return { ok: true, data: {
          sessionId,
          permission,
          model: currentDesktopModel(metadata),
          pendingInteractions,
          interactionsSupported,
          canControl: capabilitiesOfSession.canPrompt !== false,
          activity: status.isRunning === true ? "busy" : "idle",
        } };
      }
      if (method === "session.get_model") {
        assertParams(params, ["sessionId"], "模型读取参数无效");
        const session = await getSession(id);
        return { ok: true, data: { sessionId, model: currentDesktopModel(session) } };
      }
      if (method === "session.set_model") {
        assertParams(params, ["sessionId", "model"], "模型切换参数无效");
        const selection = strictModelSelection(params.model);
        if (!selection) throw new ScopeError("model 需要有效的 provider 和 modelId");
        if (mutations.has(id)) return { ok: false, error: relayError("session_busy", "此会话的控制操作尚未完成，请稍后重试") };
        mutations.add(id);
        try {
          const models = await catalogModels(await requiredOperations("Pi Desktop 模型目录不可用"));
          if (!models.some(model => model.provider === selection.provider && model.modelId === selection.modelId)) {
            throw new ScopeError("所选模型不可用，请刷新模型列表");
          }
          await findSession(id);
          if ((await statusFor(id)).isRunning === true) return { ok: false, error: relayError("session_busy", "请等待当前任务完成再切换模型") };
          await client.call("pi_session_set_model", {
            id, providerId: selection.provider, modelId: selection.modelId, confirm: true,
          });
          const updated = await findSession(id);
          if (updated.providerId !== selection.provider || updated.modelId !== selection.modelId) {
            throw new Error("模型未按预期生效，请重新读取状态");
          }
          return { ok: true, data: { sessionId, model: currentDesktopModel(updated, models) } };
        } finally { mutations.delete(id); }
      }
      if (method === "ui.response") {
        assertParams(params, ["sessionId", "requestId", "response"], "交互响应参数无效");
        if (typeof params.requestId !== "string" || params.requestId.length === 0 || params.requestId.length > 512) {
          throw new ScopeError("requestId 无效");
        }
        if (!params.response || typeof params.response !== "object" || Array.isArray(params.response)) {
          throw new ScopeError("response 无效");
        }
        if (mutations.has(id)) return { ok: false, error: relayError("session_busy", "此会话的控制操作尚未完成，请稍后重试") };
        mutations.add(id);
        try {
          await findSession(id);
          let operations: Set<string>;
          try { operations = await describeOperations(client); } catch {
            throw new CapabilityError("Pi Desktop 控制目录不可用，暂不支持远程审批，请在 Mac 上处理");
          }
          if (!describeCapabilities(operations).remoteApprovals) {
            throw new CapabilityError("当前 Pi Desktop 版本不支持远程审批，请在 Mac 上处理");
          }
          await resolveDesktopInteraction(client, id, sessionId, params.requestId, params.response as DesktopUiResponse);
          return { ok: true, data: { sessionId, requestId: params.requestId, acknowledged: true } };
        } finally { mutations.delete(id); }
      }
      const session = await getSession(id);
      if (method === "session.get") {
        const status = await statusFor(id);
        const entry = publicSession(session, status);
        const capabilities = describeCapabilities(await probeOperations());
        return { ok: true, data: await timeline.get(id, sessionId, params, {
          activity: String(entry.activity), canControl: entry.canControl === true,
          warnings: capabilities.remoteApprovals ? [] : ["权限确认及选择请在 Mac 的 Pi Desktop 完成"],
        }) };
      }
      if (method === "session.prompt" || method === "session.abort") {
        if (mutations.has(id)) return { ok: false, error: relayError("session_busy", "此会话的控制操作尚未完成，请稍后重试") };
        mutations.add(id);
        try {
          const capabilities = session.capabilities && typeof session.capabilities === "object" ? session.capabilities as Record<string, unknown> : {};
          if (method === "session.prompt") {
            if (Object.keys(params).some(key => !["message", "sessionId"].includes(key)) || typeof params.message !== "string" || !params.message.trim() || Buffer.byteLength(params.message) > 256 * 1024) throw new ScopeError("仅支持非空的文字消息，暂不支持附件或 CLI 参数");
            if (capabilities.canPrompt === false) throw new ScopeError("Pi Desktop 当前不允许此会话接收消息");
            if ((await statusFor(id)).isRunning === true) return { ok: false, error: relayError("session_busy", "请等待当前任务完成后发送") };
            await client.call("pi_agent_prompt", { sessionId: id, content: params.message });
            return { ok: true, data: { sessionId, queued: true } };
          }
          if (Object.keys(params).some(key => key !== "sessionId")) throw new ScopeError("停止参数无效");
          if (capabilities.canStop === false) throw new ScopeError("Pi Desktop 当前不允许停止此会话");
          await client.call("pi_agent_abort", { sessionId: id });
          return { ok: true, data: { sessionId, aborted: true } };
        } finally { mutations.delete(id); }
      }
      return { ok: false, error: relayError("not_implemented", "此操作请在 Pi Desktop 中完成") };
    } catch (error) {
      if (error instanceof CapabilityError) return { ok: false, error: relayError("not_implemented", safeText(error.message)) };
      if (error instanceof DesktopInteractionError) {
        if (error.code === "not_found") return { ok: false, error: relayError("unknown_session", "Desktop 交互请求已失效，请刷新后重试") };
        if (error.code === "result_uncertain") {
          return { ok: false, error: relayError("internal_error", "无法确认 Desktop 是否已处理该交互，请刷新后核对") };
        }
        return { ok: false, error: relayError("invalid_frame", safeText(error.message)) };
      }
      if (error instanceof TimelineRequestError) return { ok: false, error: relayError(error.code,
        error.code === "result_too_large" ? safeTooLargeMessage() : safeText(error.message)) };
      if (desktopResultTooLarge(error)) return { ok: false, error: relayError("result_too_large", safeTooLargeMessage()) };
      if (error instanceof ScopeError) return { ok: false, error: relayError("invalid_frame", safeText(error.message)) };
      return { ok: false, error: relayError("internal_error", safeText(error instanceof Error ? error.message : "Pi Desktop 操作失败")) };
    }
  };
}
