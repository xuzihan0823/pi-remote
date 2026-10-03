// SessionWatcher：会话 JSONL 的增量 tail。
//
// 监听手段两路并行，靠 offset 去重（重复触发的 poll 看到 size===offset 即空转）：
//  1. 目录级 fs.watch（macOS FSEvents）——低延迟主路；
//  2. 500ms stat 轮询——FSEvents 丢事件时的保底。
//
// 行解析完全复用 02 卡的 parseTranscriptLine（纯函数），本文件只负责
// 字节 → 行的切分（半行缓存）、seq 计数（物理行号，与 reader 分页对齐）、
// 链尾校验（增量行 parentUuid 不指向已知链尾 → resync）与 truncation 检测。

import { EventEmitter } from "node:events";
import { watch as fsWatch } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseTranscriptLine } from "../transcript/reader.ts";
import type { RenderMessage } from "../transcript/types.ts";

// ---------------------------------------------------------------------------
// 可注入的定时器 / 时钟 / 目录监听（测试确定性；手法沿用旧项目 wire.ts 的 Scheduler）
// ---------------------------------------------------------------------------

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** 生产实现：setTimeout + unref，不阻止进程退出。 */
export const systemScheduler: Scheduler = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DirWatchHandle {
  close(): void;
}

/** 目录级监听工厂。事件回调参数为变化的文件名（可能为 null，表示未知）。 */
export type DirWatchFactory = (
  dir: string,
  onEvent: (filename: string | null) => void,
) => DirWatchHandle;

const systemDirWatchFactory: DirWatchFactory = (dir, onEvent) => {
  // persistent:false —— fs.watch 自身不阻止进程退出；错误（目录消失等）静默，轮询保底。
  const watcher = fsWatch(dir, { persistent: false }, (_eventType, filename) => {
    onEvent(filename === null ? null : String(filename));
  });
  watcher.on("error", () => {});
  return { close: () => watcher.close() };
};

// ---------------------------------------------------------------------------
// 事件类型
// ---------------------------------------------------------------------------

export type ResyncReason = "truncated" | "chain-mismatch";

export interface WatcherMessageEvent {
  sessionId: string;
  message: RenderMessage;
}

/** 消费方收到后应全量重拉（readTail）。 */
export interface WatcherResyncEvent {
  sessionId: string;
  reason: ResyncReason;
}

/** 文件字节数变化即视为一次写入（ActivityTracker 的外部活动信号）。 */
export interface WatcherWriteEvent {
  sessionId: string;
  at: number;
}

export interface WatcherErrorEvent {
  sessionId: string;
  error: unknown;
}

interface WatcherEvents {
  message: WatcherMessageEvent;
  resync: WatcherResyncEvent;
  write: WatcherWriteEvent;
  error: WatcherErrorEvent;
}

// ---------------------------------------------------------------------------
// SessionWatcher
// ---------------------------------------------------------------------------

export interface SessionWatcherOptions {
  /** 会话根目录（即 CLAUDE_PROJECTS_DIR，测试注入临时目录）。 */
  projectsDir: string;
  /** 轮询间隔，默认 500ms。 */
  pollIntervalMs?: number;
  scheduler?: Scheduler;
  now?: () => number;
  /** 传 null 禁用 fs.watch（测试轮询兜底路径）。 */
  dirWatchFactory?: DirWatchFactory | null;
}

interface SessionState {
  sessionId: string;
  file: string;
  dir: string;
  /** 已消费的字节数（含 remainder 中未成行的字节）。 */
  offset: number;
  /** 已完成（见到换行）的物理行数 = 最后一条已发行的 seq。 */
  lineCount: number;
  /** 半行缓存：最后一个换行之后的字节。 */
  remainder: Buffer;
  /** 已知链尾 uuid（最后一条非 sidechain 且带 uuid 的行）。 */
  lastUuid: string | null;
  polling: boolean;
  dirty: boolean;
}

interface DirWatchEntry {
  handle: DirWatchHandle;
  refs: number;
}

export class SessionWatcher extends EventEmitter {
  readonly #projectsDir: string;
  readonly #pollIntervalMs: number;
  readonly #scheduler: Scheduler;
  readonly #now: () => number;
  readonly #dirWatchFactory: DirWatchFactory | null;

  readonly #sessions = new Map<string, SessionState>();
  readonly #dirWatchers = new Map<string, DirWatchEntry>();
  readonly #pendingWatch = new Set<string>();
  #tickHandle: unknown;
  #closed = false;

  constructor(options: SessionWatcherOptions) {
    super();
    this.#projectsDir = options.projectsDir;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#now = options.now ?? Date.now;
    this.#dirWatchFactory =
      options.dirWatchFactory === undefined ? systemDirWatchFactory : options.dirWatchFactory;
  }

