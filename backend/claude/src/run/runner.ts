// SDK resume 轮次驱动。
//
// startTurn 的前置检查与活跃 run 注册全部同步完成（同一 tick 内的并发 startTurn
// 不存在竞态窗口），SDK 消息流由本模块自建的 #consume 异步消费。
//
// completion 由构造方自己消费并保证 settle（旧项目审查教训）：正常结束、流中抛错、
// abort 三条路径一律先落 `run` 终态事件、关闭事件队列，再 resolve——永不 reject，
// 因此即使调用方不 await completion 也不会产生 unhandledRejection。

import { randomUUID } from "node:crypto";

import {
  adaptSdkMessage,
  createPermissionAdapter,
  startSdkQuery,
  type PermissionBroker,
  type QueryFactory,
  type SdkQueryHandle,
  type WorkerEvent,
} from "../agent-bridge/index.ts";

/**
 * 驾驶互斥门。03 卡的 ActivityTracker 实现此接口（beginRun → daemon-driving，
 * endRun → 重新评估）；本卡只依赖接口定义，测试用 stub。
 */
export interface ActivityGate {
  isIdle(sessionId: string): boolean;
  beginRun(sessionId: string): void;
  endRun(sessionId: string): void;
}

/** 会话非 idle（或已有活跃 run）时 startTurn 抛出；06 卡映射 HTTP 409。 */
export class NotIdleError extends Error {}

/** 事件流元素：`run` 为轮次生命周期（对应 WS run 帧），`worker` 为 SDK 消息展平。 */
export type RunEvent =
  | { type: "run"; runId: string; sessionId: string; state: "started" | "done" | "error"; error?: string; permissionMode?: string }
  | { type: "worker"; runId: string; sessionId: string; event: WorkerEvent };

export type RunOutcome = { state: "done" } | { state: "error"; error: string };

export interface StartTurnOptions {
  sessionId: string;
  cwd: string;
  text: string;
  /** Per-turn override. Omit to follow the Mac-side CLI/settings default. */
  model?: string;
  /** Start a new persisted SDK session with sessionId instead of resuming it. */
  newSession?: boolean;
  /** 权限模式覆盖；省略时由 SDK 走 "default"。 */
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
}

export interface TurnHandle {
  runId: string;
  /** 单消费者事件流：started → worker* → done|error 后结束。 */
  events: AsyncIterable<RunEvent>;
  /** 永不 reject；不 await 也安全。 */
  completion: Promise<RunOutcome>;
}

export interface TurnRunnerOptions {
  gate: ActivityGate;
  permissions: PermissionBroker;
  /** interactions 侧的固定用户标识（本项目单用户），默认 "web"。 */
  userId?: string;
  /** 透传 createPermissionAdapter 的审批超时（PERMISSION_TIMEOUT_MS）。 */
  permissionTimeoutMs?: number;
  /** 测试注入 fake；缺省用真实 Agent SDK。 */
  queryFactory?: QueryFactory;
}

/** 缓冲式异步事件队列：push 先于消费不丢事件；close 后迭代自然结束。 */
class EventQueue<T extends object> implements AsyncIterable<T> {
  readonly #pending: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#pending.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.#pending.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

interface ActiveRun {
  sessionId: string;
  controller: AbortController;
  aborted: boolean;
}

export class TurnRunner {
  readonly #gate: ActivityGate;
  readonly #permissions: PermissionBroker;
  readonly #userId: string;
  readonly #permissionTimeoutMs: number | undefined;
  readonly #queryFactory: QueryFactory | undefined;
  readonly #runs = new Map<string, ActiveRun>();
  readonly #sessionRuns = new Map<string, string>();

  constructor(options: TurnRunnerOptions) {
    this.#gate = options.gate;
    this.#permissions = options.permissions;
    this.#userId = options.userId ?? "web";
    this.#permissionTimeoutMs = options.permissionTimeoutMs;
    this.#queryFactory = options.queryFactory;
  }

