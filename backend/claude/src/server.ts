// HTTP + WebSocket 服务层：docs/api-contract.md 的落地。
//
// 职责：Bearer/token 鉴权、HTTP 端点映射（NotIdleError→409、already_resolved→409、
// ENOENT→404）、WS subscribe 管理与广播、web/ 静态托管、watcher/activity/runner/
// approval 事件 → WS 帧、notifier 触发（审批创建、run 终态）。
//
// 广播语义：message/resync/run 只发给订阅了该会话的连接；status 另发给订阅 "*"
// 的连接；approval / approval.resolved 广播给全部已鉴权连接（前端按 interactionId
// 匹配，见 05 报告对表第 4 条）。

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";

import type { DaemonConfig } from "./config.ts";
import { enumeratePairBases, isLoopbackAddress, looksProxied, pairPayload, type PairInfo } from "./pair.ts";
import { isKnownModel, readModelCatalog, type ModelCatalog } from "./model-config.ts";
import { readSessionCwd, resolveSessionFile } from "./session-files.ts";
import { NotIdleError, type ApprovalBridge, type ApprovalEvent, type Notifier, type TurnHandle, type TurnRunner } from "./run/index.ts";
import { listSessions } from "./transcript/indexer.ts";
import { readBefore, readTail } from "./transcript/reader.ts";
import type { ActivityTracker } from "./watch/activity.ts";
import type { SessionWatcher } from "./watch/watcher.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const BODY_LIMIT_BYTES = 1024 * 1024;
const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const MESSAGES_LIMIT_DEFAULT = 100;
const MESSAGES_LIMIT_MAX = 500;
const WS_HEARTBEAT_MS = 30_000;

const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);
type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface DaemonServerOptions {
  config: DaemonConfig;
  /** web/ 静态目录绝对路径；独立后端不托管前端，省略时非 API GET/HEAD 一律 404。 */
  webRoot?: string;
  watcher: SessionWatcher;
  tracker: ActivityTracker;
  runner: TurnRunner;
  approvals: ApprovalBridge;
  notifier: Notifier;
  version: string;
  /** 返回启动时探测的 claude CLI 版本（未就绪/失败时 "unknown"）。 */
  claudeCliVersion: () => string;
  /** 测试/嵌入方可注入；默认每次请求重新读取 Mac 设置，以反映即时切换。 */
  modelCatalog?: () => Promise<ModelCatalog>;
}

