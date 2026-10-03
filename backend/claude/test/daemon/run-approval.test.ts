// ApprovalBridge：审批 allow/deny/超时/重复决策、question 拆分串行合并、
// permission-adapter 集成与 TurnRunner 全链路。interactions 全用 :memory:。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adaptSdkMessage,
  createPermissionAdapter,
  type PermissionRequest,
  type QueryFactory,
} from "../../src/agent-bridge/index.ts";
import { InteractionManager, InteractionStore, type QuestionItem } from "../../src/interactions/index.ts";
import { ApprovalBridge, type ApprovalCard, type ApprovalEvent } from "../../src/run/approval.ts";
import { TurnRunner, type ActivityGate } from "../../src/run/runner.ts";

type QueryParams = Parameters<QueryFactory>[0];
type SdkQuery = ReturnType<QueryFactory>;
type AnySdkMessage = Parameters<typeof adaptSdkMessage>[0];
type CanUseToolFn = ReturnType<typeof createPermissionAdapter>;
type ToolOptions = Parameters<CanUseToolFn>[2];

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  manager: InteractionManager;
  bridge: ApprovalBridge;
  events: ApprovalEvent[];
  cards(): ApprovalCard[];
  resolved(): Array<Extract<ApprovalEvent, { type: "approval.resolved" }>>;
  close(): void;
}

function harness(options: { ttlMs?: number } = {}): Harness {
  const store = new InteractionStore(":memory:");
  const manager = new InteractionManager(
    store,
    options.ttlMs === undefined ? {} : { defaultTtlMs: options.ttlMs },
  );
  const events: ApprovalEvent[] = [];
  const bridge = new ApprovalBridge({ manager, onEvent: (event) => { events.push(event); } });
  return {
    manager,
    bridge,
    events,
    cards: () => events.filter((e): e is Extract<ApprovalEvent, { type: "approval" }> => e.type === "approval")
      .map((e) => e.interaction),
    resolved: () => events.filter((e): e is Extract<ApprovalEvent, { type: "approval.resolved" }> => e.type === "approval.resolved"),
    close: () => {
      manager.close();
      store.close();
    },
  };
}

function approvalRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: "req-1",
    sessionKey: "sess-1",
    userId: "web",
    kind: "approval",
    toolName: "Bash",
    input: { command: "ls" },
    prompt: "Run Bash?",
    ...overrides,
  };
}

const q1: QuestionItem = {
  question: "Which database?",
  header: "DB",
  multiSelect: false,
  options: [
    { label: "SQLite", description: "local file" },
    { label: "Postgres", description: "server" },
  ],
};
const q2: QuestionItem = {
  question: "Which cache?",
  header: "Cache",
  multiSelect: false,
  options: [
    { label: "Memory", description: "in-process" },
    { label: "Redis", description: "server" },
  ],
};

test("approval allow：卡片事件 → decide 唤醒 waiter → resolved 事件恰好一条", async () => {
  const app = harness();
  try {
    const pending = app.bridge.request(approvalRequest(), new AbortController().signal);
    await tick();

    const cards = app.cards();
    assert.equal(cards.length, 1);
    const card = cards[0]!;
    assert.equal(card.kind, "approval");
    assert.equal(card.toolName, "Bash");
    assert.equal(card.sessionId, "sess-1");
    assert.deepEqual(card.input, { command: "ls" });
    assert.equal(card.prompt, "Run Bash?");
    assert.ok(card.expiresAt > Date.now());

    const outcome = app.bridge.decide(card.interactionId, { type: "allow_once" });
    assert.deepEqual(outcome, { status: "allowed" });
    assert.deepEqual(await pending, { type: "allow_once" });

    await tick();
    assert.deepEqual(app.resolved(), [
      { type: "approval.resolved", interactionId: card.interactionId, status: "allowed" },
    ]);
  } finally {
    app.close();
  }
});

test("approval deny 带消息：decision 原样返回，resolved=denied", async () => {
  const app = harness();
  try {
    const pending = app.bridge.request(approvalRequest(), new AbortController().signal);
    await tick();
    const card = app.cards()[0]!;

    assert.deepEqual(app.bridge.decide(card.interactionId, { type: "deny", message: "太危险" }), { status: "denied" });
    assert.deepEqual(await pending, { type: "deny", message: "太危险" });
    await tick();
    assert.deepEqual(app.resolved(), [
      { type: "approval.resolved", interactionId: card.interactionId, status: "denied" },
    ]);
  } finally {
    app.close();
  }
});

test("超时：interactions TTL auto-deny，resolved=expired，事后 decide 得 already_resolved", async () => {
  const app = harness({ ttlMs: 20 });
  try {
    const pending = app.bridge.request(approvalRequest(), new AbortController().signal);
    await sleep(80);

    const decision = await pending;
    assert.equal(decision.type, "deny");

    const resolved = app.resolved();
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.status, "expired");

    const card = app.cards()[0]!;
    assert.deepEqual(app.bridge.decide(card.interactionId, { type: "allow_once" }), { status: "already_resolved" });
  } finally {
    app.close();
  }
});

