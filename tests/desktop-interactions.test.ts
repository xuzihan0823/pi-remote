import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopInteractionError,
  DESKTOP_INTERACTION_LIMITS,
  readDesktopInteractions,
  resolveDesktopInteraction,
} from "../src/desktop/interactions.ts";
import type { DesktopPendingInteraction, DesktopUiResponse } from "../src/protocol/types.ts";

interface Call {
  tool: string;
  args?: Record<string, unknown>;
}

class FakeClient {
  readonly calls: Call[] = [];
  pending: unknown = pendingResult();
  resolver: (operation: unknown, args: Record<string, unknown> | undefined) => unknown = () => ({ ok: true });

  async call(tool: string, args?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool, args });
    if (tool !== "pi_desktop_invoke") throw new Error(`unexpected tool: ${tool}`);
    if (args?.operation === "agent/pendingInteractive") return this.pending;
    return this.resolver(args?.operation, args);
  }

  get resolverCalls(): Call[] {
    return this.calls.filter(call => call.args?.operation !== "agent/pendingInteractive");
  }
}

function pendingResult(asks: unknown[] = [], permissions: unknown[] = []): unknown {
  return { operation: "agent/pendingInteractive", result: { asks, permissions } };
}

function permission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "perm-1",
    sessionId: "native-1",
    toolCallId: "call-1",
    toolName: "Bash",
    argsPreview: { command: "rm -rf build" },
    risk: "high",
    reason: "需要执行命令",
    ...overrides,
  };
}

function ask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "ask-1",
    sessionId: "native-1",
    toolCallId: "call-2",
    questions: [{ question: "继续？", options: ["是", "否"] }],
    ...overrides,
  };
}

function resolverSuccess(operation: string, result: unknown = { ok: true }): unknown {
  return { operation, result };
}

function bidi(code: number): string {
  return String.fromCodePoint(code);
}

function hasRawDirectionCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0)!;
    return code === 0x061c || code === 0x200e || code === 0x200f || code === 0x2028 || code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });
}

function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, error => {
    assert.ok(error instanceof DesktopInteractionError);
    assert.equal(error.code, code);
    return true;
  }) as Promise<void>;
}

test("read maps pending permissions and questions while preserving selectable labels", async () => {
  const client = new FakeClient();
  client.pending = pendingResult([
    ask({
      questions: [
        {
          question: "选择目标",
          options: [" 保留空格 ", { label: "B", description: `\u001b[31m红色\u001b[0m` }],
          multiSelect: true,
        },
        { question: "继续？", options: [{ label: "是" }] },
      ],
    }),
  ], [
    permission({ agentName: "子代理", argsPreview: { command: "rm -rf build", flags: [1, true, null] } }),
  ]);

  const result = await readDesktopInteractions(client, "native-1", "managed:desktop:native-1");

  assert.deepEqual(client.calls, [{
    tool: "pi_desktop_invoke",
    args: { operation: "agent/pendingInteractive", args: [{ sessionId: "native-1" }] },
  }]);
  assert.deepEqual(result, [
    {
      kind: "question",
      requestId: "ask-1",
      sessionId: "managed:desktop:native-1",
      questions: [
        {
          question: "选择目标",
          options: [{ label: " 保留空格 " }, { label: "B", description: "红色" }],
          multiSelect: true,
        },
        { question: "继续？", options: [{ label: "是" }], multiSelect: false },
      ],
    },
    {
      kind: "permission",
      requestId: "perm-1",
      sessionId: "managed:desktop:native-1",
      toolName: "Bash",
      reason: "需要执行命令",
      argsPreview: '{"command":"rm -rf build","flags":[1,true,null]}',
      agentName: "子代理",
    },
  ] satisfies DesktopPendingInteraction[]);
});

test("empty options remain selectable-free questions and accept free-text answers", async () => {
  const client = new FakeClient();
  client.pending = pendingResult([ask({
    questions: [{ question: "请输入名称", options: [] }],
  })], []);

  assert.deepEqual(await readDesktopInteractions(client, "native-1", "public-1"), [{
    kind: "question",
    requestId: "ask-1",
    sessionId: "public-1",
    questions: [{ question: "请输入名称", options: [], multiSelect: false }],
  }]);

  client.resolver = () => resolverSuccess("agent/askTool/resolve");
  await resolveDesktopInteraction(client, "native-1", "public-1", "ask-1", {
    kind: "question",
    answers: [["自定义名称"]],
  });
  assert.deepEqual(client.resolverCalls, [{
    tool: "pi_desktop_invoke",
    args: {
      operation: "agent/askTool/resolve",
      args: [{ sessionId: "native-1", requestId: "ask-1", answers: [["自定义名称"]] }],
      confirm: true,
    },
  }]);
});

