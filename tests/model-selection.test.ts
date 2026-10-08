import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PassThrough } from "node:stream";
import { createPiAgentHandler } from "../src/agent/pi-agent-handler.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import { createModelCatalog, parseModelCatalog } from "../src/pi/model-catalog.ts";
import { AgentClient } from "../src/agent/agent-client.ts";
import { createFakeChild, flush } from "./helpers/fake-child.ts";
import { FrameQueue, TEST_TOKEN, helloFrame, openSocket, requestFrame, send, startTestServer } from "./helpers/relay-harness.ts";

const first = { provider: "test", id: "first", name: "First", headers: { Authorization: "secret" }, baseUrl: "secret-url" };
const second = { provider: "test", id: "second", name: "Second", apiKey: "secret" };
const selection = { provider: "test", modelId: "second" };

function harness() {
  const fake = createFakeChild();
  const manager = new PiProcessManager({ piBin: "not-executed", spawnFn: fake.spawn, startupDelayMs: 0, shutdownTimeoutMs: 5, requestTimeoutMs: 1_000 });
  const state = { model: first as typeof first | typeof second, streaming: false, fail: false, ignore: false, beforeSet: async () => {} };
  (fake.process.stdin as unknown as PassThrough).on("data", (chunk: Buffer) => {
    const command = JSON.parse(String(chunk)) as { id: string; type: string; modelId?: string };
    void (async () => {
      let data: unknown;
      if (command.type === "get_state") data = { model: state.model, isStreaming: state.streaming };
      if (command.type === "get_available_models") data = { models: [first, second] };
      if (command.type === "set_model") {
        await state.beforeSet();
        if (!state.ignore && !state.fail) state.model = command.modelId === first.id ? first : second;
        data = state.model;
      }
      fake.pushStdout(JSON.stringify({ id: command.id, type: "response", command: command.type,
        success: !(state.fail && command.type === "set_model"), error: "provider returned secret", data }) + "\n");
    })();
  });
  const handler = createPiAgentHandler({ manager, workspaceRoot: tmpdir() });
  return { fake, manager, state, handler };
}

test("managed model queries and changes are sanitized, session-scoped, and never prompt", async () => {
  const h = harness();
  try {
    await h.handler(requestFrame("start", "session.start", { sessionId: "one" }));
    const listed = await h.handler(requestFrame("list", "model.list", { sessionId: "one" }));
    assert.deepEqual(listed, { ok: true, data: { sessionId: "one", model: { provider: "test", modelId: "first", name: "First" },
      models: [{ provider: "test", modelId: "first", name: "First" }, { ...selection, name: "Second" }] } });
    const changed = await h.handler(requestFrame("set", "session.set_model", { sessionId: "one", params: { model: selection } }));
    assert.deepEqual(changed, { ok: true, data: { sessionId: "one", model: { ...selection, name: "Second" } } });
    assert.deepEqual(await h.handler(requestFrame("get", "session.get_model", { sessionId: "one" })), changed);
    assert.equal(h.fake.spawnedArgs.length, 1);
    assert.equal(h.fake.writtenLines().some(line => line.type === "prompt"), false);
    const { id: _id, ...command } = h.fake.writtenLines().find(line => line.type === "set_model")!;
    assert.deepEqual(command, { type: "set_model", ...selection });
  } finally { await h.manager.closeAll(); }
});

test("invalid and unavailable selections, archives, and busy sessions cannot switch", async () => {
  const h = harness();
  try {
    await h.manager.start("one");
    for (const model of [null, {}, { provider: "test", modelId: " " }, { provider: "test", modelId: "a\n--config" }, { provider: "test", modelId: "missing" }]) {
      const result = await h.handler(requestFrame("bad", "session.set_model", { sessionId: "one", params: { model } }));
      assert.equal(result.error?.code, "invalid_frame");
    }
    assert.equal((await h.handler(requestFrame("archive", "session.set_model", { sessionId: "history:x", params: { model: selection } }))).error?.code, "invalid_frame");
    h.state.streaming = true;
    assert.equal((await h.handler(requestFrame("busy", "session.set_model", { sessionId: "one", params: { model: selection } }))).error?.code, "session_busy");
    assert.equal(h.fake.writtenLines().some(line => line.type === "set_model"), false);
    const before = h.fake.spawnedArgs.length;
    assert.equal((await h.handler(requestFrame("bad-start", "session.start", { params: { model: {} } }))).error?.code, "invalid_frame");
    assert.equal(h.fake.spawnedArgs.length, before);
  } finally { await h.manager.closeAll(); }
});

