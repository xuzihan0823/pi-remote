import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OmpHistoryIndex } from "../src/history/history-index.ts";
import { TerminalBridgeError, type TerminalSessionMeta } from "../src/terminal/bridge-client.ts";
import { HistoryRecoveryCoordinator } from "../src/terminal/history-recovery.ts";
import type { TerminalResumeTarget } from "../src/terminal/launcher.ts";
import { createPiAgentHandler } from "../src/agent/pi-agent-handler.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import type { TerminalSessionBridge } from "../src/terminal/bridge-client.ts";
import { requestFrame } from "./helpers/relay-harness.ts";
import { HistoryReadError } from "../src/history/omp-reader.ts";

async function fixture(runLaunch?: (target: TerminalResumeTarget) => Promise<TerminalSessionMeta>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "recovery-unit-")));
  const bucket = join(root, "sessions", "bucket");
  const cwd = join(root, "workspace");
  mkdirSync(bucket, { recursive: true, mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
  const file = join(bucket, "fixture.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "fixture", cwd, timestamp: new Date().toISOString() }) + "\n", { mode: 0o600 });
  const history = new OmpHistoryIndex({ workspaceRoot: cwd, roots: [join(root, "sessions")], scanIntervalMs: 1 });
  await history.ready();
  const alias = ((await history.list({})).sessions as { sessionId: string }[])[0]!.sessionId;
  let candidates: TerminalSessionMeta[] = [];
  let owners: number[] = [];
  let identity: string | null = "start-identity";
  let count = 0;
  const bridge = {
    instances: async () => candidates,
    get: async (id: string) => {
      const matching = candidates.filter(meta => meta.sessionId === id);
      if (matching.length !== 1) throw new TerminalBridgeError("session_busy", "conflict");
      return matching[0]!;
    },
  };
  const meta: TerminalSessionMeta = { sessionId: "terminal:fixture", title: "fixture", runtime: "omp", persistedSessionId: "fixture", persistedSessionFile: file, cwd, activity: "idle", instanceId: "1".repeat(32), processId: 12345 };
  const options = {
    history, bridge, workspaceRoot: cwd, directory: join(root, "operations"), ownerPids: async () => owners,
    processIdentity: async () => identity,
    launcher: { resume: async (target: TerminalResumeTarget) => {
      count++;
      if (runLaunch) return runLaunch(target);
      await target.launch!.phase("opening", join(root, "synthetic.command"));
      await target.launch!.phase("waiting_bridge");
      meta.launchId = target.launch!.id;
      candidates = [meta];
      return meta;
    } },
  };
  const recovery = new HistoryRecoveryCoordinator(options);
  return { root, file, cwd, history, alias, meta, recovery, options,
    get count() { return count; }, setCandidates(value: TerminalSessionMeta[]) { candidates = value; },
    setOwners(value: number[]) { owners = value; }, setIdentity(value: string | null) { identity = value; },
    cleanup() { recovery.close(); history.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("double-click and two clients merge into a single protected operation without prompts", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.file);
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    const [first, second] = await Promise.all([f.recovery.start(f.alias, firstRequestId), f.recovery.start(f.alias, secondRequestId)]);
    assert.equal(first.operationId, second.operationId);
    const result = await f.recovery.wait(first.operationId as string);
    assert.equal(result.recoveryState, "ready");
    assert.equal(result.sessionId, f.meta.sessionId);
    assert.equal(f.count, 1);
    assert.equal(await f.recovery.canControl(f.meta), true);
    assert.deepEqual(await readFileSync(f.file), before);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(f.file) && !serialized.includes("instanceId") && !serialized.includes("processId") && !serialized.includes("launchId"));
    assert.equal(statSync(join(f.root, "operations")).mode & 0o777, 0o700);
    assert.equal(statSync(join(f.root, "operations", `${first.operationId}.json`)).mode & 0o777, 0o600);
    const same = await f.recovery.start(f.alias, randomUUID());
    assert.equal(same.operationId, first.operationId);
    assert.equal(f.count, 1);
    const restarted = new HistoryRecoveryCoordinator(f.options);
    assert.equal((await restarted.query(secondRequestId)).operationId, first.operationId, "second client can recover its lost merge response across restart");
    assert.equal(f.count, 1);
    restarted.close();
  } finally { f.cleanup(); }
});

test("failed ownership verification stays noncontrollable across query, list guard and restart", async () => {
  const f = await fixture();
  try {
    f.setOwners([98765]);
    const started = await f.recovery.start(f.alias);
    const result = await f.recovery.wait(started.operationId as string);
    assert.equal(result.recoveryState, "blocked");
    assert.equal(await f.recovery.canControl(f.meta), false);
    const restarted = new HistoryRecoveryCoordinator(f.options);
    assert.equal(await restarted.canControl(f.meta), false);
    assert.equal((await restarted.query(started.operationId as string)).recoveryState, "blocked");
    f.setOwners([]);
    assert.equal(await restarted.canControl(f.meta), false, "removing an owner alone does not release the failed authorization");
    assert.equal((await restarted.query(started.operationId as string)).recoveryState, "ready");
    assert.equal(await restarted.canControl(f.meta), true);
    assert.equal(f.count, 1);
    restarted.close();
  } finally { f.cleanup(); }
});

test("unknown launch results never restart; late exact bridge can reconcile the original operation", async () => {
  const f = await fixture(async target => {
    await target.launch!.phase("opening", "/tmp/pending-synthetic.command");
    await target.launch!.phase("waiting_bridge");
    throw new TerminalBridgeError("timeout", "test deadline");
  });
  try {
    const start = await f.recovery.start(f.alias);
    const result = await f.recovery.wait(start.operationId as string);
    assert.equal(result.recoveryState, "unknown");
    assert.equal(result.canRetry, false);
    const retried = await f.recovery.start(f.alias, randomUUID(), true);
    assert.equal(retried.operationId, start.operationId);
    assert.equal(f.count, 1);
    const record = JSON.parse(readFileSync(join(f.root, "operations", `${start.operationId}.json`), "utf8"));
    f.meta.launchId = record.launchId;
    f.setCandidates([f.meta]);
    await f.recovery.reconcile();
    assert.equal(await f.recovery.canControl(f.meta), true, "late bridge can update lists after the waiting client left");
    assert.equal((await f.recovery.query(start.operationId as string)).recoveryState, "ready");
    assert.equal(f.count, 1);
  } finally { f.cleanup(); }
});

test("early OMP exit has a safe exit code, remains readable, and permits exactly one explicit retry", async () => {
  const f = await fixture(async target => {
    await target.launch!.phase("opening", "/tmp/consumed-synthetic.command");
    writeFileSync(target.launch!.statusPath, "exited 123 7\n", { mode: 0o600 });
    throw new TerminalBridgeError("internal_error", "must-not-log-raw-stderr");
  });
  try {
    const first = await f.recovery.start(f.alias);
    const result = await f.recovery.wait(first.operationId as string);
    assert.equal(result.recoveryState, "failed");
    assert.equal(result.errorCode, "omp_exited");
    assert.equal(result.canRetry, true);
    assert.equal(await f.recovery.canControl(f.meta), false);
    assert.equal((await f.history.get(f.alias, { viewVersion: 2 })).availability, "archived");
    const record = JSON.parse(readFileSync(join(f.root, "operations", `${first.operationId}.json`), "utf8"));
    assert.equal(record.exitCode, 7);
    assert.ok(!JSON.stringify(record).includes("must-not-log"));
    const [a, b] = await Promise.all([f.recovery.start(f.alias, randomUUID(), true), f.recovery.start(f.alias, randomUUID(), true)]);
    assert.equal(a.operationId, b.operationId);
    await f.recovery.wait(a.operationId as string);
    assert.equal(f.count, 2);
  } finally { f.cleanup(); }
});

test("restart reauthorizes new aliases, rejects PID reuse and replacement of the exact historical file", async () => {
  const f = await fixture();
  try {
    const start = await f.recovery.start(f.alias);
    await f.recovery.wait(start.operationId as string);
    const freshHistory = new OmpHistoryIndex({ workspaceRoot: f.cwd, roots: [join(f.root, "sessions")] });
    const restarted = new HistoryRecoveryCoordinator({ ...f.options, history: freshHistory });
    assert.equal(await restarted.canControl(f.meta), false, "persisted ready is not online until actual reconciliation");
    await restarted.reconcile();
    assert.equal(await restarted.canControl(f.meta), true);
    assert.equal((await restarted.query(start.operationId as string)).recoveryState, "ready");
    f.setIdentity("different-process-with-reused-pid");
    assert.equal(await restarted.canControl(f.meta), false);
    assert.equal((await restarted.query(start.operationId as string)).recoveryState, "blocked");
    f.setIdentity("start-identity");
    const replacement = `${f.file}.new`;
    writeFileSync(replacement, readFileSync(f.file), { mode: 0o600 });
    renameSync(replacement, f.file);
    assert.equal((await restarted.query(start.operationId as string)).recoveryState, "blocked");
    assert.equal(await restarted.canControl(f.meta), false);
    restarted.close(); freshHistory.close();
  } finally { f.cleanup(); }
});

test("same-ID evidence blocks ready control until explicit re-verification, and insecure records fail closed", async () => {
  const f = await fixture();
  try {
    const start = await f.recovery.start(f.alias);
    await f.recovery.wait(start.operationId as string);
    f.setCandidates([f.meta, { ...f.meta, processId: 999, instanceId: "2".repeat(32) }]);
    assert.equal(await f.recovery.canControl(f.meta), false);
    assert.equal((await f.recovery.query(start.operationId as string)).recoveryState, "blocked");
    f.setCandidates([f.meta]);
    assert.equal(await f.recovery.canControl(f.meta), false);
    assert.equal((await f.recovery.query(start.operationId as string)).recoveryState, "ready");
    chmodSync(join(f.root, "operations", `${start.operationId}.json`), 0o644);
    const unsafe = new HistoryRecoveryCoordinator(f.options);
    await assert.rejects(unsafe.canControl(f.meta), /Unsafe recovery record/);
    unsafe.close();
  } finally { f.cleanup(); }
});

test("failed restore permission applies to legacy/v2 list, get, prompt, abort and retry queries", async () => {
  const f = await fixture();
  const manager = new PiProcessManager({ piBin: "must-not-execute" });
  let controls = 0;
  try {
    f.setOwners([98765]);
    const started = await f.recovery.start(f.alias);
    await f.recovery.wait(started.operationId as string);
    const terminalBridge = {
      list: async () => [f.meta], get: async () => f.meta,
      view: async () => ({ sessionId: f.meta.sessionId, availability: "live", canControl: true, items: [] }),
      snapshot: async () => ({ sessionId: f.meta.sessionId, activity: "idle", messages: [], truncated: false }),
      prompt: async () => { controls++; }, abort: async () => { controls++; },
    } as unknown as TerminalSessionBridge;
    const handler = createPiAgentHandler({ manager, workspaceRoot: f.cwd, history: f.history, terminalBridge, recovery: f.recovery, runtime: "omp",
      terminalLauncher: { ...f.options.launcher, start: async () => { throw new Error("must-not-start-new-session"); } } });
    for (const params of [{}, { viewVersion: 2, includeArchived: true }]) {
      const listed = await handler(requestFrame(randomUUID(), "session.list", { params }));
      assert.equal(listed.ok, true);
      assert.ok(listed.data && typeof listed.data === "object" && "sessions" in listed.data);
      const sessions = listed.data.sessions;
      assert.ok(Array.isArray(sessions));
      assert.equal(sessions.find(session => session.sessionId === f.meta.sessionId)!.canControl, false);
      if (params.viewVersion === 2) assert.ok(sessions.some(session => session.sessionId === f.alias), "failed live instance must not hide readable archive");
    }
    for (const viewVersion of [undefined, 2]) {
      const fetched = await handler(requestFrame(randomUUID(), "session.get", { sessionId: f.meta.sessionId, params: { viewVersion } }));
      assert.equal(fetched.ok, true);
      assert.ok(fetched.data && typeof fetched.data === "object" && "canControl" in fetched.data);
      assert.equal(fetched.data.canControl, false);
    }
    for (const method of ["session.prompt", "session.abort", "ui.response", "session.set_model"] as const) {
      const result = await handler(requestFrame(randomUUID(), method, { sessionId: f.meta.sessionId, params: { message: "forbidden", requestId: "forbidden", model: { provider: "synthetic", modelId: "synthetic" } } }));
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "session_busy");
    }
    const queried = await handler(requestFrame(randomUUID(), "session.start", { params: { mode: "terminal", recoveryVersion: 1, operationId: started.operationId } }));
    assert.ok(queried.data && typeof queried.data === "object" && "recoveryState" in queried.data);
    assert.equal(queried.data.recoveryState, "blocked");
    assert.equal(f.count, 1);
    assert.equal(controls, 0);
    assert.deepEqual(manager.list(), []);
  } finally { await manager.closeAll(); f.cleanup(); }
});

