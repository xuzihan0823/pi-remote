"use strict";

/**
 * 指数退避：1s、2s、4s … 上限 maxMs，带 ±jitter 抖动，避免多台设备同时重连。
 * random 可注入，便于测试得到确定值。
 */
class Backoff {
  constructor(options = {}) {
    this.baseMs = options.baseMs ?? 1_000;
    this.maxMs = options.maxMs ?? 60_000;
    this.factor = options.factor ?? 2;
    this.jitter = options.jitter ?? 0.2;
    this.random = options.random ?? Math.random;
    this.attempt = 0;
  }

  /** 下一次等待的毫秒数，并把尝试次数加一。 */
  next() {
    const exponent = Math.min(this.attempt, 30);
    const raw = Math.min(this.maxMs, this.baseMs * this.factor ** exponent);
    this.attempt += 1;
    const spread = raw * this.jitter;
    const delay = raw - spread + this.random() * spread * 2;
    return Math.max(0, Math.min(this.maxMs, Math.round(delay)));
  }

  /** 认证失败等长期错误：直接跳到上限，避免频繁打 Relay。 */
  penalize() {
    this.attempt = Math.max(this.attempt, 30);
  }

  reset() {
    this.attempt = 0;
  }
}

module.exports = { Backoff };
