"use strict";

/**
 * 通过 PI-Desktop 宿主的 pi.net.websocket 主动连到 pi-remote Relay 的 /ws/agent，扮演 Mac Agent。
 *
 * 与 src/agent/agent-client.ts 的行为对齐：
 *   - AGENT_TOKEN 只放在 Authorization 头里，绝不进 URL（宿主审计日志只记 URL）
 *   - 连上后先发 hello（role=agent），收到 hello_ack 才算连上
 *   - Relay 的 request 交给 handler，response 原样带回 requestId / sessionId
 *   - 心跳：宿主不暴露 WebSocket 级 ping，所以发协议层 ping 帧；超过两个周期没有任何帧就判定断线
 *   - 断线后指数退避重连；认证失败（401）或 Agent 名额被占用时退到最长间隔
 * 宿主限制：每个插件最多 4 个 socket、单帧 ≤ 1 MiB；这里同一时间只持有一个 socket，
 * 换连接前先关掉旧的，所有出站帧都经过 encodeFrame 的体积检查。
 */

const { Backoff } = require("./backoff.js");
const {
  parseFrame,
  helloFrame,
  responseFrame,
  sessionEventFrame,
  pingFrame,
  pongFrame,
  encodeFrame,
} = require("./frames.js");
const { errorMessage, errorCode } = require("./text.js");

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 25_000;
const MAX_EARLY_EVENTS = 64;

class RelayConnection {
  /**
   * @param {{
   *   pi: any,
   *   handler: (request: any) => Promise<{ ok: boolean, data?: unknown, error?: { code: string, message: string } }>,
   *   onStatus?: (status: { state: string, message: string }) => void,
   *   logger?: (message: string) => void,
   *   backoff?: Backoff,
   *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval },
   *   now?: () => number,
   *   connectTimeoutMs?: number, helloTimeoutMs?: number, heartbeatMs?: number,
   * }} options
   */
  constructor(options) {
    this.pi = options.pi;
    this.handler = options.handler;
    this.onStatus = options.onStatus ?? (() => {});
    this.logger = options.logger ?? (() => {});
    this.backoff = options.backoff ?? new Backoff();
    this.timers = options.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    this.now = options.now ?? (() => Date.now());
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

    this.config = null;
    this.running = false;
    this.generation = 0;
    this.socketId = null;
    this.registered = false;
    this.lastFrameAt = 0;
    this.retryTimer = null;
    this.helloTimer = null;
    this.heartbeatTimer = null;
    /** 连接握手完成之前宿主可能先送达的帧事件，按 socketId 暂存。 */
    this.earlyEvents = [];
    this.status = { state: "idle", message: "未启动" };

    this.listeners = {
      "net:websocket:message": (event) => this.onSocketEvent("message", event),
      "net:websocket:close": (event) => this.onSocketEvent("close", event),
      "net:websocket:error": (event) => this.onSocketEvent("error", event),
    };
    this.subscribed = false;
  }

  /** @param {{ url: string, token: string, deviceId: string, label?: string, appVersion?: string }} config */
  start(config) {
    this.config = config;
    this.running = true;
    this.subscribe();
    this.backoff.reset();
    this.clearRetry();
    void this.connect();
  }

  async stop(reason = "已停止") {
    this.running = false;
    this.generation += 1;
    this.clearRetry();
    this.clearSessionTimers();
    this.registered = false;
    const socketId = this.socketId;
    this.socketId = null;
    this.earlyEvents = [];
    this.unsubscribe();
    this.setStatus("stopped", reason);
    if (socketId) await this.closeSocket(socketId, 1000, "plugin stopped");
  }

  get connected() {
    return this.registered && this.socketId !== null;
  }

  subscribe() {
    if (this.subscribed) return;
    for (const [name, listener] of Object.entries(this.listeners)) this.pi.events.on(name, listener);
    this.subscribed = true;
  }