test("重复决策与坏输入全是结构化结果，绝不抛异常", async () => {
  const app = harness();
  try {
    const pending = app.bridge.request(approvalRequest(), new AbortController().signal);
    await tick();
    const card = app.cards()[0]!;

    assert.deepEqual(app.bridge.decide(card.interactionId, { type: "allow_once" }), { status: "allowed" });
    // 双击第二下
    assert.deepEqual(app.bridge.decide(card.interactionId, { type: "deny" }), { status: "already_resolved" });
    assert.deepEqual(app.bridge.decide("no-such-id", { type: "allow_once" }), { status: "not_found" });
    assert.deepEqual(
      app.bridge.decide(card.interactionId, { type: "reboot" } as unknown as Parameters<Harness["bridge"]["decide"]>[1]),
      { status: "invalid", message: "unknown decision type" },
    );
    await pending;
  } finally {
    app.close();
  }
});

test("决策类型与交互种类不匹配 → invalid", async () => {
  const app = harness();
  try {
    const pendingApproval = app.bridge.request(approvalRequest(), new AbortController().signal);
    const pendingQuestion = app.bridge.request(
      approvalRequest({ kind: "question", toolName: "AskUserQuestion", input: { questions: [q1] } }),
      new AbortController().signal,
    );
    await tick();
    const [approvalCard, questionCard] = [app.cards()[0]!, app.cards()[1]!];

    const mismatch = app.bridge.decide(approvalCard.interactionId, { type: "answer", answers: { x: "y" } });
    assert.equal(mismatch.status, "invalid");
    const mismatch2 = app.bridge.decide(questionCard.interactionId, { type: "allow_once" });
    assert.equal(mismatch2.status, "invalid");
    const badAnswers = app.bridge.decide(
      questionCard.interactionId,
      { type: "answer", answers: null } as unknown as Parameters<Harness["bridge"]["decide"]>[1],
    );
    assert.equal(badAnswers.status, "invalid");
    // 缺答案（漏题）也 invalid
    const missing = app.bridge.decide(questionCard.interactionId, { type: "answer", answers: { other: "x" } });
    assert.equal(missing.status, "invalid");

    // 收尾：正常决议两个，避免悬挂 waiter
    app.bridge.decide(approvalCard.interactionId, { type: "deny" });
    app.bridge.decide(questionCard.interactionId, { type: "answer", answers: { [q1.question]: "SQLite" } });
    await Promise.all([pendingApproval, pendingQuestion]);
  } finally {
    app.close();
  }
});

test("question 多题拆单题串行：答完上一题才出下一题，answers 合并", async () => {
  const app = harness();
  try {
    const pending = app.bridge.request(
      approvalRequest({ kind: "question", toolName: "AskUserQuestion", input: { questions: [q1, q2] } }),
      new AbortController().signal,
    );
    await tick();

    assert.equal(app.cards().length, 1, "第二题不得提前出现");
    const first = app.cards()[0]!;
    assert.equal(first.kind, "question");
    assert.equal(first.toolName, "AskUserQuestion");
    assert.deepEqual(first.questions, [q1]);
    assert.equal(first.prompt, q1.question);

    assert.deepEqual(
      app.bridge.decide(first.interactionId, { type: "answer", answers: { [q1.question]: "SQLite" } }),
      { status: "answered" },
    );
    await tick();

    assert.equal(app.cards().length, 2);
    const second = app.cards()[1]!;
    assert.deepEqual(second.questions, [q2]);
    assert.deepEqual(
      app.bridge.decide(second.interactionId, { type: "answer", answers: { [q2.question]: "Redis" } }),
      { status: "answered" },
    );

    assert.deepEqual(await pending, {
      type: "answer",
      answers: { [q1.question]: "SQLite", [q2.question]: "Redis" },
    });
    await tick();
    assert.deepEqual(app.resolved().map((e) => e.status), ["answered", "answered"]);
  } finally {
    app.close();
  }
});

test("question 超时未答 → 整体折算 deny（Question was not answered）", async () => {
  const app = harness({ ttlMs: 20 });
  try {
    const pending = app.bridge.request(
      approvalRequest({ kind: "question", toolName: "AskUserQuestion", input: { questions: [q1, q2] } }),
      new AbortController().signal,
    );
    await sleep(80);
    assert.deepEqual(await pending, { type: "deny", message: "Question was not answered" });
    assert.equal(app.cards().length, 1, "首题超时后不得继续出第二题");
    assert.deepEqual(app.resolved().map((e) => e.status), ["expired"]);
  } finally {
    app.close();
  }
});