test("argsPreview escapes direction controls and line separators losslessly", async () => {
  const key = `tool${bidi(0x202e)}name`;
  const nestedKey = `${bidi(0x2066)}order`;
  const value = `run ${bidi(0x202a)}ls${bidi(0x2069)}`;
  const args = {
    [key]: value,
    [nestedKey]: [
      `first${bidi(0x2028)}second${bidi(0x2029)}third`,
      `lrm${bidi(0x200f)}end`,
      `alm${bidi(0x061c)}end`,
    ],
  };
  const client = new FakeClient();
  client.pending = pendingResult([], [permission({ argsPreview: args })]);

  const [interaction] = await readDesktopInteractions(client, "native-1", "public-1");
  assert.equal(interaction?.kind, "permission");
  if (interaction?.kind !== "permission") return;
  assert.equal(hasRawDirectionCharacters(interaction.argsPreview!), false);
  const slash = String.fromCharCode(92);
  assert.ok(interaction.argsPreview!.includes(`${slash}u202E`));
  assert.ok(interaction.argsPreview!.includes(`${slash}u2028`));
  assert.deepEqual(JSON.parse(interaction.argsPreview!), args);
});

test("read rejects malformed, cross-session and duplicated snapshots instead of inventing an empty list", async () => {
  const cases: Array<[string, unknown]> = [
    ["missing permissions", { operation: "agent/pendingInteractive", result: { asks: [] } }],
    ["missing result", { operation: "agent/pendingInteractive" }],
    ["wrong operation", { operation: "agent/list", result: { asks: [], permissions: [] } }],
    ["non-array asks", { operation: "agent/pendingInteractive", result: { asks: {}, permissions: [] } }],
    ["null item", pendingResult([null], [])],
    ["empty requestId", pendingResult([], [permission({ requestId: "" })])],
    ["whitespace requestId", pendingResult([], [permission({ requestId: "   " })])],
    ["long requestId", pendingResult([], [permission({ requestId: "x".repeat(513) })])],
    ["cross-session permission", pendingResult([], [permission({ sessionId: "native-2" })])],
    ["cross-session ask", pendingResult([ask({ sessionId: "native-2" })], [])],
    ["duplicate identity", pendingResult([ask({ requestId: "same" })], [permission({ requestId: "same" })])],
    ["too many questions", pendingResult([ask({
      questions: Array.from({ length: DESKTOP_INTERACTION_LIMITS.questionsPerAsk + 1 }, (_, index) => ({
        question: `Q${index}`, options: ["A"],
      })),
    })], [])],
    ["too many options", pendingResult([ask({
      questions: [{
        question: "Q",
        options: Array.from({ length: DESKTOP_INTERACTION_LIMITS.optionsPerQuestion + 1 }, (_, index) => `O${index}`),
      }],
    })], [])],
    ["too many requests", pendingResult([], Array.from({ length: DESKTOP_INTERACTION_LIMITS.requestsPerSnapshot + 1 },
      (_, index) => permission({ requestId: `perm-${index}` })))],
    ["missing argsPreview", pendingResult([], [{ requestId: "perm-1", sessionId: "native-1", toolName: "Bash", reason: "" }])],
  ];
  const cyclic: Record<string, unknown> = { command: "x" };
  cyclic.self = cyclic;
  cases.push(["cyclic argsPreview", pendingResult([], [permission({ argsPreview: cyclic })])]);

  for (const [label, value] of cases) {
    const client = new FakeClient();
    client.pending = value;
    await assert.rejects(
      readDesktopInteractions(client, "native-1", "managed:desktop:native-1"),
      error => {
        assert.ok(error instanceof DesktopInteractionError, label);
        assert.equal(error.code, "invalid_frame", label);
        return true;
      },
    );
  }
});

