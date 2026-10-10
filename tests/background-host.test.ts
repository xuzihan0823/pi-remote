import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BackgroundHost } from "../src/background/host.ts";
import { TerminalSessionBridge } from "../src/terminal/bridge-client.ts";
import { HistoryRecoveryCoordinator } from "../src/terminal/history-recovery.ts";
import { OmpHistoryIndex } from "../src/history/history-index.ts";
import { createPiAgentHandler } from "../src/agent/pi-agent-handler.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import { requestFrame } from "./helpers/relay-harness.ts";
import { backgroundFixture } from "./helpers/background-fixture.ts";

test("real background restore merges clients, reads original branch and tools, and survives agent/coordinator restart without reopening", { skip: process.env.PI_STRICT_RUNTIME !== "1", timeout: 120_000 }, async () => {
  const { root, cwd, sessions, id, file, original } = await backgroundFixture();
  const terminal = new TerminalSessionBridge({ workspaceRoot: cwd, bridgeDir: join(root, "terminal") });
  const hostOptions = { workspaceRoot: cwd, terminalBridge: terminal, directory: join(root, "workers"), runtimeArgs: ["--model", "@default", "--no-extensions", "--no-tools", "--no-skills"], env: { ...process.env, PI_TEST_SESSION_OWNERS_DIR: join(root, "owners") } };
  let host = new BackgroundHost(hostOptions);
  const history = new OmpHistoryIndex({ workspaceRoot: cwd, roots: [sessions] });
  const options = () => ({ history, launcher: host, bridge: {
    instances: async () => [...await terminal.instances(), ...await host.instances()],
    get: (sessionId: string) => host.get(sessionId), setModel: host.setModel.bind(host),
  }, directory: join(root, "operations"), workspaceRoot: cwd, offlineSource: "managed" as const });
  let recovery = new HistoryRecoveryCoordinator(options());
  host.setControlGuard(meta => recovery.canControl(meta));
  const manager = new PiProcessManager({ piBin: "must-not-run" });
  let workerPid: number | undefined;
  try {
    await history.ready();
    const alias = ((await history.list({})).sessions as { sessionId: string }[])[0]!.sessionId;
    const starts = await Promise.all([recovery.start(alias, randomUUID()), recovery.start(alias, randomUUID())]);
    assert.equal(starts[0]!.operationId, starts[1]!.operationId);
    const ready = await recovery.wait(starts[0]!.operationId as string);
    assert.equal(ready.recoveryState, "ready", JSON.stringify(ready));
    assert.equal(ready.source, "managed");
    assert.equal(ready.approvalLocation, "phone");
    assert.equal(await readFile(file, "utf8"), original, "restore itself sends no messages");
    const sessionId = ready.sessionId as string;
    const meta = await host.get(sessionId);
    assert.equal(meta.persistedSessionId, id);
    assert.equal(meta.persistedSessionFile, file);
    const workerConfig = JSON.parse(await readFile(join(host.directory, `w-${meta.instanceId}.json`), "utf8"));
    const status = await readFile(workerConfig.statusPath, "utf8");
    workerPid = Number(status.split(" ")[1]);
    const page = await host.view(sessionId, { viewVersion: 2, limit: 30 });
    assert.ok((page.items as { text?: string }[]).some(item => item.text === "correct last branch"));
    assert.ok(!(page.items as { text?: string }[]).some(item => item.text === "wrong branch"));
    const tool = (page.items as { kind: string; detailId?: string }[]).find(item => item.kind === "toolResult")!;
    const detail = await host.view(sessionId, { viewVersion: 2, view: "tool", revision: page.revision, detailId: tool.detailId, field: "result" });
    assert.equal(detail.recorded, true);
    assert.equal(detail.truncated, true);
    assert.ok(detail.nextCursor);
    const more = await host.view(sessionId, { viewVersion: 2, view: "timeline", before: (page.page as { before: string }).before, limit: 30 });
    assert.ok((more.items as { text?: string }[]).some(item => item.text === "synthetic 100"));
    recovery.close(); host.close();
    host = new BackgroundHost(hostOptions);
    recovery = new HistoryRecoveryCoordinator(options());
    host.setControlGuard(value => recovery.canControl(value));
    const reconnected = await recovery.query(ready.operationId as string);
    assert.equal(reconnected.recoveryState, "ready", JSON.stringify(reconnected));
    assert.equal((await host.get(sessionId)).processId, meta.processId);
    assert.equal((await host.instances()).length, 1);
    const handler = createPiAgentHandler({ manager, workspaceRoot: cwd, backgroundHost: host, terminalBridge: terminal, history, recovery, runtime: "omp" });
    const read = await handler(requestFrame("read", "session.get", { sessionId, params: { viewVersion: 2 } }));
    assert.equal(read.ok, true);
    const restored = await recovery.start(alias, randomUUID());
    assert.equal(restored.operationId, ready.operationId);
    assert.equal((await readdir(host.directory)).filter(name => name.endsWith(".json")).length, 1);
    await host.shutdownAll();
    assert.equal((await host.instances()).length, 0, "explicit service shutdown must drain the writer, unlike dropping an agent connection");
    const archived = await handler(requestFrame("after-exit", "session.get", { sessionId, params: { viewVersion: 2 } }));
    assert.equal(archived.ok, true);
    const fallback = archived.data as Record<string, unknown>;
    assert.equal(fallback.availability, "archived");
    assert.equal(fallback.canControl, false);
    assert.ok(String(fallback.historySessionId).startsWith("history:"));
    workerPid = undefined;
  } finally {
    recovery.close(); host.close(); history.close(); terminal.close(); await manager.closeAll();
    if (workerPid) process.kill(workerPid, "SIGTERM");
  }
});
