import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { TEST_TOKEN } from "./relay-harness.ts";
// Node 24 implements this API; the project's ES2023 declaration library predates it.
const RuntimePromise = Promise as PromiseConstructor & { withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } };

const host = process.argv[2] ?? "127.0.0.1";
const socket = new WebSocket(`ws://${host}:18849/ws/ios`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
const replies = new Map<string, { resolve: (data: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
socket.on("message", data => {
  const frame = JSON.parse(data.toString());
  if (!frame.requestId) return;
  const pending = replies.get(frame.requestId);
  if (!pending) return;
  replies.delete(frame.requestId); clearTimeout(pending.timer);
  if (frame.payload?.ok === true) pending.resolve(frame.payload.data ?? {});
  else pending.reject(new Error(`${frame.payload?.error?.code ?? "unknown"}: ${frame.payload?.error?.message ?? "request failed"}`));
});
const opened = RuntimePromise.withResolvers<void>();
socket.once("open", () => opened.resolve()); socket.once("error", opened.reject);
await opened.promise;
socket.send(JSON.stringify({ version: 1, type: "hello", deviceId: "real-offline-control-verifier", payload: { role: "ios" } }));
async function request(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, any>> {
  const requestId = randomUUID();
  const { promise, resolve, reject } = RuntimePromise.withResolvers<Record<string, any>>();
  const timer = setTimeout(() => { replies.delete(requestId); reject(new Error(`${method} delivery/response unknown; do not replay`)); }, 30_000);
  replies.set(requestId, { resolve, reject, timer });
  socket.send(JSON.stringify({ version: 1, type: "request", requestId, ...(sessionId ? { sessionId } : {}), payload: { method, params } }));
  return promise;
}
try {
  const before = await fetch(`http://${host}:18850/state`).then(response => response.json()) as Record<string, any>;
  assert.equal(before.instanceCount, 0); assert.equal(before.launchCount, 0);
  const list = await request("session.list", { viewVersion: 2, includeArchived: true });
  const archived = list.sessions.find((session: Record<string, any>) => session.availability === "archived");
  assert.ok(archived?.sessionId.startsWith("history:"));
  const requestedId = randomUUID();
  let operation = await request("session.start", { mode: "terminal", recoveryVersion: 1, historySessionId: archived.sessionId, operationId: requestedId });
  for (let i = 0; i < 80 && operation.recoveryState === "pending"; i++) {
    await delay(250);
    operation = await request("session.start", { mode: "terminal", recoveryVersion: 1, operationId: operation.operationId });
  }
  assert.equal(operation.recoveryState, "ready", JSON.stringify(operation));
  const id = operation.sessionId as string;
  let page = await request("session.get", { viewVersion: 2, limit: 30 }, id);
  assert.equal(page.canControl, true);
  const allItems: Record<string, any>[] = [...page.items];
  const tool = page.items.find((item: Record<string, any>) => item.kind === "toolCall");
  assert.ok(tool?.detailId);
  const detail = await request("session.get", { viewVersion: 2, view: "tool", detailId: tool.detailId, revision: page.revision, field: "arguments" }, id);
  assert.ok(JSON.stringify(detail).includes("fixture.txt"));
  for (let i = 0; page.page?.before && i < 8; i++) {
    page = await request("session.get", { viewVersion: 2, limit: 30, before: page.page.before }, id);
    allItems.push(...page.items);
  }
  assert.ok(allItems.some(item => item.text === "离线验收合成记录 0"));
  assert.ok(!allItems.some(item => item.text === "非恢复目标分支"));
  const restored = await fetch(`http://${host}:18850/state`).then(response => response.json()) as Record<string, any>;
  assert.equal(restored.uniqueExactInstance, true); assert.equal(restored.originalEntriesPreserved, true);
  assert.equal(restored.noNewUserMessages, true); assert.equal(restored.promptCount, 0); assert.equal(restored.abortCount, 0);
  console.log("PASS real offline open + exact identity + branch + early pagination + tool detail + no control on resume");
  if (process.env.PI_VERIFY_MODEL_PROVIDER && process.env.PI_VERIFY_MODEL_ID) {
    await request("session.set_model", { model: { provider: process.env.PI_VERIFY_MODEL_PROVIDER, modelId: process.env.PI_VERIFY_MODEL_ID } }, id);
  }
  await request("session.prompt", { message: "这是 Pi Remote 专用续接验收。不要调用工具，只回复 OFFLINE_RESUME_OK。" }, id);
  let answered = false;
  for (let i = 0; i < 120; i++) {
    await delay(500);
    page = await request("session.get", { viewVersion: 2 }, id);
    if (page.items.some((item: Record<string, any>) => item.role === "assistant" && item.text?.includes("OFFLINE_RESUME_OK"))) { answered = true; break; }
  }
  assert.ok(answered, "real OMP must produce a model answer; no fake or replay is accepted");
  console.log("PASS real original OMP model output after continued prompt");
  await request("session.prompt", { message: "OFFLINE_ABORT_CHECK：请详细输出一千条递增数字，每条一行，不要调用工具。" }, id);
  for (let i = 0; i < 40; i++) {
    page = await request("session.get", { viewVersion: 2 }, id);
    if (page.activity === "busy") break;
    await delay(100);
  }
  assert.equal(page.activity, "busy");
  await request("session.abort", {}, id);
  for (let i = 0; i < 40; i++) {
    await delay(250);
    page = await request("session.get", { viewVersion: 2 }, id);
    if (page.activity === "idle") break;
  }
  assert.equal(page.activity, "idle");
  const after = await fetch(`http://${host}:18850/state`).then(response => response.json()) as Record<string, any>;
  assert.equal(after.launchCount, 1); assert.equal(after.promptCount, 2); assert.equal(after.abortCount, 1); assert.equal(after.approvalCount, 0);
  assert.equal(after.samePersistedId, true); assert.equal(after.uniqueExactInstance, true); assert.equal(after.noHistoryCopies, true);
  assert.equal(after.promptPersisted, true); assert.equal(after.abortPromptPersisted, true);
  console.log("PASS real abort + same original history file/id + single runtime, no fork/replay/auto-approval");
} finally {
  for (const pending of replies.values()) { clearTimeout(pending.timer); pending.reject(new Error("verification closed")); }
  replies.clear(); socket.close();
}