test("question input 畸形 → fail-closed deny，不抛", async () => {
  const app = harness();
  try {
    const decision = await app.bridge.request(
      approvalRequest({ kind: "question", toolName: "AskUserQuestion", input: { nope: true } }),
      new AbortController().signal,
    );
    assert.equal(decision.type, "deny");
    assert.equal(app.cards().length, 0);
  } finally {
    app.close();
  }
});

test("onEvent 监听器抛错只 warn，审批流程照常", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const store = new InteractionStore(":memory:");
  const manager = new InteractionManager(store);
  const created: string[] = [];
  const bridge = new ApprovalBridge({
    manager,
    onEvent: (event) => {
      if (event.type === "approval") created.push(event.interaction.interactionId);
      throw new Error("listener bug");
    },
  });
  try {
    const pending = bridge.request(approvalRequest(), new AbortController().signal);
    await tick();
    assert.equal(created.length, 1);
    assert.deepEqual(bridge.decide(created[0]!, { type: "allow_once" }), { status: "allowed" });
    assert.deepEqual(await pending, { type: "allow_once" });
  } finally {
    manager.close();
    store.close();
  }
});

test("permission-adapter 集成：deny 与 question answers 映射成 SDK PermissionResult", async () => {
  const app = harness();
  try {
    const canUseTool = createPermissionAdapter(app.bridge, { sessionKey: "sess-1", userId: "web" });

    const pendingDeny = canUseTool("Bash", { command: "rm -rf /" }, {
      signal: new AbortController().signal,
      requestId: "perm-1",
      toolUseID: "tool-1",
      title: "Run Bash?",
    } as ToolOptions);
    await tick();
    app.bridge.decide(app.cards()[0]!.interactionId, { type: "deny" });
    assert.deepEqual(await pendingDeny, { behavior: "deny", message: "User denied this action" });

    const input = { questions: [q1] };
    const pendingAnswer = canUseTool("AskUserQuestion", input, {
      signal: new AbortController().signal,
      requestId: "perm-2",
      toolUseID: "tool-2",
    } as ToolOptions);
    await tick();
    app.bridge.decide(app.cards()[1]!.interactionId, { type: "answer", answers: { [q1.question]: "SQLite" } });
    assert.deepEqual(await pendingAnswer, {
      behavior: "allow",
      updatedInput: { ...input, answers: { [q1.question]: "SQLite" } },
    });
  } finally {
    app.close();
  }
});

test("全链路：TurnRunner 轮次停在审批卡上，decide allow 后跑完", async () => {
  const app = harness();
  try {
    const { factory, captured } = (() => {
      const captured: { params?: QueryParams } = {};
      const factory = ((params: QueryParams): SdkQuery => {
        captured.params = params;
        async function* produce(): AsyncGenerator<AnySdkMessage, void> {
          const canUseTool = params.options?.canUseTool;
          assert.ok(canUseTool, "canUseTool must be wired");
          const result = await canUseTool("Bash", { command: "pwd" }, {
            signal: new AbortController().signal,
            requestId: "perm-9",
            toolUseID: "tool-9",
          } as Parameters<NonNullable<NonNullable<QueryParams["options"]>["canUseTool"]>>[2]);
          yield {
            type: "result", subtype: "success", is_error: false,
            result: JSON.stringify(result), uuid: "r1", session_id: "sess-full",
          } as unknown as AnySdkMessage;
        }
        const generator = produce();
        (generator as unknown as Record<string, unknown>).interrupt = async (): Promise<void> => undefined;
        (generator as unknown as Record<string, unknown>).close = (): void => undefined;
        return generator as unknown as SdkQuery;
      }) as unknown as QueryFactory;
      return { factory, captured };
    })();

    const gate: ActivityGate = { isIdle: () => true, beginRun: () => undefined, endRun: () => undefined };
    const runner = new TurnRunner({ gate, permissions: app.bridge, queryFactory: factory });
    const handle = runner.startTurn({ sessionId: "sess-full", cwd: "/tmp", text: "继续" });

    // 等审批卡出现（canUseTool 在生成器内异步触发）
    for (let i = 0; i < 100 && app.cards().length === 0; i += 1) await tick();
    const card = app.cards()[0]!;
    assert.equal(card.sessionId, "sess-full", "sessionKey 必须是被 resume 的会话 id");
    assert.equal(card.toolName, "Bash");

    assert.deepEqual(app.bridge.decide(card.interactionId, { type: "allow_once" }), { status: "allowed" });
    assert.deepEqual(await handle.completion, { state: "done" });

    const events = [];
    for await (const event of handle.events) events.push(event);
    const result = events.find((e) => e.type === "worker" && e.event.type === "result");
    assert.ok(result !== undefined && result.type === "worker" && result.event.type === "result");
    assert.deepEqual(JSON.parse(result.event.result ?? ""), {
      behavior: "allow",
      updatedInput: { command: "pwd" },
    });
    assert.ok(captured.params !== undefined);
  } finally {
    app.close();
  }
});
