import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DesktopTimeline } from "../src/desktop/timeline.ts";
import { TimelineRequestError } from "../src/terminal/extension.ts";

interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  [key: string]: unknown;
}

const state = {
  activity: "idle",
  canControl: true,
  warnings: ["权限确认及选择请在 Mac 的 Pi Desktop 完成"],
};

function harness(initial: Message[], options: {
  source?: string; omitSource?: boolean; omitMessageEnd?: boolean; nativeId?: string; serializedLimit?: number; rejectContentLimits?: number[];
} = {}) {
  let messages = initial;
  const nativeId = options.nativeId ?? "native-session";
  const messagesById = new Map([[nativeId, initial]]);
  let source = options.source ?? "desktop";
  let deleted = false;
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client = {
    async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ tool, args });
      assert.equal(tool, "pi_session_get");
      const id = String(args.id);
      assert.equal(args.messageLimit, 50);
      const contentLimit = args.contentLimit as number;
      assert.ok([64_000, 32_000, 16_000, 8_000, 4_000].includes(contentLimit));
      if (options.rejectContentLimits?.includes(contentLimit)) {
        throw Object.assign(new Error("MCP_RESULT_LIMIT"), { code: "result_too_large" });
      }
      if (deleted) return {};
      const sessionMessages = messagesById.get(id) ?? messages;
      const count = sessionMessages.length;
      const end = args.messageBefore === undefined ? count : Math.min(args.messageBefore as number, count);
      const limit = Math.min(args.messageLimit as number, 50);
      const start = Math.max(0, end - limit);
      const pageMessages = sessionMessages.slice(start, end).map(message => ({
        ...message,
        content: Buffer.from(message.content).subarray(0, contentLimit).toString(),
        ...(typeof message.toolResult === "string" ? { toolResult: message.toolResult.slice(0, contentLimit) } : {}),
      }));
      const session: Record<string, unknown> = {
        id,
        ...(options.omitSource ? {} : { source }),
        messages: pageMessages,
        messageStart: start,
        messageCount: count,
        hasMoreBefore: start > 0,
        hasMoreAfter: end < count,
      };
      if (!options.omitMessageEnd) session.messageEnd = end;
      const result = { session };
      if (Buffer.byteLength(JSON.stringify(result)) > (options.serializedLimit ?? 512 * 1024)) {
        throw Object.assign(new Error("MCP_RESULT_LIMIT"), { code: "result_too_large" });
      }
      return result;
    },
  };
  return {
    timeline: new DesktopTimeline(client),
    calls,
    setMessages(value: Message[]) { messages = value; messagesById.set(nativeId, value); },
    setMessagesFor(id: string, value: Message[]) { messagesById.set(id, value); },
    setSource(value: string) { source = value; },
    deleteSession() { deleted = true; },
  };
}

function user(id: string, content = "same body"): Message {
  return { id, role: "user", content };
}

function itemIds(page: Record<string, unknown>): string[] {
  return (page.items as { id: string }[]).map(item => item.id);
}

function assertIds(actual: string[], expected: string[]): void {
  const mismatch = actual.findIndex((id, index) => id !== expected[index]);
  assert.equal(mismatch, -1, `expected ${expected.length} ids, got ${actual.length}; first mismatch at ${mismatch}: ${actual[mismatch]} != ${expected[mismatch]}`);
  assert.equal(actual.length, expected.length);
}

test("downshifts content only after serialized MCP result exceeds the limit and reuses the session level", async () => {
  const messages = Array.from({ length: 50 }, (_, index) => user(`large-${index}`, "x".repeat(64_000)));
  const fixture = harness(messages);
  const first = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  assert.deepEqual(fixture.calls.slice(0, 4).map(call => call.args.contentLimit), [64_000, 32_000, 16_000, 8_000]);
  assert.ok((first.warnings as string[]).includes("为避免内容超限，当前读取精简正文；完整内容请在 Pi Desktop 查看"));
  const count = fixture.calls.length;
  const next = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  assert.equal(fixture.calls.length, count + 1);
  assert.equal(fixture.calls.at(-1)?.args.contentLimit, 8_000);
  assert.ok((next.warnings as string[]).includes("为避免内容超限，当前读取精简正文；完整内容请在 Pi Desktop 查看"));
});

