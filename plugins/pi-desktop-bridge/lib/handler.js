"use strict";

/**
 * Relay 请求 → PI-Desktop 控制目录操作。
 *
 * 协议与现有 pi Agent（src/agent/pi-agent-handler.ts）相同，手机端（ios/PiRemote/Services/RelayClient.swift）
 * 无需改动：Pi Desktop 会话以 terminal 来源出现（会话 ID 前缀 terminal:desktop:），手机按 Mac 共享会话处理——
 * 轮询 session.get 时间线、确认与选择提示“请在 Mac 终端完成”。
 *
 * 对应关系：
 *   session.list                  → session/list（+ agent/getStatus 取忙闲）；projectView=recent → project/list
 *   session.start (mode=terminal) → session/create（可带 projectPath、providerId/modelId）
 *   session.get (viewVersion 2)   → session/get 按消息窗口分页 + agent/getStatus
 *   session.prompt                → agent/prompt
 *   session.abort                 → agent/abort
 *   model.list / session.get_model → providers/list + providers/listModels（只读缓存）
 *   session.set_model / ui.response → 不支持（需要 dangerous 的 session/configure、tool/resolvePermission），请在 Mac 上处理
 */

const os = require("node:os");
const { CapabilityError } = require("./desktop.js");
const { TimelineService, TimelineError, pendingAskTool } = require("./timeline.js");
const { pendingSummary } = require("./watcher.js");
const { safeText, errorMessage, errorCode } = require("./text.js");

const SESSION_PREFIX = "terminal:desktop:";
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LISTED_SESSIONS = 100;
const DEFAULT_PAGE = 30;
const STATUS_CONCURRENCY = 8;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_PROVIDERS = 128;
const MAX_MODELS = 10_000;

class HandlerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HandlerError";
    this.code = code;
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function publicSessionId(nativeId) {
  return `${SESSION_PREFIX}${nativeId}`;
}

function nativeSessionId(publicId) {
  if (typeof publicId !== "string" || !publicId.startsWith(SESSION_PREFIX)) {
    throw new HandlerError("unknown_session", "仅支持 Pi Desktop 会话，请刷新会话列表");
  }
  const id = publicId.slice(SESSION_PREFIX.length);
  if (!NATIVE_ID.test(id)) throw new HandlerError("invalid_frame", "Pi Desktop 会话引用无效");
  return id;
}

