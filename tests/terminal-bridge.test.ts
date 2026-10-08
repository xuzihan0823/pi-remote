import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalBridgeError, TerminalSessionBridge, defaultBridgeDirs } from "../src/terminal/bridge-client.ts";
import { FakeTerminalInstance } from "./helpers/fake-terminal-instance.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pbr-"));
}

function workspaceUnder(root: string): string {
  const ws = join(root, "ws");
  mkdirSync(join(ws, "proj"), { recursive: true });
  return ws;
}

test("default bridge discovery scans both runtime directories and honors an explicit override", async () => {
  const root = mkdtempSync("/tmp/pbr-");
  const ws = workspaceUnder(root);
  const originalHome = process.env.HOME;
  const originalOverride = process.env.PI_REMOTE_BRIDGE_DIR;
  process.env.HOME = root;
  delete process.env.PI_REMOTE_BRIDGE_DIR;
  try {
    const [piDefault, ompDefault] = defaultBridgeDirs();
    assert.equal(piDefault, join(root, ".pi", "agent", "pi-remote-bridge"));
    assert.equal(ompDefault, join(root, ".omp", "agent", "pi-remote-bridge"));
    const pi = await FakeTerminalInstance.start({ dir: piDefault!, sessionId: "terminal:pi", cwd: ws });
    const omp = await FakeTerminalInstance.start({ dir: ompDefault!, sessionId: "terminal:omp", cwd: ws });
    try {
      const bridge = new TerminalSessionBridge({ workspaceRoot: ws });
      assert.deepEqual((await bridge.list()).map((s) => s.sessionId).sort(), ["terminal:omp", "terminal:pi"]);
      assert.equal((await bridge.snapshot("terminal:omp")).sessionId, "terminal:omp");
      process.env.PI_REMOTE_BRIDGE_DIR = piDefault!;
      assert.deepEqual(defaultBridgeDirs(), [piDefault]);
      assert.deepEqual((await new TerminalSessionBridge({ workspaceRoot: ws }).list()).map((s) => s.sessionId), ["terminal:pi"]);
    } finally {
      await pi.stop();
      await omp.stop();
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.PI_REMOTE_BRIDGE_DIR;
    else process.env.PI_REMOTE_BRIDGE_DIR = originalOverride;
  }
});

test("list returns live sessions from all Mac directories and still ignores unsafe sockets", async () => {
  const root = tempDir();
  const bridgeDir = join(root, "bridge");
  const ws = workspaceUnder(root);
  const outside = homedir();
  symlinkSync(outside, join(ws, "escape"));

  const live = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:s1",
    cwd: join(ws, "proj"),
    title: "hello terminal",
  });
  const unrelated = await FakeTerminalInstance.start({ dir: bridgeDir, sessionId: "terminal:other", cwd: outside });
  const escaped = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:escape",
    cwd: join(ws, "escape"),
  });

  try {
    writeFileSync(join(bridgeDir, "b-notasocket.sock"), "not a socket");
    symlinkSync(live.socketPath, join(bridgeDir, "b-symlink.sock"));

    const bridge = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir, probeTimeoutMs: 300 });
    const metas = await bridge.list();

    assert.deepEqual(
      metas.map((meta) => meta.sessionId).sort(),
      ["terminal:escape", "terminal:other", "terminal:s1"],
    );
    const session = metas.find(meta => meta.sessionId === "terminal:s1");
    assert.equal(session?.title, "hello terminal");
    assert.equal(session?.activity, "idle");
    assert.equal(session?.cwd, join(ws, "proj"));
    await bridge.prompt("terminal:other", "remote prompt");
    await bridge.abort("terminal:other");
    assert.equal(unrelated.calls.filter(call => call.op === "prompt").length, 1);
    assert.equal(unrelated.calls.filter(call => call.op === "abort").length, 1);
  } finally {
    await live.stop();
    await unrelated.stop();
    await escaped.stop();
  }
});