  unsubscribe() {
    if (!this.subscribed) return;
    for (const [name, listener] of Object.entries(this.listeners)) this.pi.events.off(name, listener);
    this.subscribed = false;
  }

  setStatus(state, message) {
    this.status = { state, message, at: this.now() };
    try { this.onStatus(this.status); } catch { /* 状态回调失败不影响连接 */ }
  }

  async connect() {
    if (!this.running || !this.config) return;
    const generation = ++this.generation;
    this.registered = false;
    this.earlyEvents = [];
    this.setStatus("connecting", "正在连接 Relay…");
    let socketId;
    try {
      const result = await this.pi.net.websocket.connect({
        url: this.config.url,
        headers: { Authorization: `Bearer ${this.config.token}` },
        timeoutMs: this.connectTimeoutMs,
      });
      socketId = typeof result?.socketId === "string" ? result.socketId : null;
      if (!socketId) throw new Error("宿主没有返回 socketId");
    } catch (error) {
      if (generation !== this.generation || !this.running) return;
      this.handleConnectFailure(error);
      return;
    }
    if (generation !== this.generation || !this.running) {
      await this.closeSocket(socketId, 1000, "superseded");
      return;
    }
    this.socketId = socketId;
    this.lastFrameAt = this.now();
    const early = this.earlyEvents.filter((entry) => entry.event?.socketId === socketId);
    this.earlyEvents = [];
    const helloSent = await this.send(helloFrame(this.config.deviceId, this.config.label, this.config.appVersion));
    if (!helloSent) {
      if (this.socketId === socketId) this.dropSocket("发送 hello 失败");
      return;
    }
    this.helloTimer = this.timers.setTimeout(() => {
      if (generation === this.generation && !this.registered) this.dropSocket("Relay 没有回应 hello");
    }, this.helloTimeoutMs);
    this.helloTimer?.unref?.();
    this.heartbeatTimer = this.timers.setInterval(() => this.heartbeat(generation), this.heartbeatMs);
    this.heartbeatTimer?.unref?.();
    for (const entry of early) this.onSocketEvent(entry.kind, entry.event);
  }

  handleConnectFailure(error) {
    const code = errorCode(error);
    const message = errorMessage(error);
    if (code === "PERMISSION_DENIED") {
      // 宿主拒绝出站：多半是没授予 net.websocket / net.anyHost。重试没有意义，等用户改权限或设置。
      this.setStatus("error", "PI-Desktop 拒绝连接该地址：请确认已授予 net.websocket 与 net.anyHost 权限");
      this.running = false;
      return;
    }
    if (/\b401\b|unauthori[sz]ed/i.test(message)) {
      this.backoff.penalize();
      this.scheduleReconnect("Relay 拒绝了 AGENT_TOKEN（401），请检查插件设置里的 AGENT_TOKEN");
      return;
    }
    if (code === "LIMIT_EXCEEDED") {
      this.scheduleReconnect("插件的 WebSocket 数量已达上限，稍后重试");
      return;
    }
    this.scheduleReconnect(`连接失败：${message}`);
  }

  scheduleReconnect(reason) {
    if (!this.running) return;
    this.clearRetry();
    const delay = this.backoff.next();
    this.setStatus("waiting", `${reason}；${Math.round(delay / 1000)} 秒后重连`);
    this.logger(`relay reconnect in ${delay}ms: ${reason}`);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer?.unref?.();
  }

  /** 当前连接作废：关 socket、清计时器，然后按退避重连。 */
  dropSocket(reason) {
    const socketId = this.socketId;
    this.socketId = null;
    this.registered = false;
    this.generation += 1;
    this.clearSessionTimers();
    if (socketId) void this.closeSocket(socketId, 4000, "reconnect");
    this.scheduleReconnect(reason);
  }