test("read enforces per-field and snapshot byte limits", async () => {
  const overField = new FakeClient();
  overField.pending = pendingResult([], [permission({ reason: "x".repeat(DESKTOP_INTERACTION_LIMITS.fieldBytes + 1) })]);
  await rejectsCode(readDesktopInteractions(overField, "native-1", "public-1"), "invalid_frame");

  const overSnapshot = new FakeClient();
  overSnapshot.pending = pendingResult([], Array.from({ length: 5 }, (_, index) => permission({
    requestId: `perm-${index}`,
    reason: "x".repeat(60_000),
  })));
  await rejectsCode(readDesktopInteractions(overSnapshot, "native-1", "public-1"), "invalid_frame");

  const escapedOverflow = new FakeClient();
  escapedOverflow.pending = pendingResult([], [permission({
    argsPreview: { value: bidi(0x202e).repeat(11_000) },
  })]);
  await rejectsCode(readDesktopInteractions(escapedOverflow, "native-1", "public-1"), "invalid_frame");
});

test("resolve sends exact permission allow-once and deny params", async () => {
  for (const decision of ["allow-once", "deny"] as const) {
    const client = new FakeClient();
    client.pending = pendingResult([], [permission()]);
    client.resolver = () => resolverSuccess("tool/resolvePermission");
    await resolveDesktopInteraction(client, "native-1", "managed:desktop:native-1", "perm-1", {
      kind: "permission",
      decision,
    });
    assert.deepEqual(client.calls, [
      { tool: "pi_desktop_invoke", args: { operation: "agent/pendingInteractive", args: [{ sessionId: "native-1" }] } },
      {
        tool: "pi_desktop_invoke",
        args: {
          operation: "tool/resolvePermission",
          args: [{ requestId: "perm-1", decision }],
          confirm: true,
        },
      },
    ]);
  }
});

test("resolve rejects invalid decisions, kind mismatch and extra fields without writing", async () => {
  const responses: unknown[] = [
    { kind: "permission", decision: "allow-session" },
    { kind: "permission", decision: "allow" },
    { kind: "permission", decision: "allow-once", answers: [] },
    { kind: "question", answers: [null] },
    { kind: "permission" },
  ];
  for (const response of responses) {
    const client = new FakeClient();
    client.pending = pendingResult([], [permission()]);
    client.resolver = () => resolverSuccess("tool/resolvePermission");
    await rejectsCode(
      resolveDesktopInteraction(client, "native-1", "public-1", "perm-1", response as DesktopUiResponse),
      "invalid_frame",
    );
    assert.deepEqual(client.resolverCalls, []);
  }

  const missing = new FakeClient();
  missing.pending = pendingResult([], [permission()]);
  await rejectsCode(resolveDesktopInteraction(missing, "native-1", "public-1", "missing", {
    kind: "permission", decision: "deny",
  }), "not_found");
  assert.deepEqual(missing.resolverCalls, []);

  const crossSession = new FakeClient();
  crossSession.pending = pendingResult([], [permission()]);
  await rejectsCode(resolveDesktopInteraction(crossSession, "native-2", "public-2", "perm-1", {
    kind: "permission", decision: "deny",
  }), "invalid_frame");
  assert.deepEqual(crossSession.resolverCalls, []);
});

test("resolve sends multi-select, single-select, free-text and null answers exactly", async () => {
  const client = new FakeClient();
  client.pending = pendingResult([ask({
    questions: [
      { question: "多选", options: ["A", "B"], multiSelect: true },
      { question: "单选", options: ["C", "D"], multiSelect: false },
      { question: "跳过", options: ["E"] },
    ],
  })], []);
  client.resolver = () => resolverSuccess("agent/askTool/resolve");

  await resolveDesktopInteraction(client, "native-1", "public-1", "ask-1", {
    kind: "question",
    answers: [["A", "自定义文本"], null, ["C"]],
  });

  assert.deepEqual(client.calls[1], {
    tool: "pi_desktop_invoke",
    args: {
      operation: "agent/askTool/resolve",
      args: [{
        sessionId: "native-1",
        requestId: "ask-1",
        answers: [["A", "自定义文本"], null, ["C"]],
      }],
      confirm: true,
    },
  });

  const invalidAnswers: unknown[] = [
    [],
    [["A"], null],
    [["A"], ["C", "D"], ["C"]],
    [[""], null, ["C"]],
    [["   "], null, ["C"]],
    [["A", 1], null, ["C"]],
    [[String.fromCharCode(27) + "[31m"], null, ["C"]],
  ];
  for (const answers of invalidAnswers) {
    const invalid = new FakeClient();
    invalid.pending = client.pending;
    invalid.resolver = () => resolverSuccess("agent/askTool/resolve");
    await rejectsCode(resolveDesktopInteraction(invalid, "native-1", "public-1", "ask-1", {
      kind: "question",
      answers,
    } as unknown as DesktopUiResponse), "invalid_frame");
    assert.deepEqual(invalid.resolverCalls, []);
  }

  const extraField = new FakeClient();
  extraField.pending = client.pending;
  await rejectsCode(resolveDesktopInteraction(extraField, "native-1", "public-1", "ask-1", {
    kind: "question",
    answers: [["A"], null, ["C"]],
    requestId: "other",
  } as unknown as DesktopUiResponse), "invalid_frame");
  assert.deepEqual(extraField.resolverCalls, []);
});