/** 只认本机 Pi Desktop 自己的会话：排除 native-pi CLI 会话、远程主机会话与定时任务会话。 */
function isDesktopSession(session) {
  const record = asRecord(session);
  if (!record || typeof record.id !== "string" || !NATIVE_ID.test(record.id)) return false;
  if (record.source !== undefined && record.source !== "desktop") return false;
  if (record.remoteHostKey !== undefined || record.remoteWorkspace) return false;
  if (record.scheduledRun === true) return false;
  return true;
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function validText(value, max = 1024) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function readModelSelection(value) {
  const record = asRecord(value);
  if (!record) return null;
  if (Object.keys(record).some((key) => key !== "provider" && key !== "modelId")) return null;
  const valid = (part, max) => typeof part === "string" && part.length > 0 && part.length <= max && !/[\s\x00-\x1f\x7f]/u.test(part);
  return valid(record.provider, 128) && valid(record.modelId, 512) ? { provider: record.provider, modelId: record.modelId } : null;
}

function currentModel(session, models) {
  const provider = session?.providerId;
  const modelId = session?.modelId;
  if (!validText(provider) || !validText(modelId)) return null;
  return models?.find((model) => model.provider === provider && model.modelId === modelId) ?? { provider, modelId, name: modelId };
}

function basename(path) {
  const parts = String(path).split("/").filter(Boolean);
  return parts.at(-1) ?? String(path);
}

async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {{
 *   desktop: import("./desktop.js").DesktopGateway,
 *   watcher?: { track(nativeId: string, options?: { poke?: boolean }): void },
 *   timeline?: TimelineService,
 *   homeDir?: string,
 *   logger?: (message: string) => void,
 * }} options
 */
function createRequestHandler(options) {
  const desktop = options.desktop;
  const timeline = options.timeline ?? new TimelineService(desktop);
  const watcher = options.watcher ?? { track() {} };
  const homeDir = options.homeDir ?? os.homedir();
  const logger = options.logger ?? (() => {});
  const busy = new Set();

  const readStatus = async (nativeId) => {
    const response = asRecord(await desktop.invoke("agent/getStatus", [nativeId]));
    const status = asRecord(response?.status) ?? response;
    if (!status || typeof status.isRunning !== "boolean") throw new HandlerError("internal_error", "Pi Desktop 运行状态无效，请稍后重试");
    return status;
  };

  const listDesktopSessions = async () => {
    const result = asRecord(await desktop.invoke("session/list", []));
    const sessions = Array.isArray(result?.sessions) ? result.sessions : Array.isArray(result) ? result : null;
    if (!sessions) throw new HandlerError("internal_error", "Pi Desktop 会话列表格式无效");
    return sessions
      .filter(isDesktopSession)
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || String(a.id).localeCompare(String(b.id)));
  };

  const findSession = async (nativeId) => {
    const session = (await listDesktopSessions()).find((candidate) => candidate.id === nativeId);
    if (!session) throw new HandlerError("unknown_session", "Pi Desktop 会话不存在，请刷新会话列表");
    return session;
  };

  const sessionEntry = (session, status, statusError) => {
    const capabilities = asRecord(session.capabilities) ?? {};
    const cwd = typeof session.projectPath === "string" && session.projectPath ? session.projectPath : undefined;
    const startedAt = timestampMs(session.updatedAt) ?? timestampMs(session.createdAt);
    return {
      sessionId: publicSessionId(session.id),
      title: safeText(typeof session.title === "string" && session.title ? session.title : "Pi Desktop 会话").slice(0, 160),
      source: "terminal",
      runtime: "pi-desktop",
      state: "running",
      availability: "live",
      canControl: capabilities.canPrompt !== false,
      activity: status ? (status.isRunning ? "busy" : "idle") : "unknown",
      // 这个提示针对旧 OMP 终端的子 agent 模型隔离，不适用于 Pi Desktop。
      subagentModelIsolation: true,
      ...(cwd ? { cwd, project: safeText(basename(cwd)) } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(statusError ? { error: "无法读取 Pi Desktop 运行状态，请稍后刷新" } : {}),
    };
  };

  const capabilities = () => {
    const catalog = desktop.has("providers/list") && desktop.has("providers/listModels");
    return {
      sessionScope: "pi-desktop",
      timelineV2: true,
      timelineAnchors: false,
      ompArchiveRead: false,
      historyPagination: true,
      toolDetails: true,
      historyResume: false,
      historyRecoveryOperations: false,
      projectSelection: desktop.has("project/list"),
      sessionCreation: desktop.has("session/create"),
      modelSelection: catalog,
      modelCatalog: catalog,
      remoteApprovals: false,
    };
  };

  const listModels = async () => {
    const result = asRecord(await desktop.invoke("providers/list", []));
    const providers = Array.isArray(result?.providers) ? result.providers : [];
    const models = new Map();
    for (const value of providers.slice(0, MAX_PROVIDERS)) {
      const provider = asRecord(value);
      if (!provider || provider.enabled === false || !validText(provider.id, 128)) continue;
      let listed;
      try {
        listed = await desktop.invoke("providers/listModels", [{ providerId: provider.id, source: "cache" }]);
      } catch (error) {
        logger(`读取 ${provider.id} 的模型缓存失败：${errorMessage(error)}`);
        continue;
      }
      const entries = Array.isArray(asRecord(listed)?.models) ? listed.models : Array.isArray(listed) ? listed : [];
      for (const entry of entries) {
        const model = asRecord(entry);
        const modelId = model?.modelId ?? model?.id;
        if (!validText(modelId, 512)) continue;
        const key = JSON.stringify([provider.id, modelId]);
        if (models.has(key)) continue;
        const name = validText(model.displayName) ? model.displayName : validText(model.name) ? model.name : modelId;
        models.set(key, {
          provider: provider.id,
          modelId,
          name: safeText(name).slice(0, 256),
          ...(typeof model.contextWindow === "number" && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
            ? { contextWindow: model.contextWindow } : {}),
        });
        if (models.size >= MAX_MODELS) break;
      }
    }
    return [...models.values()];
  };

  const listProjects = async () => {
    const result = asRecord(await desktop.invoke("project/list", []));
    const projects = Array.isArray(result?.projects) ? result.projects : [];
    return projects.flatMap((value) => {
      const project = asRecord(value);
      const path = typeof project?.path === "string" ? project.path : undefined;
      if (!path || !path.startsWith("/") || path.includes("\0")) return [];
      return [{ path, name: safeText(typeof project.name === "string" && project.name ? project.name : basename(path)) }];
    });
  };

  /** 会话页的附加状态：忙闲、能否控制，以及需要在 Mac 上处理的提示。 */
  const sessionState = (session, status, messages) => {
    const capabilitiesOf = asRecord(session.capabilities) ?? {};
    const warnings = [];
    const pending = pendingSummary(status);
    if (pending.length) warnings.push(`${pending.join("、")}：需要在 Mac 上的 Pi Desktop 中处理`);
    if (pendingAskTool(messages)) warnings.push("Agent 正在提问：需要在 Mac 上的 Pi Desktop 中回答");
    const mode = session.permissionMode;
    if (mode === "ask" || mode === "accept-edits") {
      warnings.push("此会话不是自动（auto）权限模式，工具审批需要在 Mac 上处理");
    }
    return {
      activity: status.isRunning ? "busy" : "idle",
      canControl: capabilitiesOf.canPrompt !== false,
      warnings,
    };
  };

  const withLock = async (nativeId, fn) => {
    if (busy.has(nativeId)) throw new HandlerError("session_busy", "此会话的上一个操作尚未完成，请稍后重试");
    busy.add(nativeId);
    try {
      return await fn();
    } finally {
      busy.delete(nativeId);
    }
  };

  const methods = {
    async "session.list"(params, sessionId) {
      if (sessionId !== undefined) throw new HandlerError("invalid_frame", "会话列表不接受会话引用");
      if (params.projectView === "directory") {
        throw new HandlerError("not_implemented", "Pi Desktop 仅支持选择已打开过的项目，请先在 Mac 上打开项目");
      }
      if (params.projectView === "recent") {
        const projects = await listProjects();
        return { projects, home: homeDir, defaultDirectory: projects[0]?.path ?? homeDir };
      }
      if (params.projectView !== undefined) throw new HandlerError("invalid_frame", "项目列表参数无效");
      const all = (await listDesktopSessions()).slice(0, MAX_LISTED_SESSIONS);
      let offset = 0;
      let limit = all.length;
      if (params.viewVersion === 2 && (params.limit !== undefined || params.cursor != null)) {
        limit = Number.isSafeInteger(params.limit) ? Math.max(1, Math.min(50, params.limit)) : DEFAULT_PAGE;
        if (params.cursor != null) {
          const parsed = Number(params.cursor);
          if (typeof params.cursor !== "string" || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > all.length) {
            throw new HandlerError("invalid_frame", "会话分页引用无效，请刷新");
          }
          offset = parsed;
        }
      }
      const page = all.slice(offset, offset + limit);
      const sessions = await mapLimit(page, STATUS_CONCURRENCY, async (session) => {
        try {
          return sessionEntry(session, await readStatus(session.id));
        } catch {
          return sessionEntry(session, undefined, true);
        }
      });
      const nextCursor = offset + limit < all.length ? String(offset + limit) : null;
      return { sessions, capabilities: capabilities(), indexState: "ready", warnings: [], nextCursor };
    },

    async "session.start"(params, sessionId) {
      if (sessionId !== undefined) throw new HandlerError("invalid_frame", "新建 Pi Desktop 会话不接受已有会话引用");
      if (params.mode !== undefined && params.mode !== "terminal") {
        throw new HandlerError("invalid_frame", "Pi Desktop 会话与 Mac 共享，请在新建页选择「Mac 共享会话」");
      }
      if (params.historySessionId !== undefined || params.operationId !== undefined || params.args !== undefined) {
        throw new HandlerError("not_implemented", "Pi Desktop 不支持续接历史或自定义启动参数");
      }
      const input = {};
      if (params.cwd !== undefined) {
        if (typeof params.cwd !== "string" || !params.cwd.startsWith("/") || params.cwd.includes("\0") || params.cwd.length > 4096) {
          throw new HandlerError("invalid_frame", "项目目录无效");
        }
        const projects = await listProjects();
        if (!projects.some((project) => project.path === params.cwd)) {
          throw new HandlerError("invalid_frame", "请先在 Mac 上的 Pi Desktop 打开该项目，再从手机选择");
        }
        input.projectPath = params.cwd;
      }
      const selection = params.model === undefined ? undefined : readModelSelection(params.model);
      if (selection === null) throw new HandlerError("invalid_frame", "model 需要有效的 provider 和 modelId");
      let models;
      if (selection) {
        models = await listModels();
        if (!models.some((model) => model.provider === selection.provider && model.modelId === selection.modelId)) {
          throw new HandlerError("invalid_frame", "所选模型不可用，请刷新模型列表");
        }
        input.providerId = selection.provider;
        input.modelId = selection.modelId;
      }
      const created = asRecord(await desktop.invoke("session/create", [input]));
      const session = asRecord(created?.session);
      if (!session || !isDesktopSession(session)) throw new HandlerError("internal_error", "Pi Desktop 未返回有效的新会话");
      let status;
      try { status = await readStatus(session.id); } catch { status = undefined; }
      const entry = sessionEntry(session, status, status === undefined);
      watcher.track(session.id);
      let modelSelection;
      if (selection) {
        const matches = (candidate) => candidate?.providerId === selection.provider && candidate?.modelId === selection.modelId;
        let confirmed = matches(session) ? session : undefined;
        if (!confirmed) {
          // 创建结果里没带模型字段时，再从会话列表核对一次
          try {
            const listed = await findSession(session.id);
            if (matches(listed)) confirmed = listed;
          } catch { /* 按未确认处理 */ }
        }
        modelSelection = confirmed
          ? { applied: true, model: currentModel(confirmed, models) }
          : { applied: false, model: null, error: { message: "模型尚未确认生效，请在 Mac 上检查后再发送" } };
      }
      return { sessionId: entry.sessionId, source: "terminal", status: entry, ...(modelSelection ? { modelSelection } : {}) };
    },

    async "model.list"(params, sessionId) {
      if (sessionId === undefined) {
        if (params.historySessionId !== undefined) throw new HandlerError("not_implemented", "Pi Desktop 不支持续接历史会话");
        if (params.mode !== undefined && params.mode !== "terminal") {
          throw new HandlerError("invalid_frame", "Pi Desktop 会话与 Mac 共享，请选择「Mac 共享会话」");
        }
        return { models: await listModels() };
      }
      const nativeId = nativeSessionId(sessionId);
      const session = await findSession(nativeId);
      // 已有会话的模型只能在 Mac 上切换（session/configure 属于 dangerous 操作），所以只列出当前模型。
      const model = currentModel(session);
      return { sessionId, model, models: model ? [model] : [] };
    },

    async "session.get_model"(_params, sessionId) {
      const nativeId = nativeSessionId(sessionId);
      return { sessionId, model: currentModel(await findSession(nativeId)) };
    },

    async "session.set_model"() {
      throw new HandlerError("not_implemented", "切换模型需要在 Mac 上的 Pi Desktop 中操作");
    },

    async "ui.response"() {
      throw new HandlerError("not_implemented", "确认与选择需要在 Mac 上的 Pi Desktop 中处理");
    },

    async "session.get"(params, sessionId) {
      const nativeId = nativeSessionId(sessionId);
      if (params.viewVersion !== 2) throw new HandlerError("invalid_frame", "请升级手机端以阅读 Pi Desktop 会话");
      const status = await readStatus(nativeId);
      watcher.track(nativeId);
      return timeline.view(nativeId, sessionId, params, (page, isLatest) =>
        sessionState(page, status, isLatest ? page.messages : []));
    },

    async "session.prompt"(params, sessionId) {
      const nativeId = nativeSessionId(sessionId);
      if (Object.keys(params).some((key) => key !== "message" && key !== "sessionId" && key !== "images")) {
        throw new HandlerError("invalid_frame", "仅支持文字消息");
      }
      if (Array.isArray(params.images) && params.images.length > 0) {
        throw new HandlerError("not_implemented", "Pi Desktop 远程消息暂不支持图片");
      }
      const message = params.message;
      if (typeof message !== "string" || !message.trim()) throw new HandlerError("invalid_frame", "消息不能为空");
      if (Buffer.byteLength(message, "utf8") > MAX_PROMPT_BYTES) throw new HandlerError("invalid_frame", "消息过长");
      return withLock(nativeId, async () => {
        const session = await findSession(nativeId);
        if (asRecord(session.capabilities)?.canPrompt === false) {
          throw new HandlerError("invalid_frame", "Pi Desktop 当前不允许此会话接收消息");
        }
        if ((await readStatus(nativeId)).isRunning) {
          throw new HandlerError("session_busy", "请等待当前任务完成后再发送");
        }
        await desktop.invoke("agent/prompt", [{ sessionId: nativeId, content: message }]);
        watcher.track(nativeId, { poke: true });
        return { sessionId, queued: true };
      });
    },

    async "session.abort"(params, sessionId) {
      const nativeId = nativeSessionId(sessionId);
      if (Object.keys(params).some((key) => key !== "sessionId")) throw new HandlerError("invalid_frame", "停止参数无效");
      return withLock(nativeId, async () => {
        await desktop.invoke("agent/abort", [{ sessionId: nativeId }]);
        watcher.track(nativeId, { poke: true });
        return { sessionId, aborted: true };
      });
    },
  };

  return async function handle(request) {
    const method = request?.payload?.method;
    const params = asRecord(request?.payload?.params) ?? {};
    try {
      const requested = request.sessionId ?? params.sessionId;
      if (requested !== undefined && typeof requested !== "string") throw new HandlerError("invalid_frame", "会话引用无效");
      if (request.sessionId !== undefined && params.sessionId !== undefined && request.sessionId !== params.sessionId) {
        throw new HandlerError("invalid_frame", "会话参数不一致");
      }
      const fn = Object.hasOwn(methods, method) ? methods[method] : undefined;
      if (!fn) return { ok: false, error: { code: "not_implemented", message: `Pi Desktop 插件不支持 ${String(method)}` } };
      if (!desktop.ready) {
        const missing = desktop.catalog ? `缺少 ${desktop.missingRequired().join("、")}` : desktop.catalogError;
        return { ok: false, error: { code: "not_implemented", message: `Pi Desktop 控制能力不可用：${missing ?? "未知原因"}` } };
      }
      return { ok: true, data: await fn(params, requested) };
    } catch (error) {
      return { ok: false, error: toRelayError(error) };
    }
  };
}

function toRelayError(error) {
  if (error instanceof HandlerError) return { code: error.code, message: safeText(error.message) };
  if (error instanceof CapabilityError) return { code: "not_implemented", message: safeText(error.message) };
  if (error instanceof TimelineError) return { code: error.code, message: safeText(error.message) };
  const code = errorCode(error);
  const message = safeText(errorMessage(error)).slice(0, 500);
  switch (code) {
    case "NOT_FOUND":
      return { code: "unknown_session", message: "Pi Desktop 会话不存在或已删除，请刷新" };
    case "AGENT_BUSY":
    case "CONFLICT":
      return { code: "session_busy", message: "Pi Desktop 会话正忙，请稍后重试" };
    case "PERMISSION_DENIED":
      return { code: "unauthorized", message: "Pi Desktop 拒绝了此操作（权限不足）" };
    case "CONFIRMATION_REQUIRED":
      return { code: "not_implemented", message: "此操作需要在 Mac 上确认" };
    default:
      return { code: "internal_error", message: message || "Pi Desktop 操作失败" };
  }
}

module.exports = {
  createRequestHandler,
  HandlerError,
  publicSessionId,
  nativeSessionId,
  isDesktopSession,
  SESSION_PREFIX,
};
