import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OmpHistoryIndex } from "../src/history/history-index.ts";
import { TerminalBridgeError, type TerminalSessionMeta } from "../src/terminal/bridge-client.ts";
import { HistoryRecoveryCoordinator, type RecoveryOptions } from "../src/terminal/history-recovery.ts";
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
  let modelCalls = 0;
  let modelFailure: Error | undefined;
  let beforeModel = async () => {};
  const bridge = {
    instances: async () => candidates,
    get: async (id: string) => {
      const matching = candidates.filter(meta => meta.sessionId === id);
      if (matching.length !== 1) throw new TerminalBridgeError("session_busy", "conflict");
      return matching[0]!;
    },
    setModel: async (sessionId: string, selection: { provider: string; modelId: string }) => {
      modelCalls++;
      assert.equal(await recovery.canControl(meta), true, "model changes only after identity and ownership verification");
      await beforeModel();
      if (modelFailure) throw modelFailure;
      return { sessionId, model: { ...selection, name: "Selected" } };
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
  const recovery: HistoryRecoveryCoordinator = new HistoryRecoveryCoordinator(options);
  return { root, file, cwd, history, alias, meta, recovery, options,
    get modelCalls() { return modelCalls; }, setModelFailure(value: Error) { modelFailure = value; },
    beforeModel(value: () => Promise<void>) { beforeModel = value; },
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

const recoveryModel = { provider: "test", modelId: "selected" };

function modelHandler(f: { cwd: string; history: OmpHistoryIndex; recovery: HistoryRecoveryCoordinator; options: RecoveryOptions }) {
  const manager = new PiProcessManager({ piBin: "must-not-execute" });
  const handler = createPiAgentHandler({ manager, workspaceRoot: f.cwd, history: f.history,
    terminalBridge: f.options.bridge as unknown as TerminalSessionBridge, recovery: f.recovery, runtime: "omp",
    terminalLauncher: { ...f.options.launcher, start: async () => { throw new Error("must-not-create"); } } });
  return { handler, manager };
}

test("production recovery applies a selected model once for legacy waits and operation queries", async () => {
  for (const recoveryVersion of [undefined, 1]) {
    const f = await fixture();
    const { handler, manager } = modelHandler(f);
    try {
      const started = await handler(requestFrame(randomUUID(), "session.start", { params: {
        mode: "terminal", historySessionId: f.alias, operationId: randomUUID(), recoveryVersion, model: recoveryModel,
      } }));
      assert.equal(started.ok, true);
      const operation = started.data as Record<string, unknown>;
      if (recoveryVersion === 1) assert.deepEqual((operation.modelSelection as Record<string, unknown>).requested, recoveryModel);
      const ready = recoveryVersion === 1 ? await f.recovery.wait(operation.operationId as string) : operation;
      assert.equal(ready.recoveryState, "ready");
      assert.equal(ready.sessionId, f.meta.sessionId);
      assert.deepEqual(ready.modelSelection, { requested: recoveryModel, state: "applied", applied: true, model: { ...recoveryModel, name: "Selected" } });
      for (const model of [undefined, recoveryModel]) {
        const queried = await handler(requestFrame(randomUUID(), "session.start", { params: {
          mode: "terminal", recoveryVersion: 1, operationId: ready.operationId, model,
        } }));
        assert.equal(queried.ok, true);
        assert.deepEqual((queried.data as Record<string, unknown>).modelSelection, ready.modelSelection);
      }
      const restarted = new HistoryRecoveryCoordinator(f.options);
      assert.deepEqual((await restarted.query(ready.operationId as string)).modelSelection, ready.modelSelection);
      restarted.close();
      assert.equal(f.count, 1);
      assert.equal(f.modelCalls, 1, "queries and restarts must not repeat set_model");
      assert.deepEqual(manager.list(), []);
    } finally { await manager.closeAll(); f.cleanup(); }
  }
});

test("unavailable, busy and unknown model outcomes retain the verified session and never retry", async () => {
  for (const failure of [new TerminalBridgeError("invalid_frame", "模型不可用"), new TerminalBridgeError("session_busy", "正在执行任务"), new Error("raw secret stderr")]) {
    const f = await fixture();
    const { handler, manager } = modelHandler(f);
    try {
      f.setModelFailure(failure);
      const result = await handler(requestFrame(randomUUID(), "session.start", { params: { mode: "terminal", historySessionId: f.alias, model: recoveryModel } }));
      assert.equal(result.ok, true);
      const data = result.data as Record<string, unknown>;
      assert.equal(data.recoveryState, "ready");
      assert.equal(data.sessionId, f.meta.sessionId);
      const model = data.modelSelection as Record<string, unknown>;
      assert.equal(model.applied, false);
      assert.equal(model.model, null);
      assert.equal(model.state, failure instanceof TerminalBridgeError ? "failed" : "unknown");
      assert.ok(!JSON.stringify(data).includes("raw secret stderr"));
      assert.deepEqual((await f.recovery.query(data.operationId as string)).modelSelection, model);
      const again = await handler(requestFrame(randomUUID(), "session.start", { params: { mode: "terminal", historySessionId: f.alias, model: recoveryModel } }));
      assert.equal(again.ok, true);
      assert.equal((again.data as Record<string, unknown>).sessionId, data.sessionId);
      assert.equal(f.count, 1);
      assert.equal(f.modelCalls, 1);
    } finally { await manager.closeAll(); f.cleanup(); }
  }
});

test("two clients requesting different models conflict without mutating the original selection", async () => {
  const f = await fixture();
  const { handler, manager } = modelHandler(f);
  try {
    const operationId = randomUUID();
    const params = { mode: "terminal", historySessionId: f.alias, recoveryVersion: 1, operationId, model: recoveryModel };
    const [first, conflict] = await Promise.all([
      handler(requestFrame(randomUUID(), "session.start", { params })),
      handler(requestFrame(randomUUID(), "session.start", { params: { ...params, model: { ...recoveryModel, modelId: "different" } } })),
    ]);
    assert.equal(first.ok, true);
    assert.equal(conflict.error?.code, "session_busy");
    const ready = await f.recovery.wait(operationId);
    for (const model of [{ ...recoveryModel, modelId: "different" }, undefined]) {
      const other = await handler(requestFrame(randomUUID(), "session.start", { params: { ...params, operationId: randomUUID(), model } }));
      assert.equal(other.error?.code, "session_busy");
    }
    const queryConflict = await handler(requestFrame(randomUUID(), "session.start", { params: { mode: "terminal", recoveryVersion: 1, operationId, model: { ...recoveryModel, modelId: "different" } } }));
    assert.equal(queryConflict.error?.code, "session_busy");
    const merged = await handler(requestFrame(randomUUID(), "session.start", { params: { ...params, operationId: randomUUID() } }));
    assert.equal((merged.data as Record<string, unknown>).operationId, operationId);
    assert.deepEqual((await f.recovery.query(operationId)).modelSelection, ready.modelSelection);
    assert.equal(f.count, 1);
    assert.equal(f.modelCalls, 1);
  } finally { await manager.closeAll(); f.cleanup(); }
});

test("ownership verification failure never attempts model changes", async () => {
  const f = await fixture();
  try {
    f.setOwners([98765]);
    const first = await f.recovery.start(f.alias, randomUUID(), false, recoveryModel);
    const blocked = await f.recovery.wait(first.operationId as string);
    assert.equal(blocked.recoveryState, "blocked");
    assert.equal(f.modelCalls, 0);
    f.setOwners([f.meta.processId!]);
    const reconciled = await f.recovery.query(first.operationId as string);
    assert.equal(reconciled.recoveryState, "ready");
    assert.equal((reconciled.modelSelection as Record<string, unknown>).applied, true);
    await f.recovery.query(first.operationId as string);
    assert.equal(f.modelCalls, 1);
    assert.equal(f.count, 1);
  } finally { f.cleanup(); }
});

test("a restart during model application records an unknown outcome and never replays set_model", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const applying = new Promise<void>(resolve => { entered = resolve; });
  f.beforeModel(async () => { entered(); await gate; });
  let waiting: Promise<Record<string, unknown>> | undefined;
  try {
    const operation = await f.recovery.start(f.alias, randomUUID(), false, recoveryModel);
    waiting = f.recovery.wait(operation.operationId as string);
    await applying;
    const disk = JSON.parse(readFileSync(join(f.root, "operations", `${operation.operationId}.json`), "utf8"));
    assert.equal(disk.modelSelection.state, "applying", "intent is persisted before runtime mutation");
    const restarted = new HistoryRecoveryCoordinator(f.options);
    const result = await restarted.query(operation.operationId as string);
    assert.equal(result.recoveryState, "ready");
    assert.equal(result.sessionId, f.meta.sessionId);
    assert.equal((result.modelSelection as Record<string, unknown>).state, "unknown");
    assert.equal((result.modelSelection as Record<string, unknown>).applied, false);
    await restarted.query(operation.operationId as string);
    assert.equal(f.modelCalls, 1);
    restarted.close();
  } finally { release(); await waiting; f.cleanup(); }
});

test("a recovery without a selected model preserves the old response and never sets a model", async () => {
  const f = await fixture();
  try {
    const operation = await f.recovery.start(f.alias);
    const ready = await f.recovery.wait(operation.operationId as string);
    assert.equal(ready.recoveryState, "ready");
    assert.equal(ready.modelSelection, undefined);
    assert.equal(f.modelCalls, 0);
  } finally { f.cleanup(); }
});