  onSocketEvent(kind, event) {
    if (!this.running || !event || typeof event.socketId !== "string") return;
    if (event.socketId !== this.socketId) {
      // connect() 还没返回时宿主可能已经送来了帧，先暂存
      if (this.socketId === null && this.earlyEvents.length < MAX_EARLY_EVENTS) this.earlyEvents.push({ kind, event });
      return;
    }
    if (kind === "message") {
      this.lastFrameAt = this.now();
      this.onMessage(event.data);
      return;
    }
    if (kind === "close") {
      const code = typeof event.code === "number" ? event.code : 0;
      const reason = typeof event.reason === "string" && event.reason ? event.reason : "连接已关闭";
      if (code === 1008 && /agent already connected/i.test(reason)) this.backoff.penalize();
      this.socketId = null;
      this.dropSocket(`Relay 连接已断开（${code} ${reason}）`);
      return;
    }
    if (kind === "error") {
      this.logger(`relay socket error: ${event.code ?? ""} ${event.message ?? ""}`);
      // 宿主随后会送 close；OVERSIZED_FRAME 等致命错误之后若没有 close，心跳会兜底。
    }
  }

  onMessage(data) {
    const frame = parseFrame(data);
    if (!frame) {
      this.logger("relay sent an invalid frame");
      return;
    }
    switch (frame.type) {
      case "hello_ack":
        if (frame.payload?.role === "agent") {
          this.registered = true;
          this.backoff.reset();
          if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
          this.helloTimer = null;
          this.setStatus("connected", "已连接 Relay，手机可以控制 Pi Desktop 会话");
        }
        return;
      case "ping":
        void this.send(pongFrame());
        return;
      case "pong":
        return;
      case "request":
        if (this.registered) void this.handleRequest(frame);
        return;
      case "error": {
        const code = frame.payload?.code;
        if (code === "agent_already_connected") {
          this.backoff.penalize();
          this.setStatus("waiting", "Relay 上已有另一个 Mac Agent 在线（同一个 Relay 只允许一个 Agent）");
        } else if (frame.payload?.message) {
          this.logger(`relay error: ${code} ${frame.payload.message}`);
        }
        return;
      }
      default:
        return;
    }
  }

  async handleRequest(request) {
    let result;
    try {
      result = await this.handler(request);
    } catch (error) {
      result = { ok: false, error: { code: "internal_error", message: errorMessage(error) } };
    }
    await this.send(responseFrame(request, result, this.config?.deviceId));
  }

  /** 推送会话事件给订阅了该会话的手机；未连上时直接丢弃（手机会在重连后自己刷新）。 */
  sendSessionEvent(sessionId, event) {
    if (!this.connected) return Promise.resolve(false);
    return this.send(sessionEventFrame(sessionId, event, this.config?.deviceId));
  }

  async send(frame) {
    const socketId = this.socketId;
    if (!socketId) return false;
    const text = encodeFrame(frame);
    if (text === null) {
      this.logger(`dropped oversized ${frame.type} frame`);
      return false;
    }
    try {
      await this.pi.net.websocket.send({ socketId, data: text });
      return true;
    } catch (error) {
      this.logger(`relay send failed: ${errorCode(error) ?? ""} ${errorMessage(error)}`);
      if (socketId === this.socketId && errorCode(error) === "NOT_FOUND") this.dropSocket("连接已失效");
      return false;
    }
  }

  heartbeat(generation) {
    if (generation !== this.generation || !this.socketId) return;
    if (this.now() - this.lastFrameAt > this.heartbeatMs * 2) {
      this.dropSocket("Relay 长时间没有响应");
      return;
    }
    if (this.registered) void this.send(pingFrame());
  }

  async closeSocket(socketId, code, reason) {
    try {
      await this.pi.net.websocket.close({ socketId, code, reason });
    } catch {
      // 宿主已经回收了这个 socket
    }
  }

  clearRetry() {
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  clearSessionTimers() {
    if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
    if (this.heartbeatTimer) this.timers.clearInterval(this.heartbeatTimer);
    this.helloTimer = null;
    this.heartbeatTimer = null;
  }
}

module.exports = { RelayConnection };
