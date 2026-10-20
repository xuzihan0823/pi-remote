import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  projectTranscript,
  safeText,
  TimelineRequestError,
  TimelineViewService,
  type PiSessionEntry,
  type ProjectedTranscript,
  type TimelineContext,
  type TimelineItem,
  type ToolStatus,
} from "../terminal/extension.ts";

const MESSAGE_LIMIT = 50;
const CONTENT_LIMIT = 64_000;
const CONTENT_LIMITS = [64_000, 32_000, 16_000, 8_000, 4_000] as const;
const SESSION_CACHE_LIMIT = 32;
const PAGE_CACHE_LIMIT = 16;
const MAX_PAGES_PER_REQUEST = 16;
const BRANCH_ID = "desktop:main";
const CURSOR_TTL_MS = 15 * 60_000;
const CONTENT_WARNING = "为避免内容超限，当前读取精简正文；完整内容请在 Pi Desktop 查看";

export interface DesktopTimelineClient {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

interface DesktopMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  thinking?: string;
  modelSystem?: unknown;
  attachments?: { name?: unknown; ref?: unknown; data?: unknown }[];
  toolName?: string;
  toolCallId?: string;
  toolStatus?: "running" | "success" | "error" | "denied";
  toolArgs?: unknown;
  toolResult?: unknown;
  status?: string;
  isError?: boolean;
}

interface TimelineRow {
  item: TimelineItem;
  position: number;
  fingerprint: string;
  pageStart: number;
  pageEnd: number;
  pageDigest: string;
  details: ProjectedTranscript["details"];
  warnings: string[];
}

interface NativePage {
  start: number;
  end: number;
  count: number;
  readGeneration: number;
  messages: DesktopMessage[];
  fingerprints: string[];
  digest: string;
  rows: TimelineRow[];
}

interface SessionCache {
  contentLimit: number;
  readGeneration: number;
  pages: Map<number, NativePage>;
  items: Map<string, TimelineRow>;
  revisions: Map<string, Map<string, string>>;
  latestCount?: number;
}

interface PageAnchor {
  start: number;
  end: number;
  digest: string;
}

interface Cursor {
  kind: "desktop-before";
  publicId: string;
  nativeId: string;
  branchId: string;
  expires: number;
  page: PageAnchor;
  contentLimit: number;
  anchor?: { itemId: string; position: number; fingerprint: string };
  boundary?: number;
}

interface NativeSession {
  id: string;
  source?: unknown;
  remoteHostKey?: unknown;
  messages: unknown[];
  messageStart?: unknown;
  messageEnd?: unknown;
  messageCount?: unknown;
  hasMoreBefore?: unknown;
  hasMoreAfter?: unknown;
}

interface TimelineState {
  activity: string;
  canControl: boolean;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function textOnly(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.flatMap(part => {
      const block = asRecord(part);
      return block && (block.type === undefined || block.type === "text") && typeof block.text === "string"
        ? [block.text] : [];
    }).join("");
  }
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  return textOnly(record.content);
}

function safeAttachmentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const leaf = value.replace(/\\/g, "/").split("/").at(-1)?.trim();
  if (!leaf || leaf === "." || leaf === "..") return undefined;
  const name = safeText(leaf).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 128);
  return name && name !== "." && name !== ".." ? name : undefined;
}

function refreshRequired(message = "Desktop 历史边界已变化，请刷新（refresh-required）"): TimelineRequestError {
  return new TimelineRequestError(message, "refresh_required");
}

function resultTooLarge(): TimelineRequestError {
  return new TimelineRequestError("Pi Desktop 返回内容过大，暂时无法读取，请稍后在 Pi Desktop 查看", "result_too_large");
}

function isResultTooLarge(error: unknown): boolean {
  return asRecord(error)?.code === "result_too_large";
}

export class DesktopTimeline {
  readonly #client: DesktopTimelineClient;
  readonly #views = new TimelineViewService();
  readonly #cursorSecret = randomBytes(32);
  readonly #sessions = new Map<string, SessionCache>();

  constructor(client: DesktopTimelineClient) {
    this.#client = client;
  }

