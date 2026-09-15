import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RpcClient, RpcCommandError, RpcTimeoutError } from "../src/pi/rpc-client.ts";
import type { GatewayEvent } from "../src/protocol/types.ts";
import { createFakeChild, flush, type FakeChild } from "./helpers/fake-child.ts";

function createClient(fake: FakeChild): RpcClient {
  return new RpcClient({
    sessionId: "test-session",
    piBin: "pi",
    startupDelayMs: 0,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 50,
    spawnFn: fake.spawn,
  });
}

function collectEvents(client: RpcClient): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  client.onEvent((event) => events.push(event));
  return events;
}

const respond = (id: string, command: string, data?: unknown): string =>
  `${JSON.stringify({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) })}\n`;

test("send writes a JSONL request with a correlation id and resolves the matching response data", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  await client.start();

  const pending = client.send<{ sessionId: string; isStreaming: boolean }>({ type: "get_state" });
  const request = fake.lastWrittenLine();
  assert.equal(request.type, "get_state");
  assert.equal(typeof request.id, "string");
  assert.match(request.id as string, /^req_\d+$/);

  fake.pushStdout(respond(request.id as string, "get_state", { sessionId: "sess-1", isStreaming: false }));
  const data = await pending;

  assert.deepEqual(data, { sessionId: "sess-1", isStreaming: false });
  await client.close();
});

test("concurrent requests are matched by id even when responses arrive out of order", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  await client.start();

  const first = client.send<{ value: string }>({ type: "get_state" });
  const second = client.send<{ value: string }>({ type: "get_available_thinking_levels" });
  const ids = fake.writtenLines().map((line) => line.id as string);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);

  fake.pushStdout(respond(ids[1]!, "get_available_thinking_levels", { value: "second" }));
  fake.pushStdout(respond(ids[0]!, "get_state", { value: "first" }));

  assert.deepEqual(await first, { value: "first" });
  assert.deepEqual(await second, { value: "second" });
  await client.close();
});

test("a failed response rejects with RpcCommandError carrying the pi error", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  await client.start();

  const pending = client.send({ type: "set_model", provider: "x", modelId: "y" });
  const rejection = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RpcCommandError);
    assert.equal(error.command, "set_model");
    assert.match(error.message, /Model not found/);
    return true;
  });
  const id = fake.lastWrittenLine().id as string;
  fake.pushStdout(
    `${JSON.stringify({ id, type: "response", command: "set_model", success: false, error: "Model not found: x/y" })}\n`,
  );
  await rejection;
  await client.close();
});

test("a request that never gets a response rejects with RpcTimeoutError", async () => {
  const fake = createFakeChild();
  const client = new RpcClient({
    sessionId: "test-session",
    piBin: "pi",
    startupDelayMs: 0,
    requestTimeoutMs: 20,
    shutdownTimeoutMs: 50,
    spawnFn: fake.spawn,
  });
  await client.start();

  await assert.rejects(client.send({ type: "get_state" }), (error: unknown) => {
    assert.ok(error instanceof RpcTimeoutError);
    assert.equal(error.command, "get_state");
    return true;
  });
  await client.close();
});

test("message_update deltas and agent lifecycle are normalized into gateway events", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  fake.pushStdout(`${JSON.stringify({ type: "agent_start" })}\n`);
  fake.pushStdout(
    `${JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } })}\n`,
  );
  fake.pushStdout(
    `${JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " } })}\n`,
  );
  fake.pushStdout(
    `${JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" } })}\n`,
  );
  fake.pushStdout(
    `${JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "bash" } })}\n`,
  );
  fake.pushStdout(`${JSON.stringify({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "done" }] } })}\n`);
  fake.pushStdout(`${JSON.stringify({ type: "agent_settled" })}\n`);
  await flush();

  assert.deepEqual(
    events.map((event) => event.type),
    ["agent_start", "text_start", "text_delta", "text_delta", "tool_call_start", "tool_end", "agent_settled"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.text),
    ["Hello ", "world"],
  );
  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.equal(toolEnd && "text" in toolEnd ? toolEnd.text : undefined, "done");
  assert.ok(!("assistantMessageEvent" in events[2]!), "raw pi payload must not leak to gateway events");
  await client.close();
});

test("invalid JSON becomes a protocol_error event and does not break later responses", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  fake.pushStdout("this is not json\n");
  fake.pushStdout(`${JSON.stringify({ type: "response", command: "parse", success: false, error: "no id" })}\n`);
  const pending = client.send<{ sessionId: string }>({ type: "get_state" });
  const id = fake.lastWrittenLine().id as string;
  fake.pushStdout(respond(id, "get_state", { sessionId: "after-error" }));

  assert.deepEqual(await pending, { sessionId: "after-error" });
  await flush();

  const protocolErrors = events.filter((event) => event.type === "protocol_error");
  assert.equal(protocolErrors.length, 2);
  assert.match(protocolErrors[0]!.message, /Failed to parse/);
  assert.equal(protocolErrors[0]!.line, "this is not json");
  await client.close();
});

