import assert from "node:assert/strict";
import { runSubprocess } from "../../runtime/omp/node_modules/@oh-my-pi/pi-coding-agent/src/task/executor.ts";
import { Settings } from "../../runtime/omp/node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts";
import { resolveAgentModelSelection } from "../../runtime/omp/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-resolver.ts";
import { models } from "./subagent-model-isolation.mjs";

export async function verifyRunningChildren(pi, ctx) {
  const pending = [];
  const received = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json();
    received.push(body.model);
    pending.shift()?.resolve();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "isolation-probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`));
    } }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  pi.registerProvider("verification", { baseUrl, api: "openai-completions", apiKey: "synthetic-verification-key", models: models.map(model => ({ ...model, baseUrl })) });
  const settings = await Settings.loadReadOnly({ cwd: ctx.cwd, agentDir: `${ctx.cwd}/isolated-agent`, inMemory: true,
    overrides: { modelRoles: { default: "verification/main-a" } } });
  const children = [];
  function spawnChild(parent) {
    const controller = new AbortController();
    const gate = Promise.withResolvers();
    pending.push(gate);
    const patterns = resolveAgentModelSelection({ settings, activeModelPattern: parent }).patterns;
    const promise = runSubprocess({ cwd: ctx.cwd, agent: { name: "isolated-native-verification", description: "test", systemPrompt: "Test only.", source: "bundled", tools: [], spawns: [], model: ["@default"] },
      task: "Wait for the verification response; no tools.", description: "Native model isolation probe", index: children.length, id: crypto.randomUUID(), modelOverride: patterns,
      parentActiveModelPattern: parent, settings, modelRegistry: ctx.modelRegistry, signal: controller.signal,
      enableIrc: false, enableLsp: false, enableMCP: false, skills: [], contextFiles: [], rules: [], preloadedExtensionPaths: [], preloadedPreparedExtensions: [], preloadedCustomToolPaths: [],
      restrictToolNames: true, persistArtifacts: false, sessionFile: null, keepAlive: false, maxRuntimeMs: 30_000 });
    let finished = false;
    void promise.then(result => { finished = true; if (result.error) gate.reject(new Error(result.error)); }, error => { finished = true; gate.reject(error); });
    const child = { controller, promise, finished: () => finished };
    children.push(child);
    const timer = setTimeout(() => gate.reject(new Error("native child did not reach the isolated streaming provider")), 20_000);
    return gate.promise.finally(() => clearTimeout(timer));
  }
  try {
    await spawnChild("verification/main-a");
    assert.equal(children[0].finished(), false, "first native child must still be running");
    await pi.setModel(ctx.models.resolve("verification/main-b"));
    assert.equal(ctx.models.current().id, "main-b");
    assert.equal(children[0].finished(), false, "main switch must not replace or terminate the running child");
    await spawnChild("verification/main-b");
    assert.deepEqual(received, ["child-default", "child-default"], "actual requests from native children before and after main switch must use the independent identity");
    children.forEach(child => child.controller.abort());
    const results = await Promise.all(children.map(child => child.promise));
    for (const result of results) assert.equal(result.resolvedModelIdentity, "verification/child-default");
    return received;
  } finally {
    children.forEach(child => child.controller.abort());
    await Promise.allSettled(children.map(child => child.promise));
    await server.stop(true);
  }
}
