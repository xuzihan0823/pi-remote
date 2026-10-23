"use strict";

/**
 * PI-Desktop 会话记录 → pi-remote 时间线 v2（iOS TimelineItem / TerminalSessionState 读取的形态）。
 *
 * 映射规则沿用 pi-remote 已移除的 src/desktop/timeline.ts（commit 970ba32 / c3b7095^）：
 *   - user / assistant 消息 → kind "message"
 *   - role "tool" 消息 → 一条 toolCall（参数），工具结束后再加一条 toolResult（结果）
 *   - 附件只显示文件名，不传内容
 *   - 子 agent 产生的行（parentToolCallId）不进主时间线
 * 与旧实现不同的是，这里按 PI-Desktop 的物理消息窗口（messageStart / messageBefore）分页，
 * 游标只记录消息边界并用 HMAC 签名，不依赖去重后的消息条数。
 */

const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { safeText, safeArguments, textOnly, truncateBytes, byteLength } = require("./text.js");

const BRANCH_ID = "desktop:main";
const MAX_ITEMS = 50;
const MESSAGES_PER_PAGE = 30;
const PAGE_CONTENT_LIMIT = 16_000;
const DETAIL_CONTENT_LIMIT = 200_000;
const TEXT_BYTES = 4096;
const PREVIEW_BYTES = 1024;
const ARGS_PREVIEW_BYTES = 256;
const TIMELINE_BUDGET_BYTES = 256 * 1024;
const DETAIL_CHUNK_BYTES = 60 * 1024;
const TOKEN_TTL_MS = 15 * 60_000;
const ASK_TOOL_NAMES = new Set(["asktool", "AskTool", "AskUserQuestion"]);

