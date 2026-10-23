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
  /**
   * abort 后等待 SDK interrupt 生效的上限，默认 5_000。超时仍未收尾（CLI 卡在 API 重试、
   * 子进程无响应等）则强制 sdk.close() 并结束本轮，保证「停止」一定能让会话回到 idle。
   */
  abortGraceMs?: number;
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
  /** abort 宽限期满后调用：强制结束 #consume 的消息循环。 */
  forceStop: () => void;
  forceTimer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_ABORT_GRACE_MS = 5_000;
const FORCE_STOPPED = Symbol("force-stopped");

export class TurnRunner {
  readonly #gate: ActivityGate;
  readonly #permissions: PermissionBroker;
  readonly #userId: string;
  readonly #permissionTimeoutMs: number | undefined;
  readonly #abortGraceMs: number;
  readonly #queryFactory: QueryFactory | undefined;
  readonly #runs = new Map<string, ActiveRun>();
  readonly #sessionRuns = new Map<string, string>();

  constructor(options: TurnRunnerOptions) {
    this.#gate = options.gate;
    this.#permissions = options.permissions;
    this.#userId = options.userId ?? "web";
    this.#permissionTimeoutMs = options.permissionTimeoutMs;
    this.#abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
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
    let forceStop!: () => void;
    const forceStopped = new Promise<typeof FORCE_STOPPED>((resolve) => {
      forceStop = () => resolve(FORCE_STOPPED);
    });
    const run: ActiveRun = { sessionId, controller, aborted: false, forceStop, forceTimer: undefined };
    this.#runs.set(runId, run);
    this.#sessionRuns.set(sessionId, runId);

    const queue = new EventQueue<RunEvent>();
    queue.push({ type: "run", runId, sessionId, state: "started", ...(permissionMode === undefined ? {} : { permissionMode }) });
    const completion = this.#consume(runId, run, sdk, queue, forceStopped);
    return { runId, events: queue, completion };
  }

  /** 中断指定 run（经 AbortSignal → SDK interrupt）。未知 runId 返回 false。 */
  abort(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (run === undefined) return false;
    if (run.aborted) return true; // 重复点停止：已在收尾中
    run.aborted = true;
    run.controller.abort(new Error("aborted"));
    run.forceTimer = setTimeout(() => {
      console.warn(`run ${runId} did not settle ${this.#abortGraceMs}ms after abort; force-closing SDK`);
      run.forceStop();
    }, this.#abortGraceMs);
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
    forceStopped: Promise<typeof FORCE_STOPPED>,
  ): Promise<RunOutcome> {
    const { sessionId } = run;
    let outcome: RunOutcome;
    const iterator = sdk.messages[Symbol.asyncIterator]();
    try {
      // 流式输入 + persistSession 下，CLI 在 result 后保持存活等待下一条输入，
      // iterator 不会自然耗尽（真机实测，06 集成期修复）——一轮以 result 事件为终点。
      // 每次 next() 与 forceStopped 赛跑：interrupt 不生效时 abort 宽限期满直接跳出。
      let sawResult = false;
      let resultError: string | undefined;
      for (;;) {
        const next = await Promise.race([iterator.next(), forceStopped]);
        if (next === FORCE_STOPPED || next.done === true) break;
        for (const event of adaptSdkMessage(next.value)) {
          queue.push({ type: "worker", runId, sessionId, event });
          if (event.type === "result") {
            sawResult = true;
            // 模型不可用、鉴权失败等：CLI 照样给 result，但 is_error=true——按出错收尾，手机端才会提示
            if (event.isError) resultError = resultErrorText(event) ?? "Claude 返回错误";
          }
        }
        if (sawResult) break;
      }
      outcome = run.aborted
        ? { state: "error", error: "aborted" }
        : resultError !== undefined ? { state: "error", error: resultError } : { state: "done" };
    } catch (error) {
      outcome = run.aborted
        ? { state: "error", error: "aborted" }
        : { state: "error", error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (run.forceTimer !== undefined) clearTimeout(run.forceTimer);
      // 等价于 for-await 的 break 语义；不 await（被强制停止时生成器可能仍挂起）
      void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined);
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

function resultErrorText(event: WorkerEvent): string | undefined {
  if (event.type !== "result") return undefined;
  const record = event as unknown as { result?: unknown; errors?: unknown };
  if (typeof record.result === "string" && record.result.trim() !== "") return record.result.trim().slice(0, 300);
  if (Array.isArray(record.errors)) {
    const text = record.errors.filter((e): e is string => typeof e === "string").join("; ").trim();
    if (text !== "") return text.slice(0, 300);
  }
  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
