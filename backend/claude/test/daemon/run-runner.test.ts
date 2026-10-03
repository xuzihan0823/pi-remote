// TurnRunner：事件流、互斥、abort、completion 不逃逸。全部走 fake QueryFactory，不碰真 SDK。

import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";

import { adaptSdkMessage, type PermissionBroker, type QueryFactory } from "../../src/agent-bridge/index.ts";
import { NotIdleError, TurnRunner, type ActivityGate, type RunEvent } from "../../src/run/runner.ts";

type QueryParams = Parameters<QueryFactory>[0];
type SdkQuery = ReturnType<QueryFactory>;
type AnySdkMessage = Parameters<typeof adaptSdkMessage>[0];

interface FakeState {
  params: QueryParams | undefined;
  interrupts: number;
  closes: number;
  onInterrupt: (() => void) | undefined;
}

/** 最小 fake：async generator 充当 Query，只补 sdk-bridge 用到的 interrupt/close。 */
function fakeFactory(
  produce: (state: FakeState) => AsyncGenerator<AnySdkMessage, void>,
): { factory: QueryFactory; state: FakeState } {
  const state: FakeState = { params: undefined, interrupts: 0, closes: 0, onInterrupt: undefined };
  const factory = ((params: QueryParams): SdkQuery => {
    state.params = params;
    const generator = produce(state);
    const augmented = generator as unknown as Record<string, unknown>;
    augmented.interrupt = async (): Promise<void> => {
      state.interrupts += 1;
      state.onInterrupt?.();
    };
    augmented.close = (): void => {
      state.closes += 1;
    };
    return generator as unknown as SdkQuery;
  }) as unknown as QueryFactory;
  return { factory, state };
}

function sdkMessage(value: Record<string, unknown>): AnySdkMessage {
  return value as unknown as AnySdkMessage;
}

function assistantMessage(text: string, uuid: string, sessionId: string): AnySdkMessage {
  return sdkMessage({ type: "assistant", uuid, session_id: sessionId, message: { content: [{ type: "text", text }] } });
}

function resultMessage(result: string, uuid: string, sessionId: string): AnySdkMessage {
  return sdkMessage({ type: "result", subtype: "success", is_error: false, result, uuid, session_id: sessionId });
}

function stubGate(isIdle: (sessionId: string) => boolean = () => true): {
  gate: ActivityGate;
  begun: string[];
  ended: string[];
} {
  const begun: string[] = [];
  const ended: string[] = [];
  const gate: ActivityGate = {
    isIdle,
    beginRun: (sessionId) => { begun.push(sessionId); },
    endRun: (sessionId) => { ended.push(sessionId); },
  };
  return { gate, begun, ended };
}

const denyAll: PermissionBroker = { request: async () => ({ type: "deny" }) };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

test("normal turn: started → worker events → done，completion settle，gate/close 收尾", async () => {
  const { factory, state } = fakeFactory(async function* () {
    yield assistantMessage("你好", "m1", "sess-1");
    yield resultMessage("完成", "r1", "sess-1");
  });
  const { gate, begun, ended } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "sess-1", cwd: "/tmp", text: "继续" });

  const events = await collect(handle.events);
  assert.deepEqual(await handle.completion, { state: "done" });

  assert.deepEqual(events[0], { type: "run", runId: handle.runId, sessionId: "sess-1", state: "started" });
  assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "sess-1", state: "done" });
  const workerTypes = events.filter((e) => e.type === "worker").map((e) => e.event.type);
  assert.deepEqual(workerTypes, ["session", "assistant", "session", "result"]);

  assert.deepEqual(begun, ["sess-1"]);
  assert.deepEqual(ended, ["sess-1"]);
  assert.equal(state.closes, 1);

  // resume 接线：resume=sessionId、permissionMode 固定 default、prompt 经输入流送达
  const options = state.params?.options;
  assert.equal(options?.resume, "sess-1");
  assert.equal(options?.permissionMode, "default");
  const input = state.params?.prompt as AsyncIterable<{ message: { content: unknown } }>;
  const first = await input[Symbol.asyncIterator]().next();
  assert.equal(first.done, false);
  assert.equal(first.value.message.content, "继续");
});

test("new session uses explicit sessionId and model instead of resume", async () => {
  const { factory, state } = fakeFactory(async function* () {
    yield resultMessage("完成", "r1", "01234567-89ab-4def-8123-456789abcdef");
  });
  const { gate } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({
    sessionId: "01234567-89ab-4def-8123-456789abcdef",
    cwd: "/tmp",
    text: "新会话",
    model: "fable",
    newSession: true,
  });
  await handle.completion;

  const options = state.params?.options as Record<string, unknown> | undefined;
  assert.equal(options?.sessionId, "01234567-89ab-4def-8123-456789abcdef");
  assert.equal(options?.model, "fable");
  assert.equal(Object.hasOwn(options ?? {}, "resume"), false);
  assert.throws(() => runner.startTurn({ sessionId: "not-a-uuid", cwd: "/tmp", text: "x", newSession: true }), TypeError);
});