test("model changes exclude prompts and concurrent switches until confirmed", async () => {
  const h = harness();
  let release!: () => void;
  h.state.beforeSet = () => new Promise<void>(resolve => { release = resolve; });
  try {
    await h.manager.start("one");
    const pending = h.handler(requestFrame("set", "session.set_model", { sessionId: "one", params: { model: selection } }));
    for (let attempt = 0; attempt < 100 && !release; attempt++) await flush();
    assert.ok(release);
    assert.equal((await h.handler(requestFrame("prompt", "session.prompt", { sessionId: "one", params: { message: "must wait" } }))).error?.code, "session_busy");
    assert.equal((await h.handler(requestFrame("set2", "session.set_model", { sessionId: "one", params: { model: selection } }))).error?.code, "session_busy");
    release();
    assert.equal((await pending).ok, true);
    assert.equal((await h.handler(requestFrame("prompt2", "session.prompt", { sessionId: "one", params: { message: "now" } }))).ok, true);
    assert.equal(h.fake.writtenLines().filter(line => line.type === "prompt").length, 1);
  } finally { release?.(); await h.manager.closeAll(); }
});

test("creation confirms the selected model; failed switching preserves the created ID for retry", async () => {
  for (const fail of [false, true]) {
    const h = harness();
    h.state.fail = fail;
    try {
      const started = await h.handler(requestFrame("start", "session.start", { sessionId: "one", params: { model: selection } }));
      assert.equal(started.ok, true);
      const data = started.data as { sessionId: string; modelSelection: { applied: boolean; error?: unknown } };
      assert.equal(data.sessionId, "one");
      assert.equal(data.modelSelection.applied, !fail);
      assert.equal(JSON.stringify(started).includes("secret"), false);
      assert.equal(h.fake.writtenLines().some(line => line.type === "prompt"), false);
      assert.equal(h.manager.list().length, 1);
      if (fail) {
        h.state.fail = false;
        assert.equal((await h.handler(requestFrame("retry", "session.set_model", { sessionId: "one", params: { model: selection } }))).ok, true);
        assert.equal(h.fake.spawnedArgs.length, 1);
      }
    } finally { await h.manager.closeAll(); }
  }
});

test("a runtime that acknowledges but does not apply a model is not reported as success", async () => {
  const h = harness();
  h.state.ignore = true;
  try {
    await h.manager.start("one");
    assert.equal((await h.handler(requestFrame("set", "session.set_model", { sessionId: "one", params: { model: selection } }))).error?.code, "internal_error");
  } finally { await h.manager.closeAll(); }
});

test("pre-session catalogs honor runtime, working directory and environment without opening sessions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "model-catalog-"));
  const h = harness();
  try {
    for (const runtime of ["omp", "pi"] as const) {
      const catalog = createModelCatalog({ piBin: process.execPath, runtime, run: async (_file, args, options) => {
        assert.deepEqual(args, runtime === "omp" ? ["models", "--json"] : ["--list-models"]);
        assert.equal(options.cwd, realpathSync(cwd));
        assert.equal(options.env.PI_AGENT_TOKEN, undefined);
        assert.ok(options.timeout && options.maxBuffer);
        return { stdout: runtime === "omp" ? JSON.stringify({ models: [first, second] }) :
          "provider  model  context  max-out  thinking  images\ntest      first  200K     16K      yes       no\n" };
      } });
      const handler = createPiAgentHandler({ manager: h.manager, workspaceRoot: cwd, modelCatalog: catalog });
      const result = await handler(requestFrame("list", "model.list"));
      assert.equal(result.ok, true);
      assert.equal(JSON.stringify(result).includes("secret"), false);
      assert.equal((await handler(requestFrame("missing-directory", "model.list", { params: { cwd: join(cwd, "does-not-exist") } }))).error?.code, "invalid_frame");
    }
    assert.equal(h.fake.spawnedArgs.length, 0);
    assert.deepEqual(parseModelCatalog("No models available. Use /login\nlocal docs path", "pi"), []);
    assert.throws(() => parseModelCatalog("unexpected CLI output", "pi"));
    assert.throws(() => parseModelCatalog('{"error":"secret"}', "omp"));
  } finally { await h.manager.closeAll(); rmSync(cwd, { recursive: true, force: true }); }
});

test("model methods cross the real relay and missing session targets are rejected", async () => {
  const { server, port } = await startTestServer();
  const h = harness();
  const agent = new AgentClient({ url: `ws://127.0.0.1:${port}/ws/agent`, token: TEST_TOKEN, deviceId: "models-mac", handler: h.handler });
  const ios = await openSocket(port, "/ws/ios");
  const queue = new FrameQueue(ios);
  try {
    await agent.connect();
    send(ios, helloFrame("model-phone", "ios"));
    assert.equal((await queue.next()).type, "hello_ack");
    await h.manager.start("one");
    for (const method of ["model.list", "session.get_model", "session.set_model"] as const) {
      send(ios, requestFrame(method, method, { sessionId: "one", params: method === "session.set_model" ? { model: selection } : {} }));
      const response = await queue.next();
      assert.equal("requestId" in response && response.requestId, method);
      assert.equal(response.type === "response" && response.payload.ok, true);
    }
    send(ios, requestFrame("missing", "session.set_model", { params: { model: selection } }));
    const missing = await queue.next();
    assert.equal(missing.type === "response" && missing.payload.error?.code, "invalid_frame");
  } finally { ios.close(); agent.disconnect(); await h.manager.closeAll(); await server.stop(); }
});
