// ActivityTracker：会话驾驶状态三态机（docs/api-contract.md"状态语义"节）。
//
//   daemon-driving   Runner 有该会话的活跃 run（beginRun..endRun 之间）
//   terminal-driving 非 run 期间检测到文件写入
//   idle             其余情形；最后一次外部写入后 cooldownMs 无写入回落至此
//
// 输入侧接线（06 卡）：SessionWatcher 的 "write" 事件 → noteWrite(sessionId, at)；
// Runner（04 卡）→ beginRun / endRun。run 期间的文件写入不算外部信号。

import { EventEmitter } from "node:events";

import type { SessionStatus } from "../transcript/types.ts";
import { systemScheduler, type Scheduler } from "./watcher.ts";

export interface ActivityTrackerOptions {
  /** terminal-driving 回落 idle 的静默期，默认 120_000（ACTIVITY_COOLDOWN_MS）。 */
  cooldownMs?: number;
  scheduler?: Scheduler;
  now?: () => number;
}

export interface StatusChangeEvent {
  sessionId: string;
  status: SessionStatus;
}

interface ActivityState {
  running: boolean;
  lastWriteAt: number | null;
  timer: unknown;
  status: SessionStatus;
}

const DEFAULT_COOLDOWN_MS = 120_000;

export class ActivityTracker extends EventEmitter {
  readonly #cooldownMs: number;
  readonly #scheduler: Scheduler;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ActivityState>();

  constructor(options: ActivityTrackerOptions = {}) {
    super();
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#now = options.now ?? Date.now;
  }

  override on(event: "change", listener: (payload: StatusChangeEvent) => void): this {
    return super.on(event, listener);
  }

  override once(event: "change", listener: (payload: StatusChangeEvent) => void): this {
    return super.once(event, listener);
  }

  override off(event: "change", listener: (payload: StatusChangeEvent) => void): this {
    return super.off(event, listener);
  }

  getStatus(sessionId: string): SessionStatus {
    return this.#sessions.get(sessionId)?.status ?? "idle";
  }

  /** Runner 开始驱动该会话（04 卡在发起 SDK resume 前调用）。 */
  beginRun(sessionId: string): void {
    const state = this.#ensure(sessionId);
    state.running = true;
    state.lastWriteAt = null;
    this.#clearTimer(state);
    this.#setStatus(sessionId, state, "daemon-driving");
  }

  /** Runner 结束驱动（04 卡在 run settle 且落盘写入结束后调用）。 */
  endRun(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (state === undefined || !state.running) return;
    state.running = false;
    state.lastWriteAt = null;
    this.#clearTimer(state);
    this.#setStatus(sessionId, state, "idle");
    this.#gc(sessionId, state);
  }

  /** 会话文件发生写入（watcher "write" 事件）。run 期间的写入不算外部信号。 */
  noteWrite(sessionId: string, at: number = this.#now()): void {
    const state = this.#ensure(sessionId);
    if (state.running) return;
    state.lastWriteAt = at;
    this.#armCooldown(sessionId, state);
    this.#setStatus(sessionId, state, "terminal-driving");
  }

  /** 释放全部 timer 与状态。幂等。 */
  dispose(): void {
    for (const state of this.#sessions.values()) this.#clearTimer(state);
    this.#sessions.clear();
  }

  // -------------------------------------------------------------------------

  #ensure(sessionId: string): ActivityState {
    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = { running: false, lastWriteAt: null, timer: undefined, status: "idle" };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #armCooldown(sessionId: string, state: ActivityState): void {
    this.#clearTimer(state);
    state.timer = this.#scheduler.set(() => this.#onCooldown(sessionId), this.#cooldownMs);
  }

  #onCooldown(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return;
    state.timer = undefined;
    if (state.running || state.lastWriteAt === null) return;
    const remaining = state.lastWriteAt + this.#cooldownMs - this.#now();
    if (remaining > 0) {
      // 时钟注入下的防御：还没到静默期就被叫醒，按剩余量重挂
      state.timer = this.#scheduler.set(() => this.#onCooldown(sessionId), remaining);
      return;
    }
    state.lastWriteAt = null;
    this.#setStatus(sessionId, state, "idle");
    this.#gc(sessionId, state);
  }

  #clearTimer(state: ActivityState): void {
    if (state.timer === undefined) return;
    this.#scheduler.clear(state.timer);
    state.timer = undefined;
  }

  #setStatus(sessionId: string, state: ActivityState, status: SessionStatus): void {
    if (state.status === status) return;
    state.status = status;
    super.emit("change", { sessionId, status } satisfies StatusChangeEvent);
  }

  /** 回到 idle 且无 run 的会话不再占条目，防长期运行 Map 无界增长。 */
  #gc(sessionId: string, state: ActivityState): void {
    if (!state.running && state.status === "idle" && state.timer === undefined) {
      this.#sessions.delete(sessionId);
    }
  }
}