test("content levels are isolated by session and every failed level terminates with a typed error", async () => {
  const messages = Array.from({ length: 50 }, (_, index) => user(`large-${index}`, "x".repeat(64_000)));
  const fixture = harness(messages);
  const slim = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const other = Array.from({ length: 2 }, (_, index) => user(`other-${index}`));
  fixture.setMessagesFor("other-session", other);
  await fixture.timeline.get("other-session", "managed:desktop:other-session", {}, state);
  assert.equal(fixture.calls.at(-1)?.args.contentLimit, 64_000);
  assert.ok((slim.warnings as string[]).includes("为避免内容超限，当前读取精简正文；完整内容请在 Pi Desktop 查看"));

  const impossible = harness([user("large", "x")], { serializedLimit: 1 });
  await assert.rejects(
    impossible.timeline.get("native-session", "managed:desktop:native-session", {}, state),
    error => error instanceof TimelineRequestError && error.code === "result_too_large" && /Pi Desktop/.test(error.message),
  );
  assert.deepEqual(impossible.calls.map(call => call.args.contentLimit), [64_000, 32_000, 16_000, 8_000, 4_000]);
});

test("non-size tool failures are not retried", async () => {
  let calls = 0;
  const timeline = new DesktopTimeline({ call: async () => { calls++; throw Object.assign(new Error("tool failed"), { code: "tool_error" }); } });
  await assert.rejects(timeline.get("native-session", "managed:desktop:native-session", {}, state), error =>
    (error as { code?: string }).code === "tool_error");
  assert.equal(calls, 1);
});

test("branches and tool details include the reduced-content warning", async () => {
  const fixture = harness([{
    id: "oversized-tool", role: "tool", content: "r".repeat(12_000), toolName: "shell", toolCallId: "tool-call",
    toolStatus: "success", toolArgs: { command: "safe" }, toolResult: "r".repeat(12_000),
  }], { serializedLimit: 20_000 });
  const page = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const warning = "为避免内容超限，当前读取精简正文；完整内容请在 Pi Desktop 查看";
  assert.ok((page.warnings as string[]).includes(warning));
  const branches = await fixture.timeline.get("native-session", "managed:desktop:native-session", { view: "branches" }, state);
  assert.ok((branches.warnings as string[]).includes(warning));
  const call = (page.items as Record<string, unknown>[]).find(item => item.kind === "toolCall");
  const detail = await fixture.timeline.get("native-session", "managed:desktop:native-session", {
    view: "tool", detailId: call?.detailId, revision: page.revision, field: "arguments",
  }, state);
  assert.ok((detail.warnings as string[]).includes(warning));
});

test("downshifts invalidate anchored views and cursors and change revisions", async () => {
  const options: { rejectContentLimits?: number[] } = { rejectContentLimits: [] };
  const fixture = harness(Array.from({ length: 60 }, (_, index) => user(`anchor-${index}`)), options);
  const first = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const cursor = (first.page as { before: string }).before;
  assert.equal(typeof cursor, "string");
  const revision = String(first.revision);
  fixture.setMessages(Array.from({ length: 60 }, (_, index) => user(`anchor-${index}`, "x".repeat(60_000))));
  options.rejectContentLimits = [64_000, 32_000];
  await assert.rejects(fixture.timeline.get("native-session", "managed:desktop:native-session", {
    beforeItemId: itemIds(first).at(-1),
  }, state), error => error instanceof TimelineRequestError && error.code === "refresh_required");
  assert.equal(fixture.calls.at(-1)?.args.contentLimit, 64_000);
  options.rejectContentLimits = [];
  const refreshed = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  assert.equal(fixture.calls.at(-1)?.args.contentLimit, 8_000);
  assert.notEqual(refreshed.revision, revision);
  await assert.rejects(fixture.timeline.get("native-session", "managed:desktop:native-session", { before: cursor }, state),
    error => error instanceof TimelineRequestError && error.code === "refresh_required");
});

