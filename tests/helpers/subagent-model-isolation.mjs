import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Settings } from "../../runtime/omp/node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts";
import { resolveAgentModelSelection, resolveModelOverride, resolveModelOverrideWithAuthFallback } from "../../runtime/omp/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-resolver.ts";
import { invalidModelSelectorReason } from "../../runtime/omp/node_modules/@oh-my-pi/pi-coding-agent/src/task/structured-subagent.ts";

export const ids = ["main-a", "main-b", "child-default", "child-backup", "role-special", "unauthenticated"];
export const models = ids.map(id => ({ id, provider: "verification", name: id, api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 4096 }));

export async function verifyIdentities(cwd, parent) {
  const settings = await Settings.loadReadOnly({ cwd, agentDir: join(cwd, "isolated-agent"), inMemory: true,
    overrides: { modelRoles: { default: parent, task: "verification/role-special", slow: "verification/missing,verification/child-backup", plan: "@slow" } } });
  const registry = { getAvailable: () => models, getApiKey: async model => model.id === "unauthenticated" ? undefined : "synthetic-verification-key" };
  const cases = [
    [{}, "child-default"],
    [{ requestModel: "@default" }, "child-default"],
    [{ requestModel: "@default:low" }, "child-default"],
    [{ requestModel: ["verification/missing", "@default"] }, "child-default"],
    [{ settingsOverride: ["@default", "verification/role-special"] }, "child-default"],
    [{ agentModel: "@default" }, "child-default"],
    [{ agentModel: ["@default", "verification/role-special"] }, "child-default"],
    [{ agentModel: "@task" }, "role-special"],
    [{ requestModel: "@task" }, "role-special"],
    [{ requestModel: "@plan" }, "child-backup"],
    [{ requestModel: "@smol" }, "child-default"],
    [{ requestModel: "verification/role-special" }, "role-special"],
  ];
  const resolved = [];
  for (const [selectors, expected] of cases) {
    const selection = resolveAgentModelSelection({ ...selectors, settings, activeModelPattern: parent, fallbackModelPattern: parent });
    const result = resolveModelOverride(selection.patterns, registry, settings);
    assert.equal(result.model?.provider, "verification");
    assert.equal(result.model?.id, expected, JSON.stringify(selectors));
    assert.equal(selection.inheritsLiveThinkingLevel, undefined);
    if (selectors.requestModel === "@default:low") assert.equal(result.thinkingLevel, "low", "requested effort replaces rather than duplicates the independent suffix");
    resolved.push(result.model.id);
  }
  const inheritedRole = await Settings.loadReadOnly({ cwd, agentDir: join(cwd, "isolated-agent"), inMemory: true, overrides: { modelRoles: { default: parent, task: "@default", slow: "@default", plan: "@slow" } } });
  for (const role of ["@task", "@slow", "@plan"]) {
    const selection = resolveAgentModelSelection({ agentModel: role, settings: inheritedRole, activeModelPattern: parent });
    assert.equal(resolveModelOverride(selection.patterns, registry, inheritedRole).model?.id, "child-default");
  }
  const fallback = await resolveModelOverrideWithAuthFallback(["verification/unauthenticated", "verification/child-backup"], parent, registry, settings);
  assert.equal(fallback.model?.id, "child-backup");
  assert.equal(fallback.authFallbackUsed, false);
  const failed = await resolveModelOverrideWithAuthFallback(["verification/unauthenticated"], parent, registry, settings);
  assert.equal(failed.model?.id, "unauthenticated", "authentication failure stays on the configured route, never the parent");
  assert.equal(failed.authFallbackUsed, false);
  const absent = await resolveModelOverrideWithAuthFallback(["verification/nonexistent"], parent, registry, settings);
  assert.equal(absent.model, undefined, "a missing independent route must not silently resolve to the main model");
  assert.ok(invalidModelSelectorReason("inherit", "verification"), "ambiguous literal inherit is rejected explicitly; @default is the supported selector");
  return resolved;
}