test("resolve enforces answer byte limits", async () => {
  const client = new FakeClient();
  client.pending = pendingResult([ask({
    questions: [{ question: "多选", options: ["A"], multiSelect: true }],
  })], []);
  await rejectsCode(resolveDesktopInteraction(client, "native-1", "public-1", "ask-1", {
    kind: "question",
    answers: [["x".repeat(DESKTOP_INTERACTION_LIMITS.fieldBytes + 1)]],
  }), "invalid_frame");
  assert.deepEqual(client.resolverCalls, []);

  const total = new FakeClient();
  total.pending = pendingResult([ask({
    questions: [{ question: "多选", options: ["A"], multiSelect: true }],
  })], []);
  await rejectsCode(resolveDesktopInteraction(total, "native-1", "public-1", "ask-1", {
    kind: "question",
    answers: [Array.from({ length: 5 }, () => "x".repeat(60_000))],
  }), "invalid_frame");
  assert.deepEqual(total.resolverCalls, []);
});

test("resolve never acknowledges false, malformed or failed resolver results", async () => {
  const failures: Array<[string, unknown]> = [
    ["ok false", resolverSuccess("tool/resolvePermission", { ok: false })],
    ["empty result", resolverSuccess("tool/resolvePermission", {})],
    ["wrong operation", resolverSuccess("tool/other")],
    ["missing result", { operation: "tool/resolvePermission" }],
  ];
  for (const [, response] of failures) {
    const client = new FakeClient();
    client.pending = pendingResult([], [permission()]);
    client.resolver = () => response;
    await rejectsCode(resolveDesktopInteraction(client, "native-1", "public-1", "perm-1", {
      kind: "permission", decision: "allow-once",
    }), "result_uncertain");
  }

  const expired = new FakeClient();
  expired.pending = pendingResult([], [permission()]);
  expired.resolver = () => { throw Object.assign(new Error("gone"), { code: "tool_error" }); };
  await rejectsCode(resolveDesktopInteraction(expired, "native-1", "public-1", "perm-1", {
    kind: "permission", decision: "deny",
  }), "result_uncertain");

  const uncertain = new FakeClient();
  uncertain.pending = pendingResult([], [permission()]);
  uncertain.resolver = () => { throw Object.assign(new Error("network"), { code: "result_uncertain" }); };
  await rejectsCode(resolveDesktopInteraction(uncertain, "native-1", "public-1", "perm-1", {
    kind: "permission", decision: "deny",
  }), "result_uncertain");
});

test("resolve re-reads pending each time and reports a vanished request", async () => {
  const client = new FakeClient();
  client.pending = pendingResult([], [permission()]);
  client.resolver = () => resolverSuccess("tool/resolvePermission");

  await resolveDesktopInteraction(client, "native-1", "public-1", "perm-1", { kind: "permission", decision: "deny" });
  await resolveDesktopInteraction(client, "native-1", "public-1", "perm-1", { kind: "permission", decision: "deny" });
  assert.equal(client.calls.filter(call => call.args?.operation === "agent/pendingInteractive").length, 2);
  assert.equal(client.resolverCalls.length, 2);

  client.pending = pendingResult();
  await rejectsCode(resolveDesktopInteraction(client, "native-1", "public-1", "perm-1", {
    kind: "permission", decision: "deny",
  }), "not_found");
  assert.equal(client.resolverCalls.length, 2);
});
