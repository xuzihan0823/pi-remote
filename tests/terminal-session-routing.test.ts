import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiAgentHandler } from "../src/agent/pi-agent-handler.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import { TerminalSessionBridge } from "../src/terminal/bridge-client.ts";
import { createFakeChild, flush, type FakeChild } from "./helpers/fake-child.ts";
import { FakeTerminalInstance } from "./helpers/fake-terminal-instance.ts";
import { requestFrame } from "./helpers/relay-harness.ts";

interface Harness {
  fake: FakeChild;
  manager: PiProcessManager;
  bridge: TerminalSessionBridge;
  handler: ReturnType<typeof createPiAgentHandler>;
}

function createHarness(bridgeDir: string, workspaceRoot: string): Harness {
  const fake = createFakeChild();
  const manager = new PiProcessManager({
    piBin: "pi",
    maxSessions: 4,
    startupDelayMs: 0,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 50,
    spawnFn: fake.spawn,
  });
  const bridge = new TerminalSessionBridge({ workspaceRoot, bridgeDir, probeTimeoutMs: 300 });
  const handler = createPiAgentHandler({ manager, workspaceRoot, terminalBridge: bridge, logger: () => {} });
  return { fake, manager, bridge, handler };
}

function tempWorkspace(): { root: string; workspace: string; bridgeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pbr-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  return { root, workspace, bridgeDir: join(root, "bridge") };
}

const respond = (id: string, command: string): string =>
  `${JSON.stringify({ id, type: "response", command, success: true })}\n`;

type SessionEntry = Record<string, unknown>;

function sessionsOf(result: Awaited<ReturnType<Harness["handler"]>>): SessionEntry[] {
  return (result.data as { sessions: SessionEntry[] }).sessions;
}

test("session.list merges managed and terminal sessions with source, title, cwd and activity", async () => {
  const { workspace, bridgeDir } = tempWorkspace();
  const instance = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:t1",
    cwd: workspace,
    title: "terminal one",
  });
  const { manager, handler, bridge } = createHarness(bridgeDir, workspace);

  try {
    await handler(requestFrame("r1", "session.start", { params: { sessionId: "managed-1", cwd: "." } }));
    const sessions = sessionsOf(await handler(requestFrame("r2", "session.list")));
    assert.equal(sessions.length, 2);

    const managed = sessions.find((entry) => entry.sessionId === "managed-1");
    assert.equal(managed?.source, "managed");
    assert.equal(managed?.state, "running");
    assert.equal(managed?.activity, "idle");
    assert.equal(managed?.cwd, realpathSync(workspace));

    const terminal = sessions.find((entry) => entry.sessionId === "terminal:t1");
    assert.equal(terminal?.source, "terminal");
    assert.equal(terminal?.state, "running");
    assert.equal(terminal?.title, "terminal one");
    assert.equal(terminal?.activity, "idle");
    assert.equal(terminal?.cwd, workspace);
  } finally {
    bridge.close();
    await manager.closeAll();
    await instance.stop();
  }
});

test("managed activity tracks the real turn while state keeps meaning the process is alive", async () => {
  const { workspace, bridgeDir } = tempWorkspace();
  const { fake, manager, handler, bridge } = createHarness(bridgeDir, workspace);

  try {
    await handler(requestFrame("r0", "session.start", { params: { sessionId: "managed-1" } }));

    const pending = handler(requestFrame("r1", "session.prompt", { sessionId: "managed-1", params: { message: "hello" } }));
    const written = fake.lastWrittenLine();
    fake.pushStdout(respond(written.id as string, "prompt"));
    await pending;

    const busy = sessionsOf(await handler(requestFrame("r2", "session.list")))[0];
    assert.equal(busy?.activity, "busy");
    assert.equal(busy?.state, "running");
    assert.equal(busy?.title, "hello");

    fake.pushStdout(`${JSON.stringify({ type: "agent_settled" })}\n`);
    await flush();

    const idle = sessionsOf(await handler(requestFrame("r3", "session.list")))[0];
    assert.equal(idle?.activity, "idle");
    assert.equal(idle?.state, "running");
  } finally {
    bridge.close();
    await manager.closeAll();
  }
});

test("session.get serves terminal snapshots and rejects managed or unknown ids", async () => {
  const { workspace, bridgeDir } = tempWorkspace();
  const instance = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:t1",
    cwd: workspace,
    activity: "busy",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ],
    truncated: true,
  });
  const { manager, handler, bridge } = createHarness(bridgeDir, workspace);

  try {
    const snapshot = await handler(requestFrame("r1", "session.get", { sessionId: "terminal:t1" }));
    assert.deepEqual(snapshot, {
      ok: true,
      data: {
        sessionId: "terminal:t1",
        activity: "busy",
        messages: [
          { role: "user", text: "hi" },
          { role: "assistant", text: "hello" },
        ],
        truncated: true,
      },
    });

    const missingId = await handler(requestFrame("r2", "session.get", {}));
    assert.equal(missingId.error?.code, "invalid_frame");

    const managed = await handler(requestFrame("r3", "session.get", { sessionId: "managed-1" }));
    assert.equal(managed.error?.code, "not_implemented");

    const unknown = await handler(requestFrame("r4", "session.get", { sessionId: "terminal:gone" }));
    assert.equal(unknown.error?.code, "unknown_session");
  } finally {
    bridge.close();
    await manager.closeAll();
    await instance.stop();
  }
});