  async get(nativeId: string, publicId: string, params: Record<string, unknown>, state: TimelineState): Promise<Record<string, unknown>> {
    if (!nativeId || nativeId.length > 1024 || !publicId || publicId.length > 1024) {
      throw new TimelineRequestError("Desktop 会话标识无效");
    }
    const view = params.view;
    if (view !== undefined && view !== "timeline" && view !== "tool" && view !== "branches") {
      throw new TimelineRequestError("不支持的历史视图");
    }
    if (params.branchId !== undefined && params.branchId !== BRANCH_ID) {
      throw new TimelineRequestError("Desktop 会话仅有一个分支，请刷新");
    }
    const cache = this.#session(publicId, nativeId);
    if (view === "tool") return this.#toolDetail(nativeId, publicId, params, state, cache);

    const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(MESSAGE_LIMIT, Math.floor(params.limit))) : MESSAGE_LIMIT;
    if (params.before != null && (params.afterItemId !== undefined || params.beforeItemId !== undefined) ||
      params.afterItemId !== undefined && params.beforeItemId !== undefined) {
      throw new TimelineRequestError("无效的时间线分页参数");
    }

    if (params.before != null) {
      const cursor = this.#decodeCursor(params.before, publicId, nativeId, cache);
      const result = await this.#beforeCursor(cursor, cache, limit);
      return this.#respond(nativeId, publicId, result.rows, result.hasMoreBefore, result.fallbackPage,
        false, state, limit, cache, params);
    }
    if (params.beforeItemId !== undefined) {
      const anchor = this.#itemAnchor(cache, params.beforeItemId);
      const result = await this.#beforeAnchor(nativeId, anchor, cache, limit);
      return this.#respond(nativeId, publicId, result.rows, result.hasMoreBefore, result.fallbackPage,
        false, state, limit, cache, params);
    }
    if (params.afterItemId !== undefined) {
      const anchor = this.#itemAnchor(cache, params.afterItemId);
      const result = await this.#afterAnchor(nativeId, anchor, cache, limit);
      return this.#respond(nativeId, publicId, result.rows, this.#hasMoreBefore(result.rows), result.fallbackPage,
        result.hasMoreAfter, state, limit, cache, params);
    }

    const page = await this.#fetch(nativeId, cache);
    this.#remember(cache, page);
    if (view === "branches") {
      const revision = this.#revision(page.rows, cache.contentLimit);
    return {
      ...state,
      ...this.#context(publicId, revision, state),
      viewVersion: 2,
      branches: [{ id: BRANCH_ID, title: "Desktop", damaged: false }],
      warnings: this.#withContentWarning(state, this.#warnings(page.rows), cache.contentLimit),
    };
    }
    const rows = page.rows.slice(-limit);
    cache.latestCount = page.count;
    return this.#respond(nativeId, publicId, rows, page.start > 0 || page.rows.length > rows.length,
      page, false, state, limit, cache, params);
  }

  #session(publicId: string, nativeId: string): SessionCache {
    const key = `${publicId}\0${nativeId}`;
    let cache = this.#sessions.get(key);
    if (!cache) cache = { contentLimit: CONTENT_LIMIT, readGeneration: 0, pages: new Map(), items: new Map(), revisions: new Map() };
    this.#sessions.delete(key);
    this.#sessions.set(key, cache);
    while (this.#sessions.size > SESSION_CACHE_LIMIT) this.#sessions.delete(this.#sessions.keys().next().value!);
    return cache;
  }

  #remember(cache: SessionCache, page: NativePage): void {
    if (page.readGeneration !== cache.readGeneration) throw refreshRequired();
    cache.pages.delete(page.start);
    cache.pages.set(page.start, page);
    while (cache.pages.size > PAGE_CACHE_LIMIT) cache.pages.delete(cache.pages.keys().next().value!);
    cache.items.clear();
    for (const cached of cache.pages.values()) for (const row of cached.rows) cache.items.set(row.item.id, row);
  }

  #itemAnchor(cache: SessionCache, raw: unknown): TimelineRow {
    if (typeof raw !== "string" || raw.length > 512) throw new TimelineRequestError("无效的时间线锚点");
    const row = cache.items.get(raw);
    if (!row) throw refreshRequired("消息锚点未知或已过期，请刷新（refresh-required）");
    return row;
  }

  async #fetch(nativeId: string, cache: SessionCache, messageBefore?: number, requiresRefresh = false): Promise<NativePage> {
    let contentLimit = cache.contentLimit;
    while (true) {
      const generation = cache.readGeneration;
      const args: Record<string, unknown> = { id: nativeId, messageLimit: MESSAGE_LIMIT, contentLimit };
      if (messageBefore !== undefined) args.messageBefore = messageBefore;
      let raw: unknown;
      try {
        raw = await this.#client.call("pi_session_get", args);
      } catch (error) {
        if (cache.readGeneration !== generation) throw refreshRequired();
        if (!isResultTooLarge(error)) throw error;
        const next = CONTENT_LIMITS[CONTENT_LIMITS.indexOf(contentLimit as typeof CONTENT_LIMITS[number]) + 1];
        if (next === undefined) throw resultTooLarge();
        cache.contentLimit = next;
        cache.readGeneration++;
        cache.pages.clear();
        cache.items.clear();
        cache.revisions.clear();
        cache.latestCount = undefined;
        contentLimit = next;
        if (requiresRefresh) throw refreshRequired();
        continue;
      }
      if (cache.readGeneration !== generation) throw refreshRequired();
      const response = asRecord(raw);
      const session = asRecord(response?.session) as NativeSession | undefined;
      if (!session || session.id !== nativeId) throw new TimelineRequestError("Desktop 会话不存在或已删除");
      if (session.remoteHostKey !== undefined) throw new TimelineRequestError("只允许读取本机 Pi Desktop 会话");
      if (session.source !== undefined) {
        if (session.source !== "desktop") throw new TimelineRequestError("只允许读取 Pi Desktop 会话");
      } else if (nativeId.startsWith("native-pi:") || nativeId.startsWith("remote:")) {
        throw new TimelineRequestError("来源未确认，拒绝读取非 Desktop 会话");
      }
      if (!Array.isArray(session.messages) || !isIndex(session.messageStart) ||
        session.messageEnd !== undefined && !isIndex(session.messageEnd) || !isIndex(session.messageCount)) {
        throw new TimelineRequestError("Desktop 未返回完整分页元数据，拒绝伪造历史完整性");
      }

      const start = session.messageStart;
      const count = session.messageCount;
      const end = session.messageEnd ?? (messageBefore ?? (session.hasMoreAfter === false ? count : undefined));
      if (end === undefined) {
        throw new TimelineRequestError("Desktop 未返回可验证的消息结束位置，拒绝伪造历史完整性");
      }
      if (start > end || end > count || session.messages.length !== end - start ||
        (messageBefore === undefined ? end !== count : end !== messageBefore)) {
        throw refreshRequired("Desktop 返回的物理分页边界不一致，请刷新");
      }
      if (session.hasMoreBefore !== undefined && typeof session.hasMoreBefore !== "boolean" ||
        session.hasMoreAfter !== undefined && typeof session.hasMoreAfter !== "boolean" ||
        session.hasMoreBefore === false && start > 0 || session.hasMoreAfter === false && end < count) {
        throw refreshRequired("Desktop 分页状态与消息边界冲突，请刷新");
      }

      const messages = session.messages.map(value => this.#validateMessage(value));
      const fingerprints = messages.map(message => hash(stableJson(message)));
      const pageDigest = hash(JSON.stringify({ start, end, contentLimit, fingerprints }));
      const page: NativePage = { start, end, count, readGeneration: generation, messages, fingerprints, digest: pageDigest, rows: [] };
      for (let index = 0; index < messages.length; index++) {
        const position = start + index;
        const fingerprint = fingerprints[index]!;
        const projection = this.#projectMessage(nativeId, messages[index]!);
        for (const item of projection.items) {
          page.rows.push({
            item,
            position,
            fingerprint,
            pageStart: start,
            pageEnd: end,
            pageDigest,
            details: projection.details,
            warnings: projection.warnings,
          });
        }
      }
      return page;
    }
  }

  #validateMessage(value: unknown): DesktopMessage {
    const message = asRecord(value);
    if (!message || typeof message.id !== "string" || !message.id || message.id.length > 1024 ||
      !["user", "assistant", "system", "tool"].includes(String(message.role)) || typeof message.content !== "string" ||
      message.attachments !== undefined && !Array.isArray(message.attachments) ||
      message.toolStatus !== undefined && !["running", "success", "error", "denied"].includes(String(message.toolStatus))) {
      throw new TimelineRequestError("Desktop 返回了无效消息，拒绝返回不完整历史");
    }
    return message as unknown as DesktopMessage;
  }

  #projectMessage(nativeId: string, message: DesktopMessage): ProjectedTranscript {
    const entryId = `desktop:${hash(`${nativeId}\0${message.id}`)}`;
    let entries: PiSessionEntry[] = [];
    const toolStates = new Map<string, ToolStatus>();
    if (message.role === "user" || message.role === "assistant") {
      entries = [{ type: "message", id: entryId, message: { role: message.role, content: message.content } }];
    } else if (message.role === "tool") {
      const callId = message.toolCallId
        ? `desktop-call:${hash(`${nativeId}\0${message.toolCallId}`)}`
        : `${entryId}:call`;
      const failed = message.isError === true || message.toolStatus === "error" || message.toolStatus === "denied";
      entries = [
        {
          type: "message",
          id: `${entryId}:call`,
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: callId, name: message.toolName || "工具", arguments: message.toolArgs }],
          },
        },
        ...(message.toolStatus === "running" ? [] : [{
          type: "message" as const,
          id: `${entryId}:result`,
          message: {
            role: "toolResult",
            toolCallId: callId,
            toolName: message.toolName || "工具",
            isError: failed,
            content: textOnly(message.toolResult ?? message.content),
          },
        }]),
      ];
      const status: ToolStatus = message.toolStatus === "running" ? "running"
        : failed ? "failed" : message.toolStatus === "success" ? "succeeded" : "unknown";
      toolStates.set(callId, status);
    }
    const projection = projectTranscript(entries, { live: true, toolStates });
    if (message.role === "user" || message.role === "assistant") {
      const names = (message.attachments ?? []).flatMap(attachment => {
        const name = safeAttachmentName(asRecord(attachment)?.name);
        return name ? [name] : [];
      });
      if (names.length) {
        projection.items.push({ id: `${entryId}:attachments`, kind: "unsupported", text: `附件：${names.join("、")}` });
      }
    }
    return projection;
  }

  #encodeCursor(publicId: string, nativeId: string, page: PageAnchor, contentLimit: number, row?: TimelineRow): string {
    const value: Cursor = {
      kind: "desktop-before",
      publicId,
      nativeId,
      branchId: BRANCH_ID,
      expires: Date.now() + CURSOR_TTL_MS,
      page: { start: page.start, end: page.end, digest: page.digest },
      contentLimit,
      ...(row ? { anchor: { itemId: row.item.id, position: row.position, fingerprint: row.fingerprint } }
        : { boundary: page.start }),
    };
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    const signature = createHmac("sha256", this.#cursorSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  #decodeCursor(raw: unknown, publicId: string, nativeId: string, cache: SessionCache): Cursor {
    if (typeof raw !== "string" || raw.length > 4096) throw new TimelineRequestError("无效的 Desktop 历史游标");
    const [body, signature, extra] = raw.split(".");
    if (!body || !signature || extra !== undefined) throw new TimelineRequestError("无效的 Desktop 历史游标");
    const expected = createHmac("sha256", this.#cursorSecret).update(body).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new TimelineRequestError("无效的 Desktop 历史游标");
    }
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
    catch { throw new TimelineRequestError("无效的 Desktop 历史游标"); }
    const cursor = asRecord(decoded) as unknown as Cursor | undefined;
    if (!cursor) throw new TimelineRequestError("Desktop 历史游标已失效，请刷新");
    if (!Number.isSafeInteger(cursor.contentLimit) || !CONTENT_LIMITS.includes(cursor.contentLimit as typeof CONTENT_LIMITS[number])) {
      throw refreshRequired("Desktop 历史游标读取档位无效，请刷新");
    }
    if (cursor.contentLimit !== cache.contentLimit) throw refreshRequired("Desktop 历史游标读取档位已变化，请刷新");
    if (cursor.kind !== "desktop-before" || cursor.publicId !== publicId || cursor.nativeId !== nativeId ||
      cursor.branchId !== BRANCH_ID || !Number.isSafeInteger(cursor.expires) || cursor.expires < Date.now() ||
      !cursor.page || !isIndex(cursor.page.start) || !isIndex(cursor.page.end) || cursor.page.end <= cursor.page.start ||
      typeof cursor.page.digest !== "string" || cursor.page.digest.length > 128 ||
      (cursor.anchor !== undefined && (typeof cursor.anchor.itemId !== "string" || !isIndex(cursor.anchor.position) ||
        typeof cursor.anchor.fingerprint !== "string")) ||
      (cursor.boundary !== undefined && cursor.boundary !== cursor.page.start) ||
      (cursor.anchor === undefined) === (cursor.boundary === undefined)) {
      throw new TimelineRequestError("Desktop 历史游标已失效，请刷新");
    }
    return cursor;
  }

  async #exactPage(nativeId: string, anchor: PageAnchor, cache: SessionCache): Promise<NativePage> {
    const page = await this.#fetch(nativeId, cache, anchor.end, true);
    if (page.start !== anchor.start || page.end !== anchor.end || page.digest !== anchor.digest) {
      throw refreshRequired("游标对应的历史消息已被改写或删除，请刷新");
    }
    return page;
  }

  async #beforeCursor(cursor: Cursor, cache: SessionCache, limit: number): Promise<{
    rows: TimelineRow[]; hasMoreBefore: boolean; fallbackPage: NativePage;
  }> {
    let page = await this.#exactPage(cursor.nativeId, cursor.page, cache);
    this.#remember(cache, page);
    let prefix: TimelineRow[];
    if (cursor.anchor) {
      const index = page.rows.findIndex(row => row.item.id === cursor.anchor!.itemId &&
        row.position === cursor.anchor!.position && row.fingerprint === cursor.anchor!.fingerprint);
      if (index < 0) throw refreshRequired("游标锚点已被改写或删除，请刷新");
      prefix = page.rows.slice(0, index);
    } else {
      if (page.start !== cursor.boundary || page.start === 0) throw refreshRequired("历史分页边界已变化，请刷新");
      page = await this.#fetch(cursor.nativeId, cache, page.start, true);
      if (page.end !== cursor.boundary) throw refreshRequired("历史分页边界已变化，请刷新");
      this.#remember(cache, page);
      prefix = page.rows;
    }
    return this.#collectBefore(cursor.nativeId, page, prefix, cache, limit);
  }

  async #beforeAnchor(nativeId: string, anchor: TimelineRow, cache: SessionCache, limit: number): Promise<{
    rows: TimelineRow[]; hasMoreBefore: boolean; fallbackPage: NativePage;
  }> {
    const page = await this.#exactPage(nativeId, {
      start: anchor.pageStart, end: anchor.pageEnd, digest: anchor.pageDigest,
    }, cache);
    this.#remember(cache, page);
    const index = page.rows.findIndex(row => row.item.id === anchor.item.id && row.position === anchor.position &&
      row.fingerprint === anchor.fingerprint);
    if (index < 0) throw refreshRequired("消息锚点已被改写或删除，请刷新");
    return this.#collectBefore(nativeId, page, page.rows.slice(0, index), cache, limit);
  }

  async #collectBefore(nativeId: string, initial: NativePage, initialRows: TimelineRow[], cache: SessionCache, limit: number): Promise<{
    rows: TimelineRow[]; hasMoreBefore: boolean; fallbackPage: NativePage;
  }> {
    let page = initial;
    let rows = initialRows;
    let reads = 0;
    while (rows.length < limit && page.start > 0 && reads < MAX_PAGES_PER_REQUEST) {
      const older = await this.#fetch(nativeId, cache, page.start, true);
      if (older.end !== page.start) throw refreshRequired("Desktop 历史分页不连续，请刷新");
      this.#remember(cache, older);
      rows = [...older.rows, ...rows];
      page = older;
      reads++;
    }
    const selected = rows.slice(-limit);
    return { rows: selected, hasMoreBefore: rows.length > selected.length || page.start > 0, fallbackPage: page };
  }

  async #afterAnchor(nativeId: string, anchor: TimelineRow, cache: SessionCache, limit: number): Promise<{
    rows: TimelineRow[]; hasMoreAfter: boolean; fallbackPage: NativePage;
  }> {
    const original = await this.#exactPage(nativeId, {
      start: anchor.pageStart, end: anchor.pageEnd, digest: anchor.pageDigest,
    }, cache);
    this.#remember(cache, original);
    const anchorIndex = original.rows.findIndex(row => row.item.id === anchor.item.id &&
      row.position === anchor.position && row.fingerprint === anchor.fingerprint);
    if (anchorIndex < 0) throw refreshRequired("消息锚点已被改写或删除，请刷新");

    const latest = await this.#fetch(nativeId, cache, undefined, true);
    this.#remember(cache, latest);
    cache.latestCount = latest.count;
    if (latest.count <= anchor.position) throw refreshRequired("消息锚点已被删除，请刷新");
    const idEnd = Math.min(anchor.position + 1, anchor.position + MESSAGE_LIMIT);
    const anchorWindow = await this.#fetch(nativeId, cache, idEnd, true);
    const anchorOffset = anchor.position - anchorWindow.start;
    if (anchorOffset < 0 || anchorWindow.fingerprints[anchorOffset] !== anchor.fingerprint) {
      throw refreshRequired("消息锚点已被改写或删除，请刷新");
    }
    this.#remember(cache, anchorWindow);
    const anchorRowIndex = anchorWindow.rows.findIndex(row => row.item.id === anchor.item.id &&
      row.position === anchor.position && row.fingerprint === anchor.fingerprint);
    if (anchorRowIndex < 0) throw refreshRequired("消息锚点已被改写或删除，请刷新");
    let rows = anchorWindow.rows.slice(anchorRowIndex + 1);
    let page = anchorWindow;
    let reads = 0;
    while (rows.length <= limit && page.end < latest.count && reads < MAX_PAGES_PER_REQUEST) {
      const end = Math.min(page.end + MESSAGE_LIMIT, latest.count);
      const next = await this.#fetch(nativeId, cache, end, true);
      if (next.end !== end || next.start > page.end) throw refreshRequired("Desktop 历史分页不连续，请刷新");
      this.#remember(cache, next);
      rows.push(...next.rows.filter(row => row.position >= page.end));
      page = next;
      reads++;
    }
    const selected = rows.slice(0, limit);
    return {
      rows: selected,
      hasMoreAfter: rows.length > selected.length || page.end < latest.count,
      fallbackPage: page,
    };
  }

  #hasMoreBefore(rows: readonly TimelineRow[]): boolean {
    return rows.length > 0 && rows[0]!.position > 0;
  }

  #revision(rows: readonly TimelineRow[], contentLimit: number): string {
    return hash(JSON.stringify([contentLimit, rows.map(row => [row.item.id, row.position, row.fingerprint])]));
  }

  #context(publicId: string, revision: string, state: TimelineState): TimelineContext {
    return {
      sessionId: publicId,
      branchId: BRANCH_ID,
      revision,
      availability: "live",
      canControl: state.canControl,
      activity: state.activity,
    };
  }

  #respond(
    nativeId: string,
    publicId: string,
    rows: TimelineRow[],
    hasMoreBefore: boolean,
    fallbackPage: NativePage,
    hasMoreAfter: boolean,
    state: TimelineState,
    limit: number,
    cache: SessionCache,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    rows = rows.slice(0, Math.min(MESSAGE_LIMIT, limit));
    const revision = rows.length ? this.#revision(rows, cache.contentLimit) : hash(`${cache.contentLimit}:${fallbackPage.start}:${fallbackPage.end}:${fallbackPage.digest}`);
    const context = this.#context(publicId, revision, state);
    const revisionEntries = new Map<string, string>();
    for (const row of rows) revisionEntries.set(row.item.id, row.fingerprint);
    cache.revisions.set(revision, revisionEntries);
    while (cache.revisions.size > PAGE_CACHE_LIMIT) cache.revisions.delete(cache.revisions.keys().next().value!);
    const details: ProjectedTranscript["details"] = {};
    const warnings = new Set<string>();
    for (const row of rows) {
      Object.assign(details, row.details);
      for (const warning of row.warnings) warnings.add(warning);
    }
    const projection: ProjectedTranscript = {
      items: rows.map(row => row.item),
      details,
      warnings: [...warnings].slice(0, 20),
      total: rows.length,
    };
    const response = this.#views.respond(context, projection, { ...params, view: "timeline", limit }, { start: 0, end: rows.length });
    const returnedPage = asRecord(response.page);
    const returnedItems = response.items as TimelineItem[];
    const returnedFirst = returnedItems[0];
    const returnedFirstRow = returnedFirst ? rows.find(row => row.item.id === returnedFirst.id) : undefined;
    const before = returnedPage?.hasMoreBefore === true || hasMoreBefore
      ? this.#encodeCursor(publicId, nativeId, returnedFirstRow ? {
        start: returnedFirstRow.pageStart, end: returnedFirstRow.pageEnd, digest: returnedFirstRow.pageDigest,
      } : fallbackPage, cache.contentLimit, returnedFirstRow)
      : null;
    const hasMoreAfterPage = returnedPage?.hasMoreAfter === true || hasMoreAfter;
    const warningList = this.#withContentWarning(state, projection.warnings, cache.contentLimit);
    return {
      ...state,
      ...response,
      sessionId: publicId,
      viewVersion: 2,
      branchId: BRANCH_ID,
      revision,
      availability: "live",
      canControl: state.canControl,
      activity: state.activity,
      items: (response.items as TimelineItem[]).slice(0, MESSAGE_LIMIT),
      page: { ...returnedPage, before, hasMoreBefore: before !== null, hasMoreAfter: hasMoreAfterPage },
      warnings: warningList,
    };
  }

  async #toolDetail(nativeId: string, publicId: string, params: Record<string, unknown>, state: TimelineState,
    cache: SessionCache): Promise<Record<string, unknown>> {
    if (typeof params.revision !== "string" || params.revision.length > 256) {
      throw new TimelineRequestError("工具详情版本无效，请刷新");
    }
    const context = this.#context(publicId, params.revision, state);
    const itemId = this.#views.detailItemId(context, params);
    const anchor = this.#itemAnchor(cache, itemId);
    const entries = cache.revisions.get(params.revision);
    if (!entries || entries.get(itemId) !== anchor.fingerprint) {
      throw new TimelineRequestError("工具详情版本已过期，请刷新");
    }
    const page = await this.#fetch(nativeId, cache, anchor.position + 1, true);
    const offset = anchor.position - page.start;
    if (offset < 0 || page.fingerprints[offset] !== anchor.fingerprint) {
      throw refreshRequired("工具消息已被改写或删除，请刷新");
    }
    this.#remember(cache, page);
    const projection = this.#projectMessage(nativeId, page.messages[offset]!);
    for (const [id, fingerprint] of entries) {
      if (fingerprint !== anchor.fingerprint) continue;
      const parts = projection.items.filter(item => item.id === id);
      if (parts.length && parts.some(item => !projection.details[item.id])) {
        throw refreshRequired("工具详情内容已变化，请刷新");
      }
    }
    if (!projection.details[itemId]) throw new TimelineRequestError("工具详情未记录");
    const response = this.#views.respond(context, projection, params);
    const warningList = this.#withContentWarning(state, response.warnings, cache.contentLimit);
    return { ...state, ...response, sessionId: publicId, branchId: BRANCH_ID, viewVersion: 2,
      warnings: warningList };
  }

  #combineWarnings(state: TimelineState, raw: unknown): string[] {
    const values = [...(Array.isArray(state.warnings) ? state.warnings.filter((value): value is string => typeof value === "string") : []),
      ...(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [])];
    return [...new Set(values)].slice(0, 20);
  }

  #warnings(rows: readonly TimelineRow[]): string[] {
    return [...new Set(rows.flatMap(row => row.warnings))].slice(0, 20);
  }

  #withContentWarning(state: TimelineState, warnings: unknown, contentLimit: number): string[] {
    const combined = [...(Array.isArray(state.warnings) ? state.warnings.filter((value): value is string => typeof value === "string") : []),
      ...(Array.isArray(warnings) ? warnings.filter((value): value is string => typeof value === "string") : [])];
    const unique = [...new Set(combined)];
    return contentLimit < CONTENT_LIMIT
      ? [...unique.filter(value => value !== CONTENT_WARNING).slice(0, 19), CONTENT_WARNING].slice(0, 20)
      : unique.slice(0, 20);
  }
}