test("legacy explicit continue retries a confirmed failure but never reopens an unknown launch", async () => {
  for (const unknown of [false, true]) {
    const f = await fixture(async target => {
      if (unknown) await target.launch!.phase("opening", "/tmp/unconfirmed.command");
      throw new TerminalBridgeError(unknown ? "timeout" : "internal_error", "synthetic failure");
    });
    const manager = new PiProcessManager({ piBin: "must-not-execute" });
    try {
      const handler = createPiAgentHandler({ manager, workspaceRoot: f.cwd, history: f.history, recovery: f.recovery, runtime: "omp",
        terminalLauncher: { ...f.options.launcher, start: async () => { throw new Error("must-not-start"); } } });
      const first = await handler(requestFrame(randomUUID(), "session.start", { params: { mode: "terminal", historySessionId: f.alias } }));
      assert.equal(first.ok, false);
      const retry = await handler(requestFrame(randomUUID(), "session.start", { params: { mode: "terminal", historySessionId: f.alias } }));
      assert.equal(retry.ok, false);
      assert.equal(f.count, unknown ? 1 : 2);
    } finally { await manager.closeAll(); f.cleanup(); }
  }
});

test("concurrent status/merge saves preserve all acknowledged request IDs across restart", async () => {
  const f = await fixture();
  try {
    const started = await f.recovery.start(f.alias);
    await f.recovery.wait(started.operationId as string);
    const requestIds = Array.from({ length: 24 }, () => randomUUID());
    await Promise.all(requestIds.map(async id => {
      const merged = await f.recovery.start(f.alias, id);
      assert.equal(merged.operationId, started.operationId);
      await f.recovery.query(id);
    }));
    const restarted = new HistoryRecoveryCoordinator(f.options);
    for (const id of requestIds) assert.equal((await restarted.query(id)).operationId, started.operationId);
    assert.equal(f.count, 1);
    restarted.close();
  } finally { f.cleanup(); }
});

