// StreamBuffer：把 SDK 的逐字增量（assistant_delta）攒成 WS 帧推给手机。
//
// 消息正文仍以 watcher tail 的 JSONL 为准；这里只是「草稿」：
//  - 每个 text block 一份草稿，key = `${apiMessageId}:${index}`；
//  - 增量按 flushMs（默认 40ms）合帧，帧带 offset，客户端 offset 对不上就忽略/整段替换；
//  - block 结束发 done:true；run 结束发 clear:true，客户端据此清掉残留草稿；
//  - 新订阅者（中途打开会话、断线重连）用 snapshot() 拿到完整草稿（offset 0）。

import type { Scheduler } from "../watch/watcher.ts";
import { systemScheduler } from "../watch/watcher.ts";

export type StreamFrame =
  | { type: "stream"; sessionId: string; key: string; offset: number; text: string; done?: true }
  | { type: "stream"; sessionId: string; clear: true };

interface Block {
  key: string;
  text: string;
  sent: number; // 已推送的字符数
  done: boolean;
}

interface SessionStream {
  apiMessageId: string;
  blocks: Map<number, Block>;
  order: Block[];
  timer: unknown;
}

export interface StreamBufferOptions {
  emit: (frame: StreamFrame) => void;
  flushMs?: number;
  scheduler?: Scheduler;
}

export class StreamBuffer {
  readonly #emit: (frame: StreamFrame) => void;
  readonly #flushMs: number;
  readonly #scheduler: Scheduler;
  readonly #sessions = new Map<string, SessionStream>();
  #seq = 0;

  constructor(options: StreamBufferOptions) {
    this.#emit = options.emit;
    this.#flushMs = options.flushMs ?? 40;
    this.#scheduler = options.scheduler ?? systemScheduler;
  }

  #session(sessionId: string): SessionStream {
    let s = this.#sessions.get(sessionId);
    if (s === undefined) {
      s = { apiMessageId: `anon${++this.#seq}`, blocks: new Map(), order: [], timer: undefined };
      this.#sessions.set(sessionId, s);
    }
    return s;
  }

  start(sessionId: string, apiMessageId: string): void {
    const s = this.#session(sessionId);
    this.#flush(sessionId);
    s.apiMessageId = apiMessageId;
    s.blocks = new Map();
    // 上一条消息已结束的 block 此时早已写进 JSONL，不再给新订阅者补发
    s.order = s.order.filter((b) => !b.done);
  }

  delta(sessionId: string, index: number, text: string): void {
    if (text === "") return;
    const s = this.#session(sessionId);
    let block = s.blocks.get(index);
    if (block === undefined) {
      block = { key: `${s.apiMessageId}:${index}`, text: "", sent: 0, done: false };
      s.blocks.set(index, block);
      s.order.push(block);
    }
    block.text += text;
    if (s.timer === undefined) {
      s.timer = this.#scheduler.set(() => {
        s.timer = undefined;
        this.#flush(sessionId);
      }, this.#flushMs);
    }
  }

  stop(sessionId: string, index: number): void {
    const s = this.#sessions.get(sessionId);
    const block = s?.blocks.get(index);
    if (s === undefined || block === undefined || block.done) return;
    block.done = true;
    this.#flushBlock(sessionId, block, true);
  }

  /** run 结束：推完剩余增量，通知客户端清草稿，丢掉状态。 */
  end(sessionId: string): void {
    const s = this.#sessions.get(sessionId);
    if (s === undefined) return;
    this.#flush(sessionId);
    if (s.timer !== undefined) this.#scheduler.clear(s.timer);
    this.#sessions.delete(sessionId);
    if (s.order.length > 0) this.#emit({ type: "stream", sessionId, clear: true });
  }

  /** 当前所有草稿的完整快照（给新订阅者）。 */
  snapshot(sessionId: string): StreamFrame[] {
    const s = this.#sessions.get(sessionId);
    if (s === undefined) return [];
    return s.order
      .filter((b) => b.text !== "")
      .map((b) => ({ type: "stream", sessionId, key: b.key, offset: 0, text: b.text, ...(b.done ? { done: true as const } : {}) }));
  }

  #flush(sessionId: string): void {
    const s = this.#sessions.get(sessionId);
    if (s === undefined) return;
    if (s.timer !== undefined) {
      this.#scheduler.clear(s.timer);
      s.timer = undefined;
    }
    for (const block of s.order) if (block.sent < block.text.length) this.#flushBlock(sessionId, block, false);
  }

  #flushBlock(sessionId: string, block: Block, withDone: boolean): void {
    const text = block.text.slice(block.sent);
    if (text === "" && !withDone) return;
    const frame: StreamFrame = { type: "stream", sessionId, key: block.key, offset: block.sent, text };
    if (block.done) frame.done = true;
    block.sent = block.text.length;
    this.#emit(frame);
  }
}