async function verifyRuntime(mode, root) {
  const cwd = join(root, mode);
  await mkdir(cwd, { mode: 0o700 });
  const file = join(cwd, "original.jsonl");
  const sessionId = crypto.randomUUID();
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }) + "\n", { mode: 0o600 });
  const report = join(cwd, "report.json");
  const extension = join(cwd, "probe.ts");
  const helperUrl = pathToFileURL(import.meta.filename).href;
  await writeFile(extension, `import { writeFile } from "node:fs/promises";
import { verifyIdentities, models } from ${JSON.stringify(helperUrl)};
import { verifyRunningChildren } from ${JSON.stringify(pathToFileURL(resolve("tests/helpers/running-subagent-isolation.mjs")).href)};
export default function(pi) {
  let generation = 0;
  pi.registerProvider("verification", { baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "synthetic-verification-key", models });
  const probe = async ctx => {
    const actual = ctx.models.current();
    const parent = actual.provider + "/" + actual.id;
    const identities = await verifyIdentities(ctx.cwd, parent);
    await writeFile(${JSON.stringify(report)}, JSON.stringify({ generation: ++generation, parent, identities, policy: process.env.PI_REMOTE_SUBAGENT_MODELS }));
  };
  pi.on("session_start", async (_, ctx) => { await probe(ctx); });
  pi.registerCommand("switch-main", { handler: async (_, ctx) => { await verifyRunningChildren(pi, ctx); await probe(ctx); }});
}`, { mode: 0o600 });
  const env = { ...process.env, PI_TEST_SESSION_OWNERS_DIR: join(root, "owners"),
    PI_REMOTE_SUBAGENT_MODELS: JSON.stringify(["verification/child-default:high", "verification/child-backup"]),
    PI_REMOTE_STRICT_TARGET: JSON.stringify({ file, id: sessionId, cwd, instanceId: crypto.randomUUID(), launchId: crypto.randomUUID() }),
    PI_REMOTE_SUPERVISOR_PID: undefined };
  let child;
  let terminal;
  function nextReport(generation, action) {
    const gate = Promise.withResolvers();
    const check = async () => {
      try { const value = JSON.parse(await readFile(report, "utf8")); if (value.generation >= generation) gate.resolve(value); } catch {}
    };
    const watcher = watch(cwd, () => void check());
    const timer = setTimeout(() => gate.reject(new Error(`${mode} runtime did not produce identity probe ${generation}`)), 45_000);
    action(); void check();
    return gate.promise.finally(() => { clearTimeout(timer); watcher.close(); });
  }
  const args = [process.execPath, resolve("runtime/omp/run.ts"), "--session", file, "--model", "verification/main-a", "--no-extensions", "-e", extension, "--no-tools", "--no-skills"];
  let stderr = "";
  let rpcFrames = "";
  try {
    const first = await nextReport(1, () => {
      if (mode === "terminal") {
        terminal = new Bun.Terminal({ cols: 100, rows: 32, data: () => {} });
        child = Bun.spawn(args, { cwd, env, terminal });
      } else {
        child = Bun.spawn([...args, "--mode", "rpc-ui"], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        void (async () => { for await (const chunk of child.stdout) rpcFrames += new TextDecoder().decode(chunk); })();
        void new Response(child.stderr).text().then(value => { stderr = value; });
      }
    });
    assert.equal(first.parent, "verification/main-a");
    const second = await nextReport(2, () => {
      if (terminal) terminal.write("/switch-main\r");
      else {
        child.stdin.write(JSON.stringify({ id: "switch-verification", type: "prompt", message: "/switch-main" }) + "\n");
        child.stdin.flush();
      }
    });
    assert.equal(second.parent, "verification/main-b", "actual SDK main model must switch");
    assert.deepEqual(second.identities, first.identities, "all actual resolved child identities stay independent after the actual main switch");
    assert.equal(second.policy, first.policy);
    console.log(`PASS ${mode}: actual running native child and new child stay independent across main A→B; SDK roles and auth fallback unchanged`);
  } catch (error) {
    if (stderr) console.error(stderr);
    if (rpcFrames) console.error(rpcFrames.slice(-6000));
    throw error;
  } finally {
    child?.kill("SIGTERM");
    if (child) await child.exited;
    terminal?.close();
  }
}

if (import.meta.main) {
  const root = await realpath(await mkdtemp("/tmp/pi-model-isolation-"));
  process.env.PI_REMOTE_SUBAGENT_MODELS = JSON.stringify(["verification/child-default:high", "verification/child-backup"]);
  const before = await verifyIdentities(root, "verification/main-a");
  const after = await verifyIdentities(root, "verification/main-b");
  assert.deepEqual(after, before);
  const frozen = Object.freeze(resolveModelOverride(resolveAgentModelSelection({ activeModelPattern: "verification/main-a" }).patterns, { getAvailable: () => models }).model);
  await verifyIdentities(root, "verification/main-b");
  assert.equal(frozen.id, "child-default");
  console.log("PASS native SDK resolution matrix: unspecified, mixed selectors, roles, requested effort, missing models and credential fallback");
  await verifyRuntime("rpc", root);
  await verifyRuntime("terminal", root);
}
