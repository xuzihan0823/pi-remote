"use strict";

/**
 * 把各部分接起来：读取插件设置 → 能力探测 → 连接 Relay → 处理请求 / 推送会话事件。
 * 由 main.js 的常驻服务（contributes.services: relay）启动和停止。
 */

const os = require("node:os");
const { DesktopGateway } = require("./desktop.js");
const { createRequestHandler, publicSessionId } = require("./handler.js");
const { RelayConnection } = require("./relay-connection.js");
const { SessionWatcher } = require("./watcher.js");
const { TimelineService } = require("./timeline.js");
const { normalizeRelayUrl, validateAgentToken } = require("./transport.js");
const { errorMessage } = require("./text.js");

const PLUGIN_VERSION = "0.1.0";

/** 设置项 → 运行配置。返回 { ok, config } 或 { ok: false, error }（中文，可直接展示）。 */
function readConfig(settings, hostname = os.hostname()) {
  const record = settings && typeof settings === "object" ? settings : {};
  if (record.enabled === false) return { ok: false, disabled: true, error: "已在插件设置中关闭连接" };
  const url = normalizeRelayUrl(record.relayUrl);
  if (!url.ok) return { ok: false, error: url.error };
  const token = validateAgentToken(record.agentToken);
  if (!token.ok) return { ok: false, error: token.error };
  const label = String(record.deviceName ?? "").trim().replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64)
    || `Pi Desktop @ ${String(hostname || "Mac").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 48)}`;
  const deviceId = `pi-desktop:${label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "mac"}`;
  return { ok: true, config: { url: url.url, token: token.token, deviceId, label, appVersion: `pi-desktop-bridge/${PLUGIN_VERSION}` } };
}

class Bridge {
  constructor(pi, options = {}) {
    this.pi = pi;
    this.logger = options.logger ?? ((message) => { try { console.log(`[pi-remote bridge] ${message}`); } catch { /* ignore */ } });
    this.desktop = new DesktopGateway(pi);
    this.relay = null;
    this.watcher = null;
    this.status = { state: "idle", message: "未启动" };
    this.started = false;
    this.onTurnEnded = (payload) => this.watcher?.onTurnEnded(payload);
    this.onSettingsChanged = () => { void this.restart(); };
    this.options = options;
    /** 设置连续变化时串行地重建连接，避免两个 RelayConnection 同时存在。 */
    this.restartChain = Promise.resolve();
  }

  /** 宿主服务 start 回调给的 log（写入 PI-Desktop 应用日志），优先于 console。 */
  setLogger(logger) {
    if (typeof logger === "function") this.logger = (message) => { try { logger(`[pi-remote bridge] ${message}`); } catch { /* ignore */ } };
  }

  setStatus(state, message) {
    this.status = { state, message, at: Date.now() };
  }

  /** 服务启动：只做同步准备并在后台连接，满足宿主 5 秒的 start 预算。 */
  start() {
    if (this.started) return;
    this.started = true;
    this.pi.events.on("session:turnEnded", this.onTurnEnded);
    this.pi.events.on("plugin:settingsChanged", this.onSettingsChanged);
    void this.restart();
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    this.pi.events.off("session:turnEnded", this.onTurnEnded);
    this.pi.events.off("plugin:settingsChanged", this.onSettingsChanged);
    this.watcher?.stop();
    this.watcher = null;
    const relay = this.relay;
    this.relay = null;
    if (relay) await relay.stop("插件已停止");
    this.setStatus("stopped", "插件已停止");
  }

  restart() {
    this.restartChain = this.restartChain.then(() => this.restartNow()).catch((error) => {
      this.setStatus("error", `重新连接失败：${errorMessage(error)}`);
    });
    return this.restartChain;
  }

  async restartNow() {
    if (!this.started) return;
    const previous = this.relay;
    this.relay = null;
    this.watcher?.stop();
    this.watcher = null;
    if (previous) await previous.stop("正在应用新设置");
    if (!this.started) return;

    let settings;
    try {
      settings = await this.pi.plugin.getSettings();
    } catch (error) {
      this.setStatus("error", `读取插件设置失败：${errorMessage(error)}`);
      return;
    }
    const parsed = readConfig(settings, this.options.hostname);
    if (!parsed.ok) {
      this.setStatus(parsed.disabled ? "disabled" : "needs_config", parsed.error);
      return;
    }
    await this.desktop.refresh();
    if (!this.desktop.ready) {
      // 仍然连上 Relay：手机能看到明确的错误原因，而不是“Mac 不在线”。
      const reason = this.desktop.catalog ? `缺少 ${this.desktop.missingRequired().join("、")}` : this.desktop.catalogError;
      this.logger(`desktop control unavailable: ${reason}`);
    }

    const relay = new RelayConnection({
      pi: this.pi,
      handler: (request) => handler(request),
      logger: this.logger,
      onStatus: (status) => {
        if (this.relay !== relay) return;
        const suffix = this.desktop.ready ? "" : "（Pi Desktop 控制能力不可用，见日志）";
        this.setStatus(status.state, `${status.message}${status.state === "connected" ? suffix : ""}`);
      },
      ...(this.options.relayOptions ?? {}),
    });
    const watcher = new SessionWatcher({
      readStatus: async (nativeId) => {
        const response = await this.desktop.invoke("agent/getStatus", [nativeId]);
        return response && typeof response === "object" ? (response.status ?? response) : null;
      },
      emit: (nativeId, event) => {
        const sessionId = publicSessionId(nativeId);
        void relay.sendSessionEvent(sessionId, { ...event, sessionId });
      },
      logger: this.logger,
      ...(this.options.watcherOptions ?? {}),
    });
    const handler = createRequestHandler({
      desktop: this.desktop,
      watcher,
      timeline: new TimelineService(this.desktop),
      logger: this.logger,
    });
    this.relay = relay;
    this.watcher = watcher;
    relay.start(parsed.config);
  }

  async reconnect() {
    await this.restart();
  }

  describeStatus() {
    const labels = {
      idle: "未启动",
      connecting: "连接中",
      connected: "已连接",
      waiting: "等待重连",
      needs_config: "需要配置",
      disabled: "已关闭",
      error: "出错",
      stopped: "已停止",
    };
    return `pi-remote：${labels[this.status.state] ?? this.status.state} · ${this.status.message}`;
  }
}

module.exports = { Bridge, readConfig, PLUGIN_VERSION };