test("a late pre-downshift response cannot overwrite the new session cache level", async () => {
  let releaseOld: ((value: unknown) => void) | undefined;
  let calls = 0;
  const messages = [user("concurrent")];
  const makeSession = (): unknown => ({ session: { id: "native-session", source: "desktop", messages,
    messageStart: 0, messageEnd: 1, messageCount: 1, hasMoreBefore: false, hasMoreAfter: false } });
  const timeline = new DesktopTimeline({ call: async (_tool, args) => {
    calls++;
    if (args.contentLimit === 64_000 && calls === 1) return new Promise(resolve => { releaseOld = resolve; });
    if (args.contentLimit === 64_000) throw Object.assign(new Error("too large"), { code: "result_too_large" });
    return makeSession();
  } });
  const old = timeline.get("native-session", "managed:desktop:native-session", {}, state);
  await new Promise(resolve => setImmediate(resolve));
  const current = await timeline.get("native-session", "managed:desktop:native-session", {}, state);
  assert.equal((current.items as unknown[]).length, 1);
  releaseOld?.(makeSession());
  await assert.rejects(old, error => error instanceof TimelineRequestError && error.code === "refresh_required");
  await timeline.get("native-session", "managed:desktop:native-session", {}, state);
  assert.equal(calls, 4);
});

test("before, beforeItemId and afterItemId pagination preserve long-session message order", async () => {
  const messages = Array.from({ length: 123 }, (_, index) => user(`ordered-${index}`));
  const fixture = harness(messages, { serializedLimit: Number.MAX_SAFE_INTEGER });
  const latest = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const beforeAnchor = itemIds(latest).find(id => id.includes(createStableId("ordered-100")))!;
  const before = await fixture.timeline.get("native-session", "managed:desktop:native-session", {
    beforeItemId: beforeAnchor, limit: 10,
  }, state);
  const expectedBefore = messages.slice(90, 100).map(message => `desktop:${createStableId(message.id)}:block-0`);
  assertIds(itemIds(before), expectedBefore);
  const after = await fixture.timeline.get("native-session", "managed:desktop:native-session", {
    afterItemId: itemIds(before).at(-1), limit: 10,
  }, state);
  const expectedAfter = messages.slice(100, 110).map(message => `desktop:${createStableId(message.id)}:block-0`);
  assertIds(itemIds(after), expectedAfter);

  let page = latest;
  const reverse: string[] = [...itemIds(latest)];
  while ((page.page as { before: string | null }).before) {
    page = await fixture.timeline.get("native-session", "managed:desktop:native-session", {
      before: (page.page as { before: string }).before,
    }, state);
    reverse.unshift(...itemIds(page));
  }
  assertIds(reverse, messages.map(message => `desktop:${createStableId(message.id)}:block-0`));
});

test("forward output-budget clipping resumes after the actual returned tail", async () => {
  const messages = Array.from({ length: 123 }, (_, index) => ({
    ...user(`budget-${index}`),
    ...(index >= 83 && index < 103 ? { attachments: Array.from({ length: 100 }, () => ({ name: "n".repeat(128) })) } : {}),
  }));
  const fixture = harness(messages, { serializedLimit: Number.MAX_SAFE_INTEGER });
  const latest = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const anchor = `desktop:${createStableId("budget-83")}:block-0`;
  let page = await fixture.timeline.get("native-session", "managed:desktop:native-session", { afterItemId: anchor }, state);
  assert.ok(itemIds(page).length < 50, "the view service should trim the forward page to its output budget");
  const received = itemIds(page);
  while ((page.page as { hasMoreAfter: boolean }).hasMoreAfter) {
    page = await fixture.timeline.get("native-session", "managed:desktop:native-session", {
      afterItemId: itemIds(page).at(-1),
    }, state);
    received.push(...itemIds(page));
  }
  const expected = messages.slice(83).flatMap(message => [
    ...(message.id === "budget-83" ? [] : [`desktop:${createStableId(message.id)}:block-0`]),
    ...(message.attachments ? [`desktop:${createStableId(message.id)}:attachments`] : []),
  ]);
  assertIds(received, expected);
});