interface ClientState {
  subs: Set<string>;
  alive: boolean;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class DaemonServer {
  readonly #options: DaemonServerOptions;
  #pairPort: number;
  readonly #tokenHash: Buffer;
  readonly #instanceId: string;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #clients = new Map<WebSocket, ClientState>();
  readonly #watchRefs = new Map<string, number>();
  readonly #activeRuns = new Map<string, TurnHandle>();
  readonly #newSessions = new Set<string>();
  readonly #watchActivations = new Set<string>();
  readonly #watchRetryTimers = new Map<string, NodeJS.Timeout>();
  #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: DaemonServerOptions) {
    this.#options = options;
    this.#pairPort = options.config.port;
    this.#tokenHash = sha256(options.config.token);
    // 生产路径由 loadConfig 保证有值；fixture 直接构造 config 时回退随机 UUID。
    this.#instanceId = options.config.instanceId ?? randomUUID();
    this.#http = createServer((req, res) => {
      void this.#handleRequest(req, res).catch((error) => {
        console.error("request handler failed:", error);
        if (!res.headersSent) this.#json(res, 500, { error: "internal" });
        else res.destroy();
      });
    });
    this.#wss = new WebSocketServer({ noServer: true });
    this.#http.on("upgrade", (req, socket, head) => this.#handleUpgrade(req, socket, head));
    this.#wireEvents();
  }

  /** 监听端口。 */
  listen(): Promise<void> {
    const { host, port } = this.#options.config;
    return new Promise((resolvePromise, rejectPromise) => {
      this.#http.once("error", rejectPromise);
      this.#http.listen(port, host, () => {
        this.#http.off("error", rejectPromise);
        this.#pairPort = this.address().port;
        this.#heartbeat = setInterval(() => this.#pingClients(), WS_HEARTBEAT_MS);
        this.#heartbeat.unref();
        resolvePromise();
      });
    });
  }

  /** 配对信息（候选地址每次现查——Tailscale 可能在 daemon 启动后才拉起）；listen() 后用实际端口。 */
  get pairInfo(): PairInfo {
    const { publicBases, token } = this.#options.config;
    return { bases: [...new Set([...publicBases, ...enumeratePairBases(this.#pairPort)])], token };
  }

  /** 实际监听地址（测试用 port 0）。 */
  address(): { host: string; port: number } {
    const addr = this.#http.address();
    if (addr === null || typeof addr === "string") throw new Error("server not listening");
    return { host: addr.address, port: addr.port };
  }

  /** ApprovalBridge onEvent 接线入口：广播 + 审批创建通知。 */
  handleApprovalEvent(event: ApprovalEvent): void {
    this.#broadcastAll(event);
    if (event.type === "approval") {
      const card = event.interaction;
      void this.#options.notifier("Claude 待审批", `${card.toolName}: ${card.prompt}`.slice(0, 120));
    }
  }

  /** 优雅退出：停收新连接、关 WS、abort 活跃 run 并等 settle。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    for (const timer of this.#watchRetryTimers.values()) clearTimeout(timer);
    this.#watchRetryTimers.clear();
    for (const socket of this.#clients.keys()) socket.close(1001, "server shutdown");
    const completions = [...this.#activeRuns.values()].map((handle) => handle.completion);
    for (const runId of this.#activeRuns.keys()) this.#options.runner.abort(runId);
    await Promise.allSettled(completions);
    this.#wss.close();
    await new Promise<void>((resolvePromise) => this.#http.close(() => resolvePromise()));
  }

  // -- 鉴权 -------------------------------------------------------------------

  #tokenOk(candidate: string | undefined): boolean {
    if (candidate === undefined || candidate === "") return false;
    return timingSafeEqual(sha256(candidate), this.#tokenHash);
  }

  #bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return false;
    return this.#tokenOk(header.slice("Bearer ".length).trim());
  }

  // -- HTTP -------------------------------------------------------------------

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;

    // 配对路由在下发 token，必须在通用 CORS 处理之前独立分支：
    // 既不能被 Access-Control-Allow-Origin:* 暴露给跨站读取，也复用 loopback+Host+Origin 门禁。
    if (path === "/api/pair-info" || path === "/api/pair-qr.svg") {
      await this.#handlePair(req, res, path);
      return;
    }

    if (path.startsWith("/api/")) {
      // CORS：iOS 壳（capacitor://localhost）与非同源部署的前端需要跨域访问；
      // 鉴权靠 Bearer token 且不依赖 Cookie，Allow-Origin 放开是安全的。
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400",
        });
        res.end();
        return;
      }
      if (!this.#bearerOk(req)) {
        this.#json(res, 401, { error: "unauthorized" });
        return;
      }
      await this.#handleApi(req, res, url);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await this.#serveStatic(path, res);
      return;
    }
    this.#json(res, 404, { error: "not_found" });
  }

  async #handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { method } = req;
    const path = url.pathname;

    if (method === "GET" && path === "/api/health") {
      this.#json(res, 200, {
        ok: true,
        service: "pi-remote-claude",
        instanceId: this.#instanceId,
        version: this.#options.version,
        claudeCliVersion: this.#options.claudeCliVersion(),
      });
      return;
    }

    if (method === "GET" && path === "/api/sessions") {
      await this.#handleListSessions(res, url);
      return;
    }

    if (method === "GET" && path === "/api/models") {
      this.#json(res, 200, await this.#readModelCatalog());
      return;
    }

    if (method === "POST" && path === "/api/sessions") {
      await this.#handleCreateSession(req, res);
      return;
    }

    const abortMatch = /^\/api\/sessions\/([^/]+)\/abort$/.exec(path);
    if (abortMatch !== null && method === "POST") {
      this.#handleAbort(res, decodeURIComponent(abortMatch[1] ?? ""));
      return;
    }

    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
    if (messagesMatch !== null) {
      const sessionId = decodeURIComponent(messagesMatch[1] ?? "");
      if (method === "GET") {
        await this.#handleGetMessages(res, url, sessionId);
        return;
      }
      if (method === "POST") {
        await this.#handlePostMessage(req, res, sessionId);
        return;
      }
    }

    if (method === "POST" && path === "/api/upload") {
      // 会话尚未创建时的附件上传（新建会话先传附件、路径随首条消息一起发）
      await this.#saveUpload(req, res, url, "new");
      return;
    }
    const uploadMatch = /^\/api\/sessions\/([^/]+)\/upload$/.exec(path);
    if (uploadMatch !== null && method === "POST") {
      await this.#handleUpload(req, res, url, decodeURIComponent(uploadMatch[1] ?? ""));
      return;
    }

    const decisionMatch = /^\/api\/interactions\/([^/]+)\/decision$/.exec(path);
    if (decisionMatch !== null && method === "POST") {
      await this.#handleDecision(req, res, decodeURIComponent(decisionMatch[1] ?? ""));
      return;
    }

    this.#json(res, 404, { error: "not_found" });
  }

  /**
   * loopback-only 配对端点：pair-info 返回候选地址与 token，pair-qr.svg 返回二维码。
   *
   * 门禁（逐层 fail-closed）：
   *  1. socket 源地址必须是 loopback；
   *  2. 不得带任何代理特征头（隧道/反代会把公网请求伪装成 loopback）；
   *  3. Host 必须是 127.0.0.1 / [::1] / localhost，且端口必须等于实际监听端口
   *     —— 挡住 DNS rebinding（evil.com 解析到 127.0.0.1 仍带自己的 Host）；
   *  4. 若带 Origin（浏览器跨站请求），必须与本机服务 Host 严格同源
   *     —— 恶意 Origin 或 "null" 一律 403，防跨站读取 token。
   * 无 Origin 的原生客户端（iOS 壳）放行。
   */
  async #handlePair(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!this.#pairRequestAllowed(req)) {
      this.#json(res, 403, { error: "loopback_only" });
      return;
    }
    if (req.method !== "GET") {
      this.#json(res, 404, { error: "not_found" });
      return;
    }
    if (path === "/api/pair-info") {
      this.#json(res, 200, this.pairInfo);
      return;
    }
    const svg = await QRCode.toString(pairPayload(this.pairInfo), { type: "svg" });
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
    res.end(svg);
  }

  #pairRequestAllowed(req: IncomingMessage): boolean {
    if (!isLoopbackAddress(req.socket.remoteAddress) || looksProxied(req.headers)) return false;
    const host = req.headers.host;
    if (host === undefined || !this.#pairHostAllowed(host)) return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true; // 原生客户端无 Origin
    return this.#sameOrigin(origin, host);
  }

  /** Host 仅允许本机名，且有效端口必须是实际监听端口。 */
  #pairHostAllowed(host: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(`http://${host}`);
    } catch {
      return false;
    }
    const name = parsed.hostname;
    if (name !== "127.0.0.1" && name !== "localhost" && name !== "[::1]") return false;
    return parsed.username === "" && parsed.password === "" && parsed.pathname === "/"
      && parsed.search === "" && parsed.hash === "" && Number(parsed.port || "80") === this.#pairPort;
  }

  #sameOrigin(origin: string, host: string): boolean {
    try {
      return new URL(origin).origin === new URL(`http://${host}`).origin;
    } catch {
      return false; // 含 "null" 或缺省 Origin 的非法值
    }
  }

  async #handleListSessions(res: ServerResponse, url: URL): Promise<void> {
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const all = await listSessions(this.#options.config.projectsDir);
    const sessions = all.slice(offset, offset + limit).map((summary) => ({
      ...summary,
      status: this.#options.tracker.getStatus(summary.sessionId),
    }));
    this.#json(res, 200, { sessions, total: all.length });
  }

  async #readModelCatalog(): Promise<ModelCatalog> {
    return this.#options.modelCatalog?.() ?? readModelCatalog();
  }

  async #knownCwds(): Promise<Set<string>> {
    const sessions = await listSessions(this.#options.config.projectsDir);
    return new Set(sessions.map((session) => session.cwd).filter((cwd) => cwd !== ""));
  }

  async #validateModel(
    res: ServerResponse,
    value: unknown,
  ): Promise<string | undefined | false> {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      this.#json(res, 400, { error: "invalid_model" });
      return false;
    }
    const model = value.trim();
    if (!isKnownModel(await this.#readModelCatalog(), model)) {
      this.#json(res, 400, { error: "unknown_model" });
      return false;
    }
    return model;
  }

  /** 校验 permissionMode 白名单；省略 -> undefined，非法 -> 400 false。 */
  #validatePermissionMode(res: ServerResponse, value: unknown): PermissionMode | undefined | false {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !VALID_PERMISSION_MODES.has(value)) {
      this.#json(res, 400, { error: "invalid_permission_mode" });
      return false;
    }
    return value as PermissionMode;
  }

  async #handleCreateSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJsonBody(req, res);
    if (body === undefined) return;
    const { cwd: cwdValue, text: textValue, model: modelValue, permissionMode: permModeValue } = body as Record<string, unknown>;
    if (typeof cwdValue !== "string" || cwdValue.trim() === "") {
      this.#json(res, 400, { error: "invalid_cwd" });
      return;
    }
    if (typeof textValue !== "string" || textValue.trim() === "") {
      this.#json(res, 400, { error: "invalid_text" });
      return;
    }
    const cwd = cwdValue.trim();
    if (!(await this.#knownCwds()).has(cwd)) {
      this.#json(res, 400, { error: "unknown_cwd" });
      return;
    }
    const model = await this.#validateModel(res, modelValue);
    if (model === false) return;
    const permissionMode = this.#validatePermissionMode(res, permModeValue);
    if (permissionMode === false) return;

    const sessionId = randomUUID();
    let handle: TurnHandle;
    try {
      handle = this.#options.runner.startTurn({
        sessionId,
        cwd,
        text: textValue,
        newSession: true,
        ...(model === undefined ? {} : { model }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
      });
    } catch (error) {
      if (error instanceof NotIdleError) {
        this.#json(res, 409, { error: "not_idle", status: this.#options.tracker.getStatus(sessionId) });
        return;
      }
      if (error instanceof TypeError) {
        this.#json(res, 400, { error: "invalid_text" });
        return;
      }
      throw error;
    }
    this.#newSessions.add(sessionId);
    this.#activeRuns.set(handle.runId, handle);
    void this.#pumpRun(sessionId, textValue, handle);
    this.#json(res, 202, { sessionId, runId: handle.runId });
  }

  #handleAbort(res: ServerResponse, sessionId: string): void {
    if (!isUuid(sessionId)) {
      this.#json(res, 400, { error: "invalid_session_id" });
      return;
    }
    const runId = this.#options.runner.activeRunId(sessionId);
    if (runId === undefined) {
      this.#json(res, 200, { runId: null, status: "idle" });
      return;
    }
    this.#options.runner.abort(runId);
    this.#json(res, 200, { runId, status: "aborted" });
  }

  async #handleGetMessages(res: ServerResponse, url: URL, sessionId: string): Promise<void> {
    let file: string;
    try {
      file = await resolveSessionFile(this.#options.config.projectsDir, sessionId);
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "session_not_found" });
        return;
      }
      throw error;
    }
    const limit = clampInt(url.searchParams.get("limit"), MESSAGES_LIMIT_DEFAULT, 1, MESSAGES_LIMIT_MAX);
    const beforeSeqRaw = url.searchParams.get("beforeSeq");
    const beforeSeq = beforeSeqRaw === null || beforeSeqRaw === "" ? undefined : Number(beforeSeqRaw);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      this.#json(res, 400, { error: "invalid_before_seq" });
      return;
    }
    try {
      const page = beforeSeq === undefined ? await readTail(file, limit) : await readBefore(file, beforeSeq, limit);
      this.#json(res, 200, { messages: page.messages, firstSeq: page.firstSeq, hasMore: page.hasMore });
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "session_not_found" });
        return;
      }
      throw error;
    }
  }

  async #handlePostMessage(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const body = await this.#readJsonBody(req, res);
    if (body === undefined) return;
    const text = (body as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim() === "") {
      this.#json(res, 400, { error: "invalid_text" });
      return;
    }
    const model = await this.#validateModel(res, (body as { model?: unknown }).model);
    if (model === false) return;
    const permissionMode = this.#validatePermissionMode(res, (body as { permissionMode?: unknown }).permissionMode);
    if (permissionMode === false) return;
    let file: string;
    try {
      file = await resolveSessionFile(this.#options.config.projectsDir, sessionId);
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "session_not_found" });
        return;
      }
      throw error;
    }
    const cwd = (await readSessionCwd(file)) || homedir();
    let handle: TurnHandle;
    try {
      handle = this.#options.runner.startTurn({
        sessionId,
        cwd,
        text,
        ...(model === undefined ? {} : { model }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
      });
    } catch (error) {
      if (error instanceof NotIdleError) {
        this.#json(res, 409, { error: "not_idle", status: this.#options.tracker.getStatus(sessionId) });
        return;
      }
      if (error instanceof TypeError) {
        this.#json(res, 400, { error: "invalid_text" });
        return;
      }
      throw error;
    }
    this.#activeRuns.set(handle.runId, handle);
    void this.#pumpRun(sessionId, text, handle);
    this.#json(res, 202, { runId: handle.runId });
  }

  /** 消费 run 事件流：run 帧 → 订阅者；终态 → notifier。message 帧走 watcher，不在此转发。 */
  async #pumpRun(sessionId: string, text: string, handle: TurnHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (event.type === "worker") {
          if (this.#newSessions.has(sessionId) && event.event.type === "session") {
            void this.#activateNewSessionWatch(sessionId);
          }
          continue;
        }
        const frame: Record<string, unknown> = {
          type: "run",
          sessionId,
          runId: event.runId,
          state: event.state,
        };
        if (event.error !== undefined) frame.error = event.error;
        if (event.permissionMode !== undefined) frame.permissionMode = event.permissionMode;
        this.#broadcastToSubscribers(sessionId, frame);
        if (event.state === "done") {
          void this.#options.notifier("Claude 已完成", snippet(text));
        } else if (event.state === "error") {
          void this.#options.notifier("Claude 运行出错", `${event.error ?? "unknown"} · ${snippet(text)}`);
        }
      }
    } catch (error) {
      console.error(`run event pump failed (session ${sessionId}):`, error);
    } finally {
      this.#activeRuns.delete(handle.runId);
      if (this.#newSessions.has(sessionId)) void this.#activateNewSessionWatch(sessionId);
    }
  }

  /** 上传附件：raw body + ?filename=，按 sessionId 分目录落盘，返回 Mac 上的绝对路径。 */
  async #handleUpload(req: IncomingMessage, res: ServerResponse, url: URL, sessionId: string): Promise<void> {
    try {
      await resolveSessionFile(this.#options.config.projectsDir, sessionId);
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "session_not_found" });
        return;
      }
      throw error;
    }
    await this.#saveUpload(req, res, url, sessionId);
  }

  /** 附件落盘公共逻辑：raw body + ?filename=，存入 uploadsDir/<subdir>/，返回绝对路径。 */
  async #saveUpload(req: IncomingMessage, res: ServerResponse, url: URL, subdir: string): Promise<void> {
    // 文件名只取 basename 并过滤路径分隔符/控制字符，防目录穿越
    const rawName = url.searchParams.get("filename") ?? "";
    const safeName = (basename(rawName).replace(/[\/\\]/g, "_").replace(/[^\P{C}]/gu, "").trim() || "file");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > UPLOAD_LIMIT_BYTES) {
        this.#json(res, 413, { error: "payload_too_large" });
        return;
      }
      chunks.push(chunk as Buffer);
    }
    if (size === 0) {
      this.#json(res, 400, { error: "empty_file" });
      return;
    }
    const dir = join(this.#options.config.uploadsDir, subdir);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${safeName}`);
    await writeFile(file, Buffer.concat(chunks));
    this.#json(res, 200, { path: file, name: safeName, sizeBytes: size });
  }

  async #handleDecision(req: IncomingMessage, res: ServerResponse, interactionId: string): Promise<void> {
    const body = await this.#readJsonBody(req, res);
    if (body === undefined) return;
    const outcome = this.#options.approvals.decide(interactionId, body as never);
    switch (outcome.status) {
      case "allowed":
      case "denied":
      case "answered":
        this.#json(res, 200, { status: outcome.status });
        return;
      case "not_found":
        this.#json(res, 404, { error: "not_found" });
        return;
      case "already_resolved":
        this.#json(res, 409, { error: "already_resolved" });
        return;
      case "invalid":
        this.#json(res, 400, { error: "invalid", message: outcome.message });
        return;
    }
  }

  async #readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > BODY_LIMIT_BYTES) {
        this.#json(res, 413, { error: "payload_too_large" });
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
      this.#json(res, 400, { error: "invalid_json" });
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null) {
        this.#json(res, 400, { error: "invalid_json" });
        return undefined;
      }
      return parsed;
    } catch {
      this.#json(res, 400, { error: "invalid_json" });
      return undefined;
    }
  }

  #json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  // -- 静态托管 ---------------------------------------------------------------

  async #serveStatic(path: string, res: ServerResponse): Promise<void> {
    const webRoot = this.#options.webRoot;
    if (webRoot === undefined) {
      // 独立后端不托管前端：任何非 API GET/HEAD 都是 404。
      this.#json(res, 404, { error: "not_found" });
      return;
    }
    const clean = normalize(decodeURIComponent(path)).replaceAll("\\", "/");
    const relative = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
    const file = resolve(webRoot, relative);
    if (file !== webRoot && !file.startsWith(webRoot + sep)) {
      this.#json(res, 404, { error: "not_found" });
      return;
    }
    try {
      const stats = await stat(file);
      if (!stats.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        "Content-Length": stats.size,
        "Cache-Control": "no-store",
      });
      createReadStream(file).pipe(res);
    } catch {
      this.#json(res, 404, { error: "not_found" });
    }
  }

  // -- WebSocket --------------------------------------------------------------

  #handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname !== "/ws" || !this.#tokenOk(url.searchParams.get("token") ?? undefined)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"error":"unauthorized"}');
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#onConnection(ws);
    });
  }

  #onConnection(ws: WebSocket): void {
    const state: ClientState = { subs: new Set(), alive: true };
    this.#clients.set(ws, state);
    ws.on("pong", () => {
      state.alive = true;
    });
    ws.on("message", (data) => {
      void this.#onClientFrame(state, data.toString());
    });
    ws.on("close", () => {
      this.#clients.delete(ws);
      for (const sessionId of state.subs) this.#releaseWatch(sessionId);
    });
    ws.on("error", () => ws.terminate());
  }

  async #onClientFrame(state: ClientState, raw: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const { type, sessionId } = frame as { type?: unknown; sessionId?: unknown };
    if (typeof sessionId !== "string" || sessionId === "") return;

    if (type === "subscribe") {
      if (state.subs.has(sessionId)) return;
      if (sessionId !== "*") {
        try {
          await this.#acquireWatch(sessionId);
          this.#newSessions.delete(sessionId);
        } catch (error) {
          if (isEnoent(error) && this.#newSessions.has(sessionId)) {
            state.subs.add(sessionId);
            void this.#activateNewSessionWatch(sessionId);
            return;
          }
          if (isEnoent(error)) return; // 未知会话：静默忽略（HTTP 侧已 404）
          console.warn(`watch(${sessionId}) failed:`, error);
          return;
        }
      }
      state.subs.add(sessionId);
      return;
    }
    if (type === "unsubscribe") {
      if (!state.subs.delete(sessionId)) return;
      if (sessionId !== "*") this.#releaseWatch(sessionId);
    }
  }

  async #acquireWatch(sessionId: string): Promise<void> {
    if ((this.#watchRefs.get(sessionId) ?? 0) === 0) await this.#options.watcher.watch(sessionId);
    // watch() 是 async：并发 subscribe 会都走到这里，await 后重读计数防覆盖
    this.#watchRefs.set(sessionId, (this.#watchRefs.get(sessionId) ?? 0) + 1);
  }

  async #activateNewSessionWatch(sessionId: string): Promise<void> {
    if (this.#watchActivations.has(sessionId)) return;
    this.#watchActivations.add(sessionId);
    try {
      await this.#options.watcher.watch(sessionId);
      if (!this.#options.watcher.watched.includes(sessionId)) return;
      const refs = [...this.#clients.values()].filter((state) => state.subs.has(sessionId)).length;
      if (refs > 0) this.#watchRefs.set(sessionId, refs);
      else this.#options.watcher.unwatch(sessionId);
      this.#newSessions.delete(sessionId);
      const retry = this.#watchRetryTimers.get(sessionId);
      if (retry !== undefined) clearTimeout(retry);
      this.#watchRetryTimers.delete(sessionId);
      if (refs > 0) this.#broadcastToSubscribers(sessionId, { type: "resync", sessionId });
    } catch (error) {
      if (isEnoent(error)) this.#scheduleNewSessionWatchRetry(sessionId);
      else console.warn(`watch(${sessionId}) failed:`, error);
    } finally {
      this.#watchActivations.delete(sessionId);
    }
  }

  #scheduleNewSessionWatchRetry(sessionId: string): void {
    if (
      this.#closed
      || !this.#newSessions.has(sessionId)
      || this.#watchRetryTimers.has(sessionId)
      || ![...this.#clients.values()].some((state) => state.subs.has(sessionId))
    ) return;
    const timer = setTimeout(() => {
      this.#watchRetryTimers.delete(sessionId);
      void this.#activateNewSessionWatch(sessionId);
    }, 100);
    timer.unref();
    this.#watchRetryTimers.set(sessionId, timer);
  }

  #releaseWatch(sessionId: string): void {
    const refs = this.#watchRefs.get(sessionId) ?? 0;
    if (refs <= 1) {
      this.#watchRefs.delete(sessionId);
      this.#options.watcher.unwatch(sessionId);
      const retry = this.#watchRetryTimers.get(sessionId);
      if (retry !== undefined) clearTimeout(retry);
      this.#watchRetryTimers.delete(sessionId);
      return;
    }
    this.#watchRefs.set(sessionId, refs - 1);
  }

  #pingClients(): void {
    for (const [ws, state] of this.#clients) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }

  // -- 事件接线与广播 ---------------------------------------------------------

  #wireEvents(): void {
    const { watcher, tracker } = this.#options;
    watcher.on("message", (event) => {
      this.#broadcastToSubscribers(event.sessionId, {
        type: "message",
        sessionId: event.sessionId,
        message: event.message,
      });
    });
    watcher.on("resync", (event) => {
      this.#broadcastToSubscribers(event.sessionId, { type: "resync", sessionId: event.sessionId });
    });
    watcher.on("write", (event) => {
      tracker.noteWrite(event.sessionId, event.at);
    });
    watcher.on("error", (event) => {
      console.warn(`watcher error (session ${event.sessionId}):`, event.error);
    });
    tracker.on("change", (event) => {
      this.#broadcast(
        { type: "status", sessionId: event.sessionId, status: event.status },
        (subs) => subs.has(event.sessionId) || subs.has("*"),
      );
    });
  }

  #broadcastToSubscribers(sessionId: string, frame: unknown): void {
    this.#broadcast(frame, (subs) => subs.has(sessionId));
  }

  #broadcastAll(frame: unknown): void {
    this.#broadcast(frame, () => true);
  }

  #broadcast(frame: unknown, match: (subs: Set<string>) => boolean): void {
    const payload = JSON.stringify(frame);
    for (const [ws, state] of this.#clients) {
      if (ws.readyState !== WebSocket.OPEN || !match(state.subs)) continue;
      ws.send(payload);
    }
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