  startTurn(options: StartTurnOptions): TurnHandle {
    const { sessionId, cwd, text, model, newSession = false, permissionMode } = options;
    if (typeof text !== "string" || text.trim() === "") {
      throw new TypeError("text must be a non-empty string");
    }
    if (newSession && !isUuid(sessionId)) {
      throw new TypeError("new sessionId must be a UUID");
    }
    if (this.#sessionRuns.has(sessionId)) {
      throw new NotIdleError(`session ${sessionId} already has an active daemon run`);
    }
    if (!this.#gate.isIdle(sessionId)) {
      throw new NotIdleError(`session ${sessionId} is not idle`);
    }

    this.#gate.beginRun(sessionId);
    const controller = new AbortController();
    let sdk: SdkQueryHandle;
    try {
      const canUseTool = createPermissionAdapter(
        this.#permissions,
        { sessionKey: sessionId, userId: this.#userId },
        this.#permissionTimeoutMs === undefined ? {} : { timeoutMs: this.#permissionTimeoutMs },
      );
      sdk = startSdkQuery(
        {
          cwd,
          prompt: text,
          canUseTool,
          signal: controller.signal,
          ...(newSession ? { sessionId } : { resume: sessionId }),
          ...(model === undefined ? {} : { model }),
          ...(permissionMode === undefined ? {} : { permissionMode }),
        },
        this.#queryFactory,
      );
    } catch (error) {
      this.#safeEndRun(sessionId);
      throw error;
    }

    const runId = randomUUID();
    const run: ActiveRun = { sessionId, controller, aborted: false };
    this.#runs.set(runId, run);
    this.#sessionRuns.set(sessionId, runId);

    const queue = new EventQueue<RunEvent>();
    queue.push({ type: "run", runId, sessionId, state: "started", ...(permissionMode === undefined ? {} : { permissionMode }) });
    const completion = this.#consume(runId, run, sdk, queue);
    return { runId, events: queue, completion };
  }

  /** 中断指定 run（经 AbortSignal → SDK interrupt）。未知 runId 返回 false。 */
  abort(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (run === undefined) return false;
    run.aborted = true;
    run.controller.abort(new Error("aborted"));
    return true;
  }

  /** Return the active daemon run for a session, if any. */
  activeRunId(sessionId: string): string | undefined {
    return this.#sessionRuns.get(sessionId);
  }

  async #consume(
    runId: string,
    run: ActiveRun,
    sdk: SdkQueryHandle,
    queue: EventQueue<RunEvent>,
  ): Promise<RunOutcome> {
    const { sessionId } = run;
    let outcome: RunOutcome;
    try {
      // 流式输入 + persistSession 下，CLI 在 result 后保持存活等待下一条输入，
      // iterator 不会自然耗尽（真机实测，06 集成期修复）——一轮以 result 事件为终点。
      let sawResult = false;
      for await (const message of sdk.messages) {
        for (const event of adaptSdkMessage(message)) {
          queue.push({ type: "worker", runId, sessionId, event });
          if (event.type === "result") sawResult = true;
        }
        if (sawResult) break;
      }
      outcome = run.aborted ? { state: "error", error: "aborted" } : { state: "done" };
    } catch (error) {
      outcome = run.aborted
        ? { state: "error", error: "aborted" }
        : { state: "error", error: error instanceof Error ? error.message : String(error) };
    } finally {
      try {
        sdk.close();
      } catch {
        // 清理失败不得影响 settle
      }
      this.#runs.delete(runId);
      if (this.#sessionRuns.get(sessionId) === runId) this.#sessionRuns.delete(sessionId);
      this.#safeEndRun(sessionId);
    }
    queue.push(
      outcome.state === "done"
        ? { type: "run", runId, sessionId, state: "done" }
        : { type: "run", runId, sessionId, state: "error", error: outcome.error },
    );
    queue.close();
    return outcome;
  }

  #safeEndRun(sessionId: string): void {
    try {
      this.#gate.endRun(sessionId);
    } catch (error) {
      console.warn(`activityGate.endRun(${sessionId}) failed:`, error instanceof Error ? error.message : error);
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
