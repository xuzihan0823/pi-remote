import assert from "node:assert/strict";
import test from "node:test";
import { createPermissionAdapter } from "../../src/agent-bridge/permission-adapter.ts";

const options = (signal = new AbortController().signal) => ({ signal, requestId: "req", toolUseID: "tool" });

test("approval decisions allow and deny without persistent permission updates", async () => {
  const allow = createPermissionAdapter({ request: async () => ({ type: "allow_once" }) }, { sessionKey: "s", userId: "u" });
  assert.deepEqual(await allow("Bash", { command: "pwd" }, options()), { behavior: "allow", updatedInput: { command: "pwd" } });
  const deny = createPermissionAdapter({ request: async () => ({ type: "deny", message: "no" }) }, { sessionKey: "s", userId: "u" });
  assert.deepEqual(await deny("Bash", {}, options()), { behavior: "deny", message: "no" });
});

test("AskUserQuestion returns answers in updatedInput", async () => {
  let kind = "";
  const callback = createPermissionAdapter({ request: async (request) => { kind = request.kind; return { type: "answer", answers: { Continue: "Yes" } }; } }, { sessionKey: "s", userId: "u" });
  assert.deepEqual(await callback("AskUserQuestion", { questions: [] }, options()), { behavior: "allow", updatedInput: { questions: [], answers: { Continue: "Yes" } } });
  assert.equal(kind, "question");
});

test("timeout and abort fail closed", async () => {
  const callback = createPermissionAdapter({ request: async (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))) }, { sessionKey: "s", userId: "u" }, { timeoutMs: 5 });
  assert.equal((await callback("Bash", {}, options()))?.behavior, "deny");
  const controller = new AbortController(); controller.abort();
  assert.equal((await callback("Bash", {}, options(controller.signal)))?.behavior, "deny");
});