test("a live history append racing snapshot validation reconciles without permanently revoking control", async () => {
  const f = await fixture();
  try {
    const started = await f.recovery.start(f.alias);
    await f.recovery.wait(started.operationId as string);
    const resumeStored = f.history.resumeStored.bind(f.history);
    let injectAppendRace = true;
    f.history.resumeStored = async (target, operation) => {
      if (injectAppendRace) {
        injectAppendRace = false;
        writeFileSync(f.file, readFileSync(f.file, "utf8") + JSON.stringify({ type: "custom", id: "append-race", parentId: null }) + "\n", { mode: 0o600 });
        throw new HistoryReadError("changed", "history appended during snapshot");
      }
      return resumeStored(target, operation);
    };
    assert.equal(await f.recovery.canControl(f.meta), false);
    await f.recovery.reconcile();
    assert.equal(await f.recovery.canControl(f.meta), true, "normal append must not create a persistent blocked instance");
    assert.equal(f.count, 1);
    f.setOwners([99999]);
    assert.equal(await f.recovery.canControl(f.meta), false, "real conflicting owner must remain blocked");
    f.setOwners([]);
    await f.recovery.reconcile();
    assert.equal(await f.recovery.canControl(f.meta), false, "reconciling appends must not auto-clear a confirmed ownership failure");
  } finally { f.cleanup(); }
});