test("paginates more than 110 native messages with stable ids and physical before cursors", async () => {
  const messages = Array.from({ length: 123 }, (_, index) => user(`message-${index}`));
  const fixture = harness(messages);
  let page = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  assert.equal(page.sessionId, "managed:desktop:native-session");
  assert.equal(page.viewVersion, 2);
  assert.equal(page.branchId, "desktop:main");
  assert.equal((page.items as unknown[]).length, 50);
  assert.equal((page.page as { hasMoreBefore: boolean }).hasMoreBefore, true);
  assert.equal((page.warnings as string[])[0], state.warnings[0]);
  const allIds = itemIds(page);
  assert.equal(new Set(allIds).size, 50);
  assert.deepEqual(fixture.calls[0]?.args, {
    id: "native-session", messageLimit: 50, contentLimit: 64_000,
  });

  while ((page.page as { before: string | null }).before) {
    page = await fixture.timeline.get("native-session", "managed:desktop:native-session", {
      before: (page.page as { before: string }).before,
    }, state);
    allIds.unshift(...itemIds(page));
  }
  assert.equal(allIds.length, messages.length);
  assert.equal(new Set(allIds).size, messages.length);
  assert.deepEqual(allIds, messages.map(message => `desktop:${createStableId(message.id)}:block-0`));
  assert.ok(fixture.calls.slice(1).every(call => typeof call.args.messageBefore === "number"));
});

function createStableId(value: string): string {
  return createHash("sha256").update(`native-session\0${value}`).digest("base64url");
}


test("accepts the installed session shape without optional messageEnd", async () => {
  const fixture = harness(Array.from({ length: 65 }, (_, index) => user(`old-${index}`)), { omitMessageEnd: true });
  const first = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  assert.equal((first.items as unknown[]).length, 50);
  const cursor = (first.page as { before: string }).before;
  const previous = await fixture.timeline.get("native-session", "managed:desktop:native-session", { before: cursor }, state);
  assert.equal((previous.items as unknown[]).length, 15);
  assert.equal(fixture.calls.at(-1)?.args.messageBefore, 15);
});

test("item anchors catch up across multiple pages and detect rewritten live anchors", async () => {
  const messages = Array.from({ length: 100 }, (_, index) => user(`catchup-${index}`));
  const fixture = harness(messages);
  const initial = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const anchor = itemIds(initial).at(-1)!;
  fixture.setMessages([...messages, ...Array.from({ length: 117 }, (_, index) => user(`later-${index}`))]);

  let page = await fixture.timeline.get("native-session", "managed:desktop:native-session", { afterItemId: anchor }, state);
  assert.equal((page.items as unknown[]).length, 50);
  assert.equal((page.items as { text: string }[])[0]?.text, "same body");
  assert.equal((page.page as { hasMoreAfter: boolean }).hasMoreAfter, true);
  let caught = itemIds(page);
  while ((page.page as { hasMoreAfter: boolean }).hasMoreAfter) {
    page = await fixture.timeline.get("native-session", "managed:desktop:native-session", {
      afterItemId: itemIds(page).at(-1),
    }, state);
    caught.push(...itemIds(page));
  }
  assert.equal(caught.length, 117);
  assert.equal(new Set(caught).size, 117);

  const oldAnchorPage = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const staleAnchor = itemIds(oldAnchorPage).at(-1)!;
  const changed = [...messages, ...Array.from({ length: 117 }, (_, index) => user(`later-${index}`))];
  changed[216] = user("later-116", "rewritten answer");
  fixture.setMessages(changed);
  await assert.rejects(
    fixture.timeline.get("native-session", "managed:desktop:native-session", { afterItemId: staleAnchor }, state),
    error => error instanceof TimelineRequestError && /刷新/.test(error.message),
  );
});