test("permissionMode 透传 sdkOptions 且随 started 事件广播；省略时事件不带该字段", async () => {
  const { factory, state } = fakeFactory(async function* () {
    yield resultMessage("完成", "r1", "sess-pm");
  });
  const { gate } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "sess-pm", cwd: "/tmp", text: "继续", permissionMode: "acceptEdits" });

  const events = await collect(handle.events);
  assert.deepEqual(events[0], {
    type: "run", runId: handle.runId, sessionId: "sess-pm", state: "started", permissionMode: "acceptEdits",
  });
  assert.equal(state.params?.options?.permissionMode, "acceptEdits");

  // 省略 permissionMode：started 事件不带字段（前端按本地记忆展示）
  const second = fakeFactory(async function* () {
    yield resultMessage("完成", "r2", "sess-pm2");
  });
  const runner2 = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: second.factory });
  const handle2 = runner2.startTurn({ sessionId: "sess-pm2", cwd: "/tmp", text: "继续" });
  const events2 = await collect(handle2.events);
  assert.deepEqual(events2[0], { type: "run", runId: handle2.runId, sessionId: "sess-pm2", state: "started" });
});

test("gate 非 idle：抛 NotIdleError 且不 beginRun、不建 SDK query", () => {
  const { gate, begun } = stubGate(() => false);
  const factory = ((): SdkQuery => {
    throw new Error("queryFactory must not be called");
  }) as unknown as QueryFactory;
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  assert.throws(() => runner.startTurn({ sessionId: "busy", cwd: "/tmp", text: "hi" }), NotIdleError);
  assert.deepEqual(begun, []);
});

test("空 text 抛 TypeError，不触发 gate", () => {
  const { gate, begun } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll });
  assert.throws(() => runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "  " }), TypeError);
  assert.deepEqual(begun, []);
});

test("同会话并发=1：活跃 run 期间重复 startTurn 抛 NotIdleError（即便 gate 报 idle）", async () => {
  const stop = deferred();
  const { factory, state } = fakeFactory(async function* () {
    await stop.promise;
  });
  state.onInterrupt = () => stop.resolve();
  const { gate } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });

  const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });
  assert.throws(() => runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "again" }), NotIdleError);

  runner.abort(handle.runId);
  assert.deepEqual(await handle.completion, { state: "error", error: "aborted" });

  // run 结束后会话解锁，可再次 startTurn（stop 已 resolve，新 query 立即结束）
  const second = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });
  assert.deepEqual(await second.completion, { state: "done" });
});

test("不同会话可并行，各自 begin/end", async () => {
  const releases: Array<() => void> = [];
  const { factory } = fakeFactory(async function* () {
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  const { gate, begun, ended } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });

  const a = runner.startTurn({ sessionId: "sess-a", cwd: "/tmp", text: "hi" });
  const b = runner.startTurn({ sessionId: "sess-b", cwd: "/tmp", text: "hi" });
  assert.deepEqual(begun, ["sess-a", "sess-b"]);

  // 等两个生成器都挂起后放行
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  for (const release of releases) release();
  assert.deepEqual(await a.completion, { state: "done" });
  assert.deepEqual(await b.completion, { state: "done" });
  assert.deepEqual([...ended].sort(), ["sess-a", "sess-b"]);
});

test("abort：调 SDK interrupt、终态 run error=aborted、endRun 收尾", async () => {
  const stop = deferred();
  const { factory, state } = fakeFactory(async function* () {
    yield assistantMessage("前半", "m1", "s");
    await stop.promise;
  });
  state.onInterrupt = () => stop.resolve();
  const { gate, ended } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });

  assert.equal(runner.abort("nonexistent-run"), false);
  assert.equal(runner.abort(handle.runId), true);

  assert.deepEqual(await handle.completion, { state: "error", error: "aborted" });
  const events = await collect(handle.events);
  assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "s", state: "error", error: "aborted" });
  assert.equal(state.interrupts, 1);
  assert.deepEqual(ended, ["s"]);
});

test("SDK 流中抛错：completion 不逃逸（unhandledRejection 探针零命中）", async () => {
  const seen: unknown[] = [];
  const probe = (reason: unknown): void => { seen.push(reason); };
  process.on("unhandledRejection", probe);
  try {
    const { factory } = fakeFactory(async function* () {
      yield assistantMessage("a", "m1", "s");
      throw new Error("boom");
    });
    const { gate, ended } = stubGate();
    const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
    const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });

    // 故意先不 await completion，把微任务/宏任务队列都排空，验证没有 rejection 逃逸
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(seen, []);

    assert.deepEqual(await handle.completion, { state: "error", error: "boom" });
    const events = await collect(handle.events);
    assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "s", state: "error", error: "boom" });
    assert.deepEqual(ended, ["s"]);
  } finally {
    process.off("unhandledRejection", probe);
  }
});

test("endRun 抛错也不影响 completion settle 与终态事件", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const { factory } = fakeFactory(async function* () {
    yield resultMessage("ok", "r1", "s");
  });
  const gate: ActivityGate = {
    isIdle: () => true,
    beginRun: () => undefined,
    endRun: () => { throw new Error("tracker glitch"); },
  };
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });
  assert.deepEqual(await handle.completion, { state: "done" });
  const events = await collect(handle.events);
  assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "s", state: "done" });
});