class TimelineError extends Error {
  /** @param {"invalid_frame" | "refresh_required" | "unknown_session"} code */
  constructor(message, code = "invalid_frame") {
    super(message);
    this.name = "TimelineError";
    this.code = code;
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function isIndex(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeAttachmentName(value) {
  if (typeof value !== "string") return undefined;
  const leaf = value.replace(/\\/g, "/").split("/").at(-1)?.trim();
  if (!leaf || leaf === "." || leaf === "..") return undefined;
  const name = safeText(leaf).trim().slice(0, 128);
  return name && name !== "." && name !== ".." ? name : undefined;
}

function textItem(id, role, rawText, extra = {}) {
  const text = safeText(rawText);
  if (!text.trim()) return null;
  const truncated = byteLength(text) > TEXT_BYTES;
  return {
    item: { id, kind: "message", role, text: truncateBytes(text, TEXT_BYTES), ...(truncated ? { truncated: true, detailId: id } : {}), ...extra },
    detail: truncated ? { result: text } : undefined,
  };
}

/**
 * 把一条 PI-Desktop UiMessage 投影成若干时间线条目。
 * 返回 { items, details }，details 以条目 id 为键，供工具详情视图分段读取。
 */
function projectMessage(nativeId, message) {
  const items = [];
  const details = {};
  const record = asRecord(message);
  if (!record || typeof record.id !== "string" || !record.id) return { items, details };
  if (typeof record.parentToolCallId === "string" && record.parentToolCallId) return { items, details };
  const key = `d:${hash(`${nativeId}\0${record.id}`).slice(0, 24)}`;
  const role = record.role;

  if (role === "user" || role === "assistant") {
    const main = textItem(`${key}:text`, role, typeof record.content === "string" ? record.content : textOnly(record.content));
    if (main) {
      items.push(main.item);
      if (main.detail) details[main.item.id] = main.detail;
    }
    if (role === "assistant" && (record.status === "error" || record.error)) {
      const error = asRecord(record.error);
      const message = typeof error?.message === "string" ? error.message : typeof record.error === "string" ? record.error : "模型服务未返回错误详情";
      const failed = textItem(`${key}:error`, "assistant", `消息执行失败：${message}`, { isError: true });
      if (failed) {
        items.push(failed.item);
        if (failed.detail) details[failed.item.id] = failed.detail;
      }
    }
    if (role === "assistant" && record.status === "aborted") {
      items.push({ id: `${key}:aborted`, kind: "boundary", text: "本轮已停止" });
    }
    const names = (Array.isArray(record.attachments) ? record.attachments : [])
      .flatMap((attachment) => {
        const name = safeAttachmentName(asRecord(attachment)?.name);
        return name ? [name] : [];
      })
      .slice(0, 20);
    if (names.length) items.push({ id: `${key}:attachments`, kind: "unsupported", text: `附件：${names.join("、")}` });
    return { items, details };
  }

  if (role === "tool") {
    const toolName = truncateBytes(safeText(typeof record.toolName === "string" && record.toolName ? record.toolName : "工具"), 100);
    const toolCallId = typeof record.toolCallId === "string" && record.toolCallId
      ? `desktop-call:${hash(`${nativeId}\0${record.toolCallId}`).slice(0, 24)}`
      : `${key}:call`;
    const toolStatus = record.toolStatus;
    const failed = record.isError === true || toolStatus === "error";
    const status = toolStatus === "running" ? "running"
      : toolStatus === "denied" ? "cancelled"
      : failed ? "failed"
      : toolStatus === "success" ? "succeeded"
      : "unknown";
    const args = record.toolArgs === undefined ? undefined : JSON.stringify(safeArguments(record.toolArgs), null, 2);
    const callId = `${key}:call`;
    items.push({
      id: callId,
      kind: "toolCall",
      name: toolName,
      toolCallId,
      status,
      detailId: callId,
      preview: args ? truncateBytes(args, ARGS_PREVIEW_BYTES) : "未记录参数",
    });
    const resultText = toolStatus === "running" ? undefined : safeText(textOnly(record.toolResult ?? record.content));
    details[callId] = {
      ...(args ? { arguments: args } : {}),
      ...(resultText !== undefined ? { result: resultText } : {}),
      ...(resultText !== undefined && (failed || toolStatus === "denied") ? { error: resultText } : {}),
    };
    if (toolStatus !== "running") {
      const resultId = `${key}:result`;
      items.push({
        id: resultId,
        kind: "toolResult",
        name: toolName,
        toolCallId,
        status,
        isError: failed || toolStatus === "denied",
        detailId: resultId,
        preview: truncateBytes(resultText || (toolStatus === "denied" ? "已拒绝执行" : "未记录文字结果"), PREVIEW_BYTES),
      });
      details[resultId] = {
        result: resultText ?? "",
        ...(failed || toolStatus === "denied" ? { error: resultText ?? "" } : {}),
      };
    }
    return { items, details };
  }

  return { items, details };
}

/** PI-Desktop 会话正在等 AskTool 回答：最新的工具行是 asktool 且仍在运行。 */
function pendingAskTool(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "tool" || message.parentToolCallId) continue;
    return ASK_TOOL_NAMES.has(String(message.toolName)) && message.toolStatus === "running";
  }
  return false;
}

/** 读取并校验 session/get 的返回。 */
function readSessionPage(raw, nativeId) {
  const session = asRecord(asRecord(raw)?.session);
  if (!session) throw new TimelineError("Pi Desktop 会话不存在或已删除，请刷新列表", "unknown_session");
  if (session.id !== nativeId) throw new TimelineError("Pi Desktop 会话身份已变化，请刷新", "refresh_required");
  if (session.remoteHostKey !== undefined || (session.source !== undefined && session.source !== "desktop")) {
    throw new TimelineError("只允许读取本机 Pi Desktop 会话");
  }
  if (!Array.isArray(session.messages)) throw new TimelineError("Pi Desktop 返回的会话记录格式无效");
  return session;
}

class TimelineService {
  /**
   * @param {{ invoke(operation: string, args?: unknown[]): Promise<unknown> }} desktop
   */
  constructor(desktop, options = {}) {
    this.desktop = desktop;
    this.secret = options.secret ?? randomBytes(32);
    this.now = options.now ?? (() => Date.now());
  }

  token(value) {
    const body = Buffer.from(JSON.stringify({ ...value, x: this.now() + TOKEN_TTL_MS })).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }

  decode(raw, kind, nativeId) {
    if (typeof raw !== "string" || raw.length > 4096) throw new TimelineError("无效的 Pi Desktop 历史引用");
    const [body, signature, extra] = raw.split(".");
    if (!body || !signature || extra !== undefined) throw new TimelineError("无效的 Pi Desktop 历史引用");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new TimelineError("无效的 Pi Desktop 历史引用");
    }
    let value;
    try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { value = undefined; }
    if (!asRecord(value) || value.k !== kind || value.n !== nativeId) throw new TimelineError("无效的 Pi Desktop 历史引用");
    if (!Number.isSafeInteger(value.x) || value.x < this.now()) throw new TimelineError("历史引用已过期，请刷新", "refresh_required");
    return value;
  }

  async readPage(nativeId, options) {
    const input = { id: nativeId, contentLimit: options.contentLimit ?? PAGE_CONTENT_LIMIT };
    if (options.messageAround !== undefined) {
      input.messageAround = options.messageAround;
      input.messageLimit = 1;
    } else {
      input.messageLimit = options.messageLimit ?? MESSAGES_PER_PAGE;
      if (options.messageBefore !== undefined) input.messageBefore = options.messageBefore;
    }
    return readSessionPage(await this.desktop.invoke("session/get", [input]), nativeId);
  }

  /**
   * 处理 session.get（viewVersion 2）的 timeline / branches / tool 三种视图。
   * stateFor(page, isLatest) 由调用方给出，根据读到的会话页返回 { activity, canControl, warnings }；
   * isLatest 表示这一页是会话末尾（只有末尾页才能判断“正在等 AskTool 回答”）。
   */
  async view(nativeId, publicId, params, stateFor) {
    const view = params.view ?? "timeline";
    if (view !== "timeline" && view !== "branches" && view !== "tool") throw new TimelineError("不支持的历史视图");
    if (params.branchId !== undefined && params.branchId !== BRANCH_ID) throw new TimelineError("Pi Desktop 会话只有一个分支，请刷新");
    if (params.afterItemId !== undefined || params.beforeItemId !== undefined) {
      throw new TimelineError("Pi Desktop 时间线不支持锚点分页，请升级手机端后重试");
    }
    if (view === "tool") return this.toolDetail(nativeId, publicId, params, stateFor);

    let messageBefore;
    if (params.before != null) messageBefore = this.decode(params.before, "before", nativeId).e;
    const page = await this.readPage(nativeId, messageBefore === undefined ? {} : { messageBefore });
    const state = await stateFor(page, messageBefore === undefined);
    const projection = this.project(nativeId, page.messages);
    const start = isIndex(page.messageStart) ? page.messageStart : 0;
    const hasMoreBefore = page.hasMoreBefore === true || (page.hasMoreBefore === undefined && start > 0);
    const revision = hash(JSON.stringify(projection.items.map((item) => [item.id, item.status ?? "", item.text ?? item.preview ?? ""]))).slice(0, 32);
    const base = {
      ...state,
      sessionId: publicId,
      viewVersion: 2,
      branchId: BRANCH_ID,
      revision,
      availability: "live",
      canControl: state.canControl,
      activity: state.activity,
    };
    const warnings = [...new Set([...(state.warnings ?? []), ...projection.warnings])].slice(0, 20);
    if (view === "branches") {
      return { ...base, branches: [{ id: BRANCH_ID, title: "Pi Desktop", damaged: false }], warnings };
    }
    const before = hasMoreBefore && start > 0 ? this.token({ k: "before", n: nativeId, e: start }) : null;
    return this.fitTimeline(base, projection, warnings, { hasMoreBefore: before !== null, before }, nativeId);
  }

  project(nativeId, messages) {
    const items = [];
    const details = {};
    const warnings = [];
    /** 条目 id → 原始消息 id，工具详情据此用 messageAround 精确回读那一条。 */
    const messageIds = new Map();
    for (const message of messages) {
      const projected = projectMessage(nativeId, message);
      for (const item of projected.items) {
        items.push(item);
        messageIds.set(item.id, message.id);
      }
      Object.assign(details, projected.details);
    }
    if (items.length > MAX_ITEMS) warnings.push("本页条目较多，仅显示最近部分；可继续向上加载");
    return { items: items.slice(-MAX_ITEMS), details, warnings, messageIds };
  }