  override on<K extends keyof WatcherEvents>(
    event: K,
    listener: (payload: WatcherEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  override once<K extends keyof WatcherEvents>(
    event: K,
    listener: (payload: WatcherEvents[K]) => void,
  ): this {
    return super.once(event, listener);
  }

  override off<K extends keyof WatcherEvents>(
    event: K,
    listener: (payload: WatcherEvents[K]) => void,
  ): this {
    return super.off(event, listener);
  }

  #emitEvent<K extends keyof WatcherEvents>(event: K, payload: WatcherEvents[K]): void {
    super.emit(event, payload);
  }

  /** 当前被订阅的 sessionId 列表（调试/测试用）。 */
  get watched(): string[] {
    return [...this.#sessions.keys()];
  }

  /**
   * 订阅会话。定位 `<projectsDir>/<*>/<sessionId>.jsonl`，从当前文件尾开始增量推送
   * （历史部分由消费方 readTail 拉取）。文件不存在时抛 ENOENT（调用方转 404）。
   */
  async watch(sessionId: string): Promise<void> {
    if (this.#closed) throw new Error("watcher closed");
    if (this.#sessions.has(sessionId) || this.#pendingWatch.has(sessionId)) return;
    this.#pendingWatch.add(sessionId);
    try {
      const file = await this.#resolveFile(sessionId);
      const dir = join(file, "..");
      const init = await scanExisting(file);
      if (this.#closed || this.#sessions.has(sessionId)) return;
      const state: SessionState = {
        sessionId,
        file,
        dir,
        offset: init.offset,
        lineCount: init.lineCount,
        remainder: init.remainder,
        lastUuid: init.lastUuid,
        polling: false,
        dirty: false,
      };
      this.#sessions.set(sessionId, state);
      this.#acquireDirWatcher(dir);
      if (this.#tickHandle === undefined) this.#armTick();
    } finally {
      this.#pendingWatch.delete(sessionId);
    }
  }

  unwatch(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return;
    this.#sessions.delete(sessionId);
    this.#releaseDirWatcher(state.dir);
    if (this.#sessions.size === 0 && this.#tickHandle !== undefined) {
      this.#scheduler.clear(this.#tickHandle);
      this.#tickHandle = undefined;
    }
  }

  /** 停止全部订阅并释放 timer/fd。幂等。 */
  close(): void {
    this.#closed = true;
    for (const sessionId of [...this.#sessions.keys()]) this.unwatch(sessionId);
  }

  /** 立即对全部（或指定）会话做一次轮询并等待完成。测试与手动触发用。 */
  async pollNow(sessionId?: string): Promise<void> {
    const targets =
      sessionId === undefined
        ? [...this.#sessions.values()]
        : [this.#sessions.get(sessionId)].filter((s): s is SessionState => s !== undefined);
    await Promise.all(targets.map((state) => this.#poll(state)));
  }

  // -- 定位与目录监听 -------------------------------------------------------

  async #resolveFile(sessionId: string): Promise<string> {
    const name = `${sessionId}.jsonl`;
    // projectsDir 本身不存在：原生 ENOENT 上抛
    const dirents = await readdir(this.#projectsDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const candidate = join(this.#projectsDir, dirent.name, name);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // 该项目目录下没有，继续
      }
    }
    const error = new Error(`session file not found: ${sessionId}`);
    (error as NodeJS.ErrnoException).code = "ENOENT";
    throw error;
  }

  #acquireDirWatcher(dir: string): void {
    if (this.#dirWatchFactory === null) return;
    const existing = this.#dirWatchers.get(dir);
    if (existing !== undefined) {
      existing.refs += 1;
      return;
    }
    let handle: DirWatchHandle;
    try {
      handle = this.#dirWatchFactory(dir, (filename) => this.#onDirEvent(dir, filename));
    } catch {
      return; // fs.watch 建立失败：只剩轮询，不致命
    }
    this.#dirWatchers.set(dir, { handle, refs: 1 });
  }

  #releaseDirWatcher(dir: string): void {
    const entry = this.#dirWatchers.get(dir);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.#dirWatchers.delete(dir);
    entry.handle.close();
  }

  #onDirEvent(dir: string, filename: string | null): void {
    for (const state of this.#sessions.values()) {
      if (state.dir !== dir) continue;
      if (filename !== null && filename !== `${state.sessionId}.jsonl`) continue;
      void this.#poll(state);
    }
  }

  // -- 轮询 -----------------------------------------------------------------

  #armTick(): void {
    if (this.#closed || this.#sessions.size === 0) return;
    this.#tickHandle = this.#scheduler.set(() => {
      void this.#tick();
    }, this.#pollIntervalMs);
  }

  async #tick(): Promise<void> {
    this.#tickHandle = undefined;
    await Promise.all([...this.#sessions.values()].map((state) => this.#poll(state)));
    if (this.#tickHandle === undefined) this.#armTick();
  }

  /** 单会话轮询。串行化：进行中再触发只置 dirty，结束后补一轮。自身不抛错。 */
  async #poll(state: SessionState): Promise<void> {
    if (this.#sessions.get(state.sessionId) !== state) return;
    if (state.polling) {
      state.dirty = true;
      return;
    }
    state.polling = true;
    try {
      do {
        state.dirty = false;
        await this.#pollOnce(state);
      } while (state.dirty && this.#sessions.get(state.sessionId) === state);
    } catch (error) {
      this.#emitEvent("error", { sessionId: state.sessionId, error });
    } finally {
      state.polling = false;
    }
  }

  async #pollOnce(state: SessionState): Promise<void> {
    let size: number;
    try {
      size = (await stat(state.file)).size;
    } catch {
      return; // 文件暂时不可见（替换中/被删）：等下一轮；替换完成表现为 size 变化
    }
    if (size === state.offset) return;
    this.#emitEvent("write", { sessionId: state.sessionId, at: this.#now() });

    if (size < state.offset) {
      // 截断/替换：重扫全文件重建 seq 与链尾，消费方全量重拉
      const init = await scanExisting(state.file);
      state.offset = init.offset;
      state.lineCount = init.lineCount;
      state.remainder = init.remainder;
      state.lastUuid = init.lastUuid;
      this.#emitEvent("resync", { sessionId: state.sessionId, reason: "truncated" });
      return;
    }

    const chunk = await readRange(state.file, state.offset, size);
    state.offset += chunk.length;
    this.#consume(state, chunk);
  }

  // -- 字节 → 行 → 消息 -----------------------------------------------------

  #consume(state: SessionState, chunk: Buffer): void {
    let data = state.remainder.length > 0 ? Buffer.concat([state.remainder, chunk]) : chunk;
    for (;;) {
      const nl = data.indexOf(0x0a);
      if (nl === -1) break;
      const line = data.subarray(0, nl).toString("utf8");
      data = data.subarray(nl + 1);
      state.lineCount += 1;
      this.#handleLine(state, line, state.lineCount);
    }
    // subarray 引用底层大 buffer，复制断开引用
    state.remainder = data.length > 0 ? Buffer.from(data) : Buffer.alloc(0);
  }

  #handleLine(state: SessionState, line: string, seq: number): void {
    const info = lineChainInfo(line);
    if (info === null) return; // 空行/坏行：占 seq，不产出、不动链
    if (info.sidechain) return; // sidechain 自成链，不校验也不推送
    if (info.uuid !== null) {
      if (state.lastUuid !== null && info.parentUuid !== state.lastUuid) {
        // 外部 rewind/fork 到历史节点：本地行号仍有效，但消费方的链视图已失效
        state.lastUuid = info.uuid;
        this.#emitEvent("resync", { sessionId: state.sessionId, reason: "chain-mismatch" });
        return;
      }
      state.lastUuid = info.uuid;
    }
    for (const message of parseTranscriptLine(line, seq)) {
      this.#emitEvent("message", { sessionId: state.sessionId, message });
    }
  }
}

// ---------------------------------------------------------------------------
// 文件扫描辅助（watch 初始化与 truncation 重建共用）
// ---------------------------------------------------------------------------

interface ScanState {
  offset: number;
  lineCount: number;
  remainder: Buffer;
  lastUuid: string | null;
}

interface ChainInfo {
  uuid: string | null;
  parentUuid: string | null;
  sidechain: boolean;
}

/** 提取一行的链定位字段。空行/坏 JSON/非对象 → null。 */
function lineChainInfo(line: string): ChainInfo | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const record = o as Record<string, unknown>;
  return {
    uuid: typeof record.uuid === "string" ? record.uuid : null,
    parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : null,
    sidechain: record.isSidechain === true,
  };
}

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const length = end - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
      if (bytesRead === 0) break; // 文件又变短了：下一轮按 truncation 处理
      read += bytesRead;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/**
 * 顺序流过现有文件：数完成行数（=尾行 seq）、记链尾 uuid、留下尾部半行。
 * 只提取链定位字段，行内容即读即弃（同 02 reader 的轻扫思路）。
 */
async function scanExisting(file: string): Promise<ScanState> {
  const handle = await open(file, "r");
  const result: ScanState = { offset: 0, lineCount: 0, remainder: Buffer.alloc(0), lastUuid: null };
  try {
    const chunkSize = 256 * 1024;
    const chunk = Buffer.alloc(chunkSize);
    let pending: Buffer[] = [];
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, result.offset);
      if (bytesRead === 0) break;
      let pieceStart = 0;
      for (let i = 0; i < bytesRead; i += 1) {
        if (chunk[i] !== 0x0a) continue;
        const piece = chunk.subarray(pieceStart, i);
        const lineBuffer =
          pending.length > 0 ? Buffer.concat([...pending, piece]) : Buffer.from(piece);
        pending = [];
        result.lineCount += 1;
        const info = lineChainInfo(lineBuffer.toString("utf8"));
        if (info !== null && !info.sidechain && info.uuid !== null) result.lastUuid = info.uuid;
        pieceStart = i + 1;
      }
      if (pieceStart < bytesRead) pending.push(Buffer.from(chunk.subarray(pieceStart, bytesRead)));
      result.offset += bytesRead;
    }
    result.remainder = pending.length > 0 ? Buffer.concat(pending) : Buffer.alloc(0);
  } finally {
    await handle.close();
  }
  return result;
}