test("a dead socket file left behind by a killed process is ignored", async () => {
  const root = tempDir();
  const bridgeDir = join(root, "bridge");
  mkdirSync(bridgeDir, { recursive: true });
  const socketPath = join(bridgeDir, "b-deadbeefdeadbeef.sock");

  const child = spawn(
    process.execPath,
    ["-e", "const net=require('node:net');net.createServer().listen(process.argv[1],()=>console.log('ready'));", socketPath],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child never bound its socket")), 5_000);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("child exited before binding"));
      });
    });

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    assert.equal(existsSync(socketPath), true, "killed process should leave its socket file behind");

    const bridge = new TerminalSessionBridge({ workspaceRoot: root, bridgeDir, probeTimeoutMs: 300 });
    assert.deepEqual(await bridge.list(), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("a missing, non-directory or unreadable bridge directory degrades to an empty list", async () => {
  const root = tempDir();
  const bridge = new TerminalSessionBridge({ workspaceRoot: root, bridgeDir: join(root, "missing") });
  assert.deepEqual(await bridge.list(), []);

  const file = join(root, "afile");
  writeFileSync(file, "x");
  const fileBridge = new TerminalSessionBridge({ workspaceRoot: root, bridgeDir: file });
  assert.deepEqual(await fileBridge.list(), []);

  if (process.getuid?.() !== 0) {
    const locked = join(root, "locked");
    mkdirSync(locked, { recursive: true, mode: 0o700 });
    const { chmodSync } = await import("node:fs");
    chmodSync(locked, 0o000);
    const lockedBridge = new TerminalSessionBridge({ workspaceRoot: root, bridgeDir: locked });
    assert.deepEqual(await lockedBridge.list(), []);
    chmodSync(locked, 0o700);
  }
});

test("snapshot, prompt and abort reach the original terminal instance", async () => {
  const root = tempDir();
  const bridgeDir = join(root, "bridge");
  const ws = workspaceUnder(root);
  const instance = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:s1",
    cwd: join(ws, "proj"),
    activity: "busy",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ],
  });

  try {
    const bridge = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir });
    const snapshot = await bridge.snapshot("terminal:s1");
    assert.deepEqual(snapshot, {
      sessionId: "terminal:s1",
      activity: "busy",
      messages: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      truncated: false,
    });

    assert.deepEqual(await bridge.get("terminal:s1"), {
      sessionId: "terminal:s1",
      title: "terminal:s1",
      cwd: join(ws, "proj"),
      activity: "busy",
    });

    await bridge.abort("terminal:s1");
    assert.ok(instance.calls.some((call) => call.op === "snapshot" && call.sessionId === "terminal:s1"));
    assert.ok(instance.calls.some((call) => call.op === "abort" && call.sessionId === "terminal:s1"));
  } finally {
    await instance.stop();
  }
});

test("prompt is forwarded with the message and busy terminals reject it", async () => {
  const root = tempDir();
  const bridgeDir = join(root, "bridge");
  const ws = workspaceUnder(root);
  const instance = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:s1",
    cwd: join(ws, "proj"),
    errorOnPrompt: "session_busy",
  });

  try {
    const bridge = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir });
    await assert.rejects(bridge.prompt("terminal:s1", "do it"), (error: unknown) => {
      assert.ok(error instanceof TerminalBridgeError);
      assert.equal(error.code, "session_busy");
      return true;
    });
    assert.deepEqual(instance.calls.find((call) => call.op === "prompt"), {
      op: "prompt",
      sessionId: "terminal:s1",
      message: "do it",
    });
  } finally {
    await instance.stop();
  }
});

test("a stale session id rejected by the bridge surfaces as unknown_session", async () => {
  const root = tempDir();
  const bridgeDir = join(root, "bridge");
  const ws = workspaceUnder(root);
  const instance = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:s1",
    cwd: join(ws, "proj"),
    errorOnPrompt: "stale_session",
  });

  try {
    const bridge = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir });
    await assert.rejects(bridge.prompt("terminal:s1", "hi"), (error: unknown) => {
      assert.ok(error instanceof TerminalBridgeError);
      assert.equal(error.code, "unknown_session");
      return true;
    });
  } finally {
    await instance.stop();
  }
});

test("an unresponsive terminal is bounded and never blocks list or prompt", async () => {
  const root = tempDir();
  const bridgeDir = join(root, "bridge");
  const ws = workspaceUnder(root);
  const hang = await FakeTerminalInstance.start({
    dir: bridgeDir,
    sessionId: "terminal:hang",
    cwd: join(ws, "proj"),
    hang: true,
  });

  try {
    const bridge = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir, probeTimeoutMs: 150, requestTimeoutMs: 150 });
    const started = Date.now();
    assert.deepEqual(await bridge.list(), []);
    assert.ok(Date.now() - started < 1_500, "list must resolve despite an unresponsive socket");

    await assert.rejects(bridge.snapshot("terminal:hang"), (error: unknown) => {
      assert.ok(error instanceof TerminalBridgeError);
      assert.equal(error.code, "unknown_session");
      return true;
    });
  } finally {
    await hang.stop();
  }
});