  fitTimeline(base, projection, warnings, page, nativeId) {
    const build = (textBytes) => {
      const items = projection.items.map((item) => {
        const shrunk = item.text !== undefined && byteLength(item.text) > textBytes
          ? { ...item, text: truncateBytes(item.text, textBytes), truncated: true, detailId: item.detailId ?? item.id }
          : item;
        return shrunk.detailId ? { ...shrunk, detailId: this.token({ k: "detail", n: nativeId, i: shrunk.id, m: projection.messageIds.get(shrunk.id) }) } : shrunk;
      });
      const messages = items.flatMap((item) => item.kind === "message" ? [{ role: item.role, text: item.text }] : []);
      return { ...base, items, messages, truncated: items.some((item) => item.truncated === true), warnings, page };
    };
    // 正文按 4 KiB → 1 KiB → 256 B 逐级收紧，保证整帧远低于 PI-Desktop 的 1 MiB 上限。
    for (const textBytes of [TEXT_BYTES, 1024, 256]) {
      const response = build(textBytes);
      if (byteLength(JSON.stringify(response)) <= TIMELINE_BUDGET_BYTES) return response;
    }
    throw new TimelineError("本页内容过大，请在 Mac 上查看");
  }

  async toolDetail(nativeId, publicId, params, stateFor) {
    const reference = this.decode(params.detailId, "detail", nativeId);
    const field = params.field === "arguments" || params.field === "error" ? params.field : "result";
    let offset = 0;
    if (params.cursor != null) {
      const cursor = this.decode(params.cursor, "tool", nativeId);
      if (cursor.i !== reference.i || cursor.f !== field || !isIndex(cursor.o)) throw new TimelineError("无效的详情分页");
      offset = cursor.o;
    }
    const messageId = reference.m;
    if (typeof messageId !== "string" || !messageId) throw new TimelineError("无效的详情引用");
    const page = await this.readPage(nativeId, { messageAround: messageId, contentLimit: DETAIL_CONTENT_LIMIT });
    const message = page.messages.find((candidate) => asRecord(candidate)?.id === messageId);
    if (!message) throw new TimelineError("该消息已不在会话中，请刷新", "refresh_required");
    const state = await stateFor(page, false);
    const projected = projectMessage(nativeId, message);
    // 正文条目在时间线里被截断时，详情就是完整正文。
    const fullText = projected.details[reference.i] ?? fullMessageText(projected, reference.i, message);
    const context = {
      ...state,
      sessionId: publicId,
      branchId: BRANCH_ID,
      viewVersion: 2,
      revision: typeof params.revision === "string" ? params.revision : "",
      availability: "live",
    };
    const text = fullText?.[field];
    if (text === undefined) return { ...context, field, recorded: false, totalBytes: 0, returnedBytes: 0 };
    const bytes = Buffer.from(text, "utf8");
    if (offset > bytes.length) throw new TimelineError("无效的详情偏移");
    const value = truncateBytes(bytes.subarray(offset).toString("utf8"), DETAIL_CHUNK_BYTES);
    const returnedBytes = byteLength(value);
    const hasMore = offset + returnedBytes < bytes.length;
    return {
      ...context,
      field,
      recorded: true,
      text: value,
      totalBytes: bytes.length,
      returnedBytes,
      truncated: hasMore,
      sourceTruncated: false,
      nextCursor: hasMore ? this.token({ k: "tool", n: nativeId, i: reference.i, f: field, o: offset + returnedBytes }) : null,
    };
  }
}

function fullMessageText(projected, itemId, message) {
  const item = projected.items.find((candidate) => candidate.id === itemId);
  if (!item) return undefined;
  if (item.kind === "message") {
    const record = asRecord(message);
    const raw = itemId.endsWith(":error")
      ? `消息执行失败：${asRecord(record?.error)?.message ?? record?.error ?? ""}`
      : typeof record?.content === "string" ? record.content : textOnly(record?.content);
    return { result: safeText(raw) };
  }
  return projected.details[itemId];
}

module.exports = {
  TimelineService,
  TimelineError,
  projectMessage,
  pendingAskTool,
  readSessionPage,
  BRANCH_ID,
  MESSAGES_PER_PAGE,
  TIMELINE_BUDGET_BYTES,
};