test("keeps repeated content distinct and converts safe tool details through the existing viewer", async () => {
  const fixture = harness([
    user("repeat-a"),
    user("repeat-b"),
    {
      id: "tool-1",
      role: "tool",
      content: "short result",
      toolName: "read_file",
      toolCallId: "call-1",
      toolStatus: "success",
      toolArgs: { path: "/private/file.txt", api_key: "synthetic-secret" },
      toolResult: { text: "result text", path: "/private/result.txt" },
    },
    {
      id: "tool-2",
      role: "tool",
      content: "",
      toolName: "shell",
      toolCallId: "call-2",
      toolStatus: "running",
      toolArgs: { command: "echo safe" },
    },
  ]);
  const page = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const items = page.items as Record<string, unknown>[];
  const repeated = items.filter(item => item.kind === "message" && item.text === "same body");
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0]?.id, repeated[1]?.id);
  const call = items.find(item => item.kind === "toolCall");
  const result = items.find(item => item.kind === "toolResult");
  const running = items.find(item => item.kind === "toolCall" && item.name === "shell");
  assert.equal(call?.status, "succeeded");
  assert.equal(result?.status, "succeeded");
  assert.equal(running?.status, "running");
  assert.ok(!JSON.stringify(page).includes("synthetic-secret"));
  assert.ok(!JSON.stringify(page).includes("/private/result.txt"));
  assert.ok(typeof call?.detailId === "string");

  const detail = await fixture.timeline.get("native-session", "managed:desktop:native-session", {
    view: "tool", detailId: call?.detailId, revision: page.revision, field: "arguments",
  }, state);
  assert.equal(detail.field, "arguments");
  assert.match(String(detail.text), /\[已隐藏\]/);
  assert.ok(!JSON.stringify(detail).includes("synthetic-secret"));
});

test("shows only safe attachment names and excludes thinking, system, and model instructions", async () => {
  const fixture = harness([
    { id: "system-1", role: "system", content: "do not display" },
    {
      id: "user-1", role: "user", content: "visible body", thinking: "private thinking",
      modelSystem: { messageJson: "private instructions" },
      attachments: [{ name: "folder/notes.txt", ref: "/Users/alice/private/notes.txt", data: "secret-bytes" }],
    },
  ]);
  const page = await fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  const serialized = JSON.stringify(page);
  assert.match(serialized, /notes\.txt/);
  assert.match(serialized, /visible body/);
  for (const privateValue of ["do not display", "private thinking", "private instructions", "/Users/alice/private/notes.txt", "secret-bytes"]) {
    assert.ok(!serialized.includes(privateValue), `must not expose ${privateValue}`);
  }
});

test("rejects remote ownership even when a second history read claims desktop source", async () => {
  const timeline = new DesktopTimeline({ call: async () => ({ session: {
    id: "native-session", source: "desktop", remoteHostKey: "other-host", messages: [],
    messageStart: 0, messageEnd: 0, messageCount: 0,
  } }) });
  await assert.rejects(timeline.get("native-session", "managed:desktop:native-session", {}, state), TimelineRequestError);
});

test("rejects missing, deleted, and non-desktop sessions, and unknown anchors require refresh", async () => {
  const fixture = harness([user("valid")]);
  fixture.setSource("pi-native");
  await assert.rejects(fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state), TimelineRequestError);
  fixture.setSource("desktop");
  fixture.deleteSession();
  await assert.rejects(fixture.timeline.get("native-session", "managed:desktop:native-session", {}, state), TimelineRequestError);

  const another = harness([user("one")]);
  await another.timeline.get("native-session", "managed:desktop:native-session", {}, state);
  await assert.rejects(another.timeline.get("native-session", "managed:desktop:native-session", {
    afterItemId: "not-cached",
  }, state), error => error instanceof TimelineRequestError && /refresh-required/.test(error.message));
  const untrustedMissingSource = harness([user("one")], { omitSource: true, nativeId: "native-pi:session" });
  await assert.rejects(untrustedMissingSource.timeline.get("native-pi:session", "managed:desktop:native-pi:session", {}, state), TimelineRequestError);
});
