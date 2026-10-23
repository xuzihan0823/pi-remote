import assert from "node:assert/strict";
import test from "node:test";
import { adaptSdkMessage } from "../../src/agent-bridge/event-adapter.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const sdk = (value: unknown): SDKMessage => value as SDKMessage;

test("adapts streaming assistant and structured tool_use without SDK passthrough", () => {
  const delta = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, uuid: "m1", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(delta[1], { type: "assistant_delta", text: "hi", messageId: "m1" });
  const events = adaptSdkMessage(sdk({ type: "assistant", message: { content: [{ type: "text", text: "done" }, { type: "tool_use", id: "tu", name: "Read", input: { file_path: "x" } }] }, uuid: "m2", session_id: "s", parent_tool_use_id: null }));
  assert.equal(events.some((event) => event.type === "assistant"), true);
  assert.deepEqual(events.find((event) => event.type === "tool_use"), { type: "tool_use", toolUseId: "tu", toolName: "Read", input: { file_path: "x" }, messageId: "m2" });
});

test("adapts tool_result and result", () => {
  const tool = adaptSdkMessage(sdk({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu", content: "ok" }] }, uuid: "u1", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(tool[1], { type: "tool_result", toolUseId: "tu", content: "ok", isError: false, messageId: "u1" });
  const result = adaptSdkMessage(sdk({ type: "result", subtype: "success", is_error: false, result: "yes", uuid: "r1", session_id: "s" }));
  assert.deepEqual(result[1], { type: "result", subtype: "success", isError: false, result: "yes", messageId: "r1" });
});

test("stream events: message_start / block index / block_stop; subagent streams skipped", () => {
  const start = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } }, uuid: "e1", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(start[1], { type: "assistant_stream_start", apiMessageId: "msg_1" });
  const delta = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "x" } }, uuid: "e2", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(delta[1], { type: "assistant_delta", text: "x", messageId: "e2", index: 2 });
  const stop = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_stop", index: 2 }, uuid: "e3", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(stop[1], { type: "assistant_block_stop", index: 2 });
  const sub = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "y" } }, uuid: "e4", session_id: "s", parent_tool_use_id: "tu1" }));
  assert.equal(sub.length, 1);
});