test("session.prompt, session.abort and ui.response route terminal ids to the original process", async () => {
  const { workspace, bridgeDir } = tempWorkspace();
  const instance = await FakeTerminalInstance.start({ dir: bridgeDir, sessionId: "terminal:t1", cwd: workspace });
  const { manager, handler, bridge } = createHarness(bridgeDir, workspace);

  try {
    const prompt = await handler(
      requestFrame("r1", "session.prompt", { sessionId: "terminal:t1", params: { message: "hello terminal" } }),
    );
    assert.deepEqual(prompt, { ok: true, data: { sessionId: "terminal:t1", queued: true } });

    const abort = await handler(requestFrame("r2", "session.abort", { sessionId: "terminal:t1" }));
    assert.deepEqual(abort, { ok: true, data: { sessionId: "terminal:t1", aborted: true } });

    const ui = await handler(
      requestFrame("r3", "ui.response", { sessionId: "terminal:t1", params: { requestId: "ui-1" } }),
    );
    assert.equal(ui.ok, false);
    assert.equal(ui.error?.code, "not_implemented");

    assert.deepEqual(
      instance.calls.filter((call) => call.op !== "list"),
      [
        { op: "prompt", sessionId: "terminal:t1", message: "hello terminal" },
        { op: "abort", sessionId: "terminal:t1" },
      ],
    );
  } finally {
    bridge.close();
    await manager.closeAll();
    await instance.stop();
  }
});

test("temporary terminal sessions are visible and controllable without spawning or taking over a process", async () => {
  const { root, workspace, bridgeDir } = tempWorkspace();
  const { fake, manager, handler, bridge } = createHarness(bridgeDir, workspace);
  try {
    for (const cwd of ["/tmp", realpathSync("/tmp"), tmpdir(), root]) {
      const instance = await FakeTerminalInstance.start({
        dir: bridgeDir, sessionId: "terminal:temp", cwd,
        messages: [{ role: "assistant", text: "temporary output" }],
      });
      try {
        const listed = await handler(requestFrame("list", "session.list", { params: { viewVersion: 2, includeArchived: true } }));
        assert.equal(listed.ok, true);
        const sessions = sessionsOf(listed);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]?.sessionId, "terminal:temp");
        assert.equal(sessions[0]?.availability, "live");
        assert.equal(sessions[0]?.canControl, true);
        const snapshot = await handler(requestFrame("get", "session.get", { sessionId: "terminal:temp", params: { viewVersion: 2 } }));
        assert.equal(snapshot.ok, true);
        assert.deepEqual((snapshot.data as Record<string, unknown>).messages, [{ role: "assistant", text: "temporary output" }]);
        const prompt = await handler(requestFrame("prompt", "session.prompt", { sessionId: "terminal:temp", params: { message: "hello temp" } }));
        assert.equal(prompt.ok, true);
        const abort = await handler(requestFrame("abort", "session.abort", { sessionId: "terminal:temp" }));
        assert.equal(abort.ok, true);
        assert.deepEqual(instance.calls.filter(call => call.op !== "list"), [
          { op: "snapshot", sessionId: "terminal:temp" },
          { op: "prompt", sessionId: "terminal:temp", message: "hello temp" },
          { op: "abort", sessionId: "terminal:temp" },
        ]);
        assert.equal(fake.spawnedArgs.length, 0);
        assert.equal(fake.killedWith.length, 0);
        assert.deepEqual(manager.list(), []);
        assert.equal(instance.listening, true);
      } finally { await instance.stop(); }
    }
  } finally { bridge.close(); await manager.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("a busy terminal prompt surfaces session_busy without touching the process list", async () => {
  const { workspace, bridgeDir } = tempWorkspace();
  const instance = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:t1",
    cwd: workspace,
    errorOnPrompt: "session_busy",
  });
  const { manager, handler, bridge } = createHarness(bridgeDir, workspace);

  try {
    const result = await handler(
      requestFrame("r1", "session.prompt", { sessionId: "terminal:t1", params: { message: "again" } }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "session_busy");
  } finally {
    bridge.close();
    await manager.closeAll();
    await instance.stop();
  }
});

test("an unresponsive terminal never blocks session.list", async () => {
  const { workspace, bridgeDir } = tempWorkspace();
  const hang = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:hang",
    cwd: workspace,
    hang: true,
  });
  const { manager, handler, bridge } = createHarness(bridgeDir, workspace);

  try {
    await handler(requestFrame("r1", "session.start", { params: { sessionId: "managed-1" } }));

    const started = Date.now();
    const sessions = sessionsOf(await handler(requestFrame("r2", "session.list")));
    assert.ok(Date.now() - started < 2_000, "session.list must stay bounded");
    assert.deepEqual(
      sessions.map((entry) => entry.sessionId),
      ["managed-1"],
    );
  } finally {
    bridge.close();
    await manager.closeAll();
    await hang.stop();
  }
});
