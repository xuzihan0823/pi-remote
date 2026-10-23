"use strict";

/**
 * 会话状态观察者。PI-Desktop 不向插件推送 token 流，所以对手机最近操作过的会话轮询
 * agent/getStatus（运行中约 1 秒一次，空闲时 5 秒），把状态变化转换成 Relay 的 session_event：
 *   - 空闲 → 运行：agent_start
 *   - 运行 → 空闲，或收到宿主 session:turnEnded：agent_settled（只发一次）
 *   - 出现等待处理的权限 / 计划 / AskTool：notice（level warning，提示“需要在 Mac 上处理”）
 * 轮询的是轻量的运行状态，不是整段会话记录；会话正文由手机按需调用 session.get 读取。
 */

const DEFAULT_BUSY_MS = 1_000;
const DEFAULT_IDLE_MS = 5_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TRACKED = 16;

function pendingSummary(status) {
  const reasons = [];
  if (!status) return reasons;
  const confirmations = Number(status.pendingToolConfirmations ?? 0);
  if (Number.isFinite(confirmations) && confirmations > 0) reasons.push(`${confirmations} 个工具权限请求`);
  if (status.planningState === "awaiting_approval" || (typeof status.pendingPlanId === "string" && status.pendingPlanId)) {
    reasons.push("计划等待批准");
  }
  return reasons;
}

class SessionWatcher {
  /**
   * @param {{
   *   readStatus(nativeId: string): Promise<Record<string, unknown> | null>,
   *   emit(nativeId: string, event: Record<string, unknown>): void,
   *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
   *   now?: () => number,
   *   busyMs?: number, idleMs?: number, ttlMs?: number,
   *   logger?: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.readStatus = options.readStatus;
    this.emit = options.emit;
    this.timers = options.timers ?? { setTimeout, clearTimeout };
    this.now = options.now ?? (() => Date.now());
    this.busyMs = options.busyMs ?? DEFAULT_BUSY_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = options.logger ?? (() => {});
    /** @type {Map<string, { touchedAt: number, running: boolean | null, pendingKey: string, settledTurn: string | null }>} */
    this.sessions = new Map();
    this.timer = null;
    this.stopped = false;
    this.ticking = false;
  }

  /**
   * 手机打开、发送或停止某个会话时调用，开始（或续期）观察。
   * 已在观察的会话只续期，不打乱轮询节奏（手机每 0.5～2 秒会读一次时间线）；
   * poke 为 true（发送、停止之后）时立即查一次状态。
   */
  track(nativeId, options = {}) {
    if (this.stopped) return;
    const existing = this.sessions.get(nativeId);
    if (existing) {
      existing.touchedAt = this.now();
      if (options.poke) this.schedule(0);
      return;
    }
    this.sessions.set(nativeId, { touchedAt: this.now(), running: null, pendingKey: "", settledTurn: null });
    while (this.sessions.size > MAX_TRACKED) {
      // 淘汰最久没被手机碰过的会话
      let oldest = null;
      for (const [id, entry] of this.sessions) if (!oldest || entry.touchedAt < oldest[1].touchedAt) oldest = [id, entry];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    this.schedule(0);
  }

  isTracked(nativeId) {
    return this.sessions.has(nativeId);
  }

  /** 宿主的 session:turnEnded 事件：比轮询更快地告诉手机这一轮结束了。 */
  onTurnEnded(payload) {
    const nativeId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const entry = this.sessions.get(nativeId);
    if (!entry) return;
    const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
    if (turnId && entry.settledTurn === turnId) return;
    entry.settledTurn = turnId || entry.settledTurn;
    entry.running = false;
    this.emit(nativeId, { type: "agent_settled" });
    if (payload.reason === "error") this.emit(nativeId, { type: "notice", level: "error", text: "本轮执行出错，详情见会话记录" });
    else if (payload.reason === "aborted") this.emit(nativeId, { type: "notice", level: "info", text: "本轮已停止" });
    this.schedule(0);
  }

  schedule(delay) {
    if (this.stopped || this.sessions.size === 0) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer?.unref?.();
  }

  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    let anyRunning = false;
    try {
      const now = this.now();
      for (const [nativeId, entry] of [...this.sessions]) {
        let status;
        try {
          status = await this.readStatus(nativeId);
        } catch (error) {
          this.logger(`读取会话状态失败：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (this.stopped) return;
        const running = status?.isRunning === true;
        if (entry.running !== true && running) {
          entry.settledTurn = null;
          this.emit(nativeId, { type: "agent_start" });
        } else if (entry.running === true && !running) {
          this.emit(nativeId, { type: "agent_settled" });
        }
        entry.running = running;
        const reasons = pendingSummary(status);
        const pendingKey = reasons.join("|");
        if (pendingKey && pendingKey !== entry.pendingKey) {
          this.emit(nativeId, { type: "notice", level: "warning", text: `${reasons.join("、")}，需要在 Mac 上的 Pi Desktop 中处理` });
        }
        entry.pendingKey = pendingKey;
        if (running) anyRunning = true;
        else if (now - entry.touchedAt > this.ttlMs) this.sessions.delete(nativeId);
      }
    } finally {
      this.ticking = false;
    }
    this.schedule(anyRunning ? this.busyMs : this.idleMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.sessions.clear();
  }
}

module.exports = { SessionWatcher, pendingSummary };