test("closing the bridge never stops the user's terminal", async () => {
  const root = tempDir();
  const bridgeDir = join(root, "bridge");
  const ws = workspaceUnder(root);
  const instance = await FakeTerminalInstance.start({ dir: bridgeDir, sessionId: "terminal:s1", cwd: join(ws, "proj") });

  try {
    const bridge = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir });
    await bridge.list();
    bridge.close();
    assert.equal(instance.listening, true);

    const reopened = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir });
    assert.equal((await reopened.list()).length, 1);
    await reopened.prompt("terminal:s1", "still alive");
    assert.ok(instance.calls.some((call) => call.op === "prompt" && call.message === "still alive"));
    assert.equal(instance.listening, true);
  } finally {
    await instance.stop();
  }
});

test("a multi-byte character split across two socket chunks is decoded intact", async () => {
  const root = tempDir();
  const bridgeDir = join(root, "bridge");
  const ws = workspaceUnder(root);
  const title = "你好世界";
  const sessionId = "terminal:cjk";
  mkdirSync(bridgeDir, { recursive: true });
  const socketPath = join(bridgeDir, `b-${randomBytes(8).toString("hex")}.sock`);

  let writes = 0;
  let firstFragment = Buffer.alloc(0);
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id?: string };
      const line = `${JSON.stringify({
        id: request.id ?? null,
        ok: true,
        data: { sessions: [{ sessionId, cwd: ws, title, activity: "idle" }] },
      })}\n`;
      const bytes = Buffer.from(line, "utf8");
      const start = bytes.indexOf(Buffer.from(title, "utf8"));
      assert.notEqual(start, -1, "the response must contain the multi-byte title");
      const cut = start + 2;
      firstFragment = bytes.subarray(0, cut);
      writes = 1;
      socket.write(firstFragment);
      // A real socket may deliver this in a separate `data` event; the 40ms gap makes that
      // deterministic so the partial code point is guaranteed to span two chunks.
      setTimeout(() => {
        writes = 2;
        socket.write(bytes.subarray(cut));
      }, 40);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);

  try {
    const bridge = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir, probeTimeoutMs: 1_000 });
    const metas = await bridge.list();
    assert.equal(writes, 2, "the fixture must have split the response into two writes");
    assert.equal(firstFragment.at(-1)! & 0b1100_0000, 0b1000_0000, "the first fragment must end inside a multi-byte character");
    assert.deepEqual(metas, [{ sessionId, title, cwd: ws, activity: "idle", canControl: true }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(socketPath);
    } catch {
      // already gone
    }
  }
});

test("same-ID sockets remain separate evidence and never route control to the first instance", async () => {
  const root = tempDir();
  const ws = workspaceUnder(root);
  const dir = join(root, "bridge");
  const first = await FakeTerminalInstance.start({ dir, sessionId: "terminal:duplicate", cwd: ws });
  const second = await FakeTerminalInstance.start({ dir, sessionId: "terminal:duplicate", cwd: ws });
  const bridge = new TerminalSessionBridge({ workspaceRoot: ws, bridgeDir: dir });
  try {
    assert.equal((await bridge.instances()).length, 2);
    const listed = await bridge.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.canControl, false);
    for (const operation of [() => bridge.get("terminal:duplicate"), () => bridge.snapshot("terminal:duplicate"), () => bridge.prompt("terminal:duplicate", "must-not-deliver"), () => bridge.abort("terminal:duplicate")]) {
      await assert.rejects(operation(), (error: unknown) => error instanceof TerminalBridgeError && error.code === "session_busy");
    }
    assert.ok(![...first.calls, ...second.calls].some(call => call.op === "prompt" || call.op === "abort"));
    await second.stop();
    bridge.setControlGuard(async () => false);
    assert.equal((await bridge.list())[0]!.canControl, false);
    await assert.rejects(bridge.prompt("terminal:duplicate", "still-not-deliver"));
    await assert.rejects(bridge.abort("terminal:duplicate"));
    assert.ok(!first.calls.some(call => call.op === "prompt" || call.op === "abort"));
  } finally { bridge.close(); await first.stop(); await second.stop(); }
});