test("JSONL framing is LF-only: handles partial chunks, CRLF, and U+2028 inside JSON strings", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  fake.pushStdout('{"type":"message_update","assistantMessageEvent":');
  fake.pushStdout('{"type":"text_delta","contentIndex":0,"delta":"a\u2028b"}}\r\n');
  await flush();

  assert.equal(events.filter((event) => event.type === "protocol_error").length, 0);
  const delta = events.find((event) => event.type === "text_delta");
  assert.equal(delta && "text" in delta ? delta.text : undefined, "a\u2028b");
  await client.close();
});

test("stderr is accumulated and emitted as a gateway event", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  fake.pushStderr("warning: something\n");
  await flush();

  assert.match(client.getStderr(), /warning: something/);
  const stderr = events.find((event) => event.type === "stderr");
  assert.equal(stderr && "text" in stderr ? stderr.text : undefined, "warning: something\n");
  await client.close();
});

test("abort sends an RPC abort command and resolves on its response", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  await client.start();

  const pending = client.abort();
  const request = fake.lastWrittenLine();
  assert.equal(request.type, "abort");
  fake.pushStdout(respond(request.id as string, "abort"));
  await pending;
  await client.close();
});

test("unexpected child exit rejects pending requests and emits process_exit", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  const pending = client.send({ type: "get_state" });
  const rejection = assert.rejects(pending, /exited unexpectedly/);
  fake.exit(3, "SIGKILL");
  await rejection;
  await flush();

  const exit = events.find((event) => event.type === "process_exit");
  assert.deepEqual(exit, {
    type: "process_exit",
    sessionId: "test-session",
    code: 3,
    signal: "SIGKILL",
    expected: false,
  });
  assert.equal(client.isRunning(), false);
  await assert.rejects(client.send({ type: "get_state" }), /exited unexpectedly/);
  await client.close();
});

test("close terminates the child with SIGTERM and reports an expected exit", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  await client.close();
  await flush();

  assert.deepEqual(fake.killedWith, ["SIGTERM"]);
  assert.equal(client.isRunning(), false);
  const exit = events.find((event) => event.type === "process_exit");
  assert.equal(exit && "expected" in exit ? exit.expected : undefined, true);
});

test("extension_ui_request dialog is surfaced with expectsResponse and can be answered", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  fake.pushStdout(
    `${JSON.stringify({ type: "extension_ui_request", id: "ui_1", method: "select", title: "Pick", options: ["a", "b"] })}\n`,
  );
  await flush();

  const request = events.find((event) => event.type === "ui_request");
  assert.ok(request && request.type === "ui_request");
  assert.equal(request.requestId, "ui_1");
  assert.equal(request.method, "select");
  assert.equal(request.expectsResponse, true);
  assert.deepEqual(request.payload, { title: "Pick", options: ["a", "b"] });

  client.respondToUi("ui_1", { value: "a" });
  assert.deepEqual(fake.lastWrittenLine(), { type: "extension_ui_response", id: "ui_1", value: "a" });
  await client.close();
});

test("fire-and-forget extension UI notifications do not require a response", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  fake.pushStdout(`${JSON.stringify({ type: "extension_ui_request", id: "ui_2", method: "notify", message: "hi", notifyType: "info" })}\n`);
  await flush();

  const request = events.find((event) => event.type === "ui_request");
  assert.equal(request && "expectsResponse" in request ? request.expectsResponse : undefined, false);
  await client.close();
});

test("unknown pi event types are reported without leaking their payload", async () => {
  const fake = createFakeChild();
  const client = createClient(fake);
  const events = collectEvents(client);
  await client.start();

  fake.pushStdout(`${JSON.stringify({ type: "brand_new_event", secret: "nope" })}\n`);
  await flush();

  const unknown = events.find((event) => event.type === "unknown_event");
  assert.deepEqual(unknown, { type: "unknown_event", sessionId: "test-session", name: "brand_new_event" });
  await client.close();
});

test("live: real pi answers get_state over RPC without calling a model", { skip: process.env.PI_LIVE_RPC !== "1" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-live-"));
  const client = new RpcClient({
    sessionId: "live-session",
    piBin: process.env.PI_BIN ?? "pi",
    args: ["--no-session"],
    cwd: dir,
    startupDelayMs: 200,
    requestTimeoutMs: 60_000,
    shutdownTimeoutMs: 3_000,
  });
  const events = collectEvents(client);

  try {
    await client.start();
    const state = await client.send<{ sessionId: string; isStreaming: boolean }>({ type: "get_state" });
    assert.equal(typeof state.sessionId, "string");
    assert.ok(state.sessionId.length > 0);
    assert.equal(state.isStreaming, false);
    assert.equal(events.filter((event) => event.type === "process_exit").length, 0);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
