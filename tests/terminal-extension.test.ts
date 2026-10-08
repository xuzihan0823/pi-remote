import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { TerminalBridgeError, TerminalSessionBridge } from "../src/terminal/bridge-client.ts";
import { createPiAgentHandler } from "../src/agent/pi-agent-handler.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import { OmpHistoryIndex } from "../src/history/history-index.ts";
import { HistoryRecoveryCoordinator } from "../src/terminal/history-recovery.ts";
import { requestFrame } from "./helpers/relay-harness.ts";

type FakeEvent = { type: string; message?: { role?: string; content?: unknown; timestamp?: number }; toolCallId?: string; toolName?: string; result?: unknown; partialResult?: unknown; isError?: boolean };
type FakeHandler = (event: FakeEvent, ctx: FakeContext) => void | Promise<void>;

class FakePi {
  readonly handlers = new Map<string, FakeHandler[]>();
  readonly sent: string[] = [];

  on(event: string, handler: FakeHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  sendUserMessage(content: unknown): void {
    this.sent.push(typeof content === "string" ? content : JSON.stringify(content));
  }

  async fire(event: FakeEvent, ctx: FakeContext): Promise<void> {
    for (const handler of this.handlers.get(event.type) ?? []) await handler(event, ctx);
  }
}

interface FakeContextOptions {
  sessionId: string;
  cwd: string;
  sessionName?: string;
  branch?: unknown[];
  hasUI?: boolean;
  mode?: string;
  idle?: boolean;
  agent?: { kind: "main" | "sub" };
}

class FakeContext {
  hasUI: boolean;
  mode: string;
  agent: { kind: "main" | "sub" } | undefined;
  cwd: string;
  sessionId: string;
  sessionName: string | undefined;
  branch: unknown[];
  idle: boolean;
  aborted = false;
  readonly notifications: string[] = [];
  readonly ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
  readonly sessionManager: {
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
    getSessionName: () => string | undefined;
    getBranch: () => unknown[];
  };

  constructor(options: FakeContextOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.sessionName = options.sessionName;
    this.branch = options.branch ?? [];
    this.hasUI = options.hasUI ?? true;
    this.mode = options.mode ?? "tui";
    this.agent = options.agent;
    this.idle = options.idle ?? true;
    this.ui = { notify: (message) => this.notifications.push(message) };
    this.sessionManager = {
      getSessionId: () => this.sessionId,
      getSessionFile: () => undefined,
      getSessionName: () => this.sessionName,
      getBranch: () => this.branch,
    };
  }

  isIdle(): boolean {
    return this.idle;
  }

  abort(): void {
    this.aborted = true;
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pbr-"));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function loadFactory(): Promise<(pi: unknown) => void> {
  const mod = (await import("../src/terminal/extension.ts")) as { default: unknown };
  return mod.default as (pi: unknown) => void;
}

interface BridgeHarness {
  pi: FakePi;
  ctx: FakeContext;
  dir: string;
  workspace: string;
  stop: () => Promise<void>;
}

async function startHarness(
  options: Omit<FakeContextOptions, "cwd"> & { cwd?: string; dir?: string; workspace?: string },
): Promise<BridgeHarness> {
  const dir = options.dir ?? join(tempDir(), "bridge");
  const workspace = options.workspace ?? join(tempDir(), "ws");
  mkdirSync(workspace, { recursive: true });
  process.env.PI_REMOTE_BRIDGE_DIR = dir;

  const factory = await loadFactory();
  const pi = new FakePi();
  factory(pi);
  const ctx = new FakeContext({ ...options, cwd: options.cwd ?? workspace });
  await pi.fire({ type: "session_start" }, ctx);
  return {
    pi,
    ctx,
    dir,
    workspace,
    stop: async () => {
      await pi.fire({ type: "session_shutdown" }, ctx);
    },
  };
}

async function waitForSocket(dir: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const match = readdirSync(dir).find((name) => name.startsWith("b-") && name.endsWith(".sock"));
      if (match) return join(dir, match);
    } catch {
      // directory not created yet
    }
    await delay(10);
  }
  throw new Error(`bridge socket never appeared in ${dir}`);
}

function socketNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.startsWith("b-") && name.endsWith(".sock"));
  } catch {
    return [];
  }
}

function rawCall(socketPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    socket.setTimeout(1_500, () => {
      socket.destroy();
      reject(new Error("raw bridge call timed out"));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "raw-1", ...payload })}\n`));
  });
}

function message(role: string, content: unknown): unknown {
  return { type: "message", message: { role, content } };
}

function textBlock(text: string): unknown {
  return { type: "text", text };
}

test("list and snapshot expose the live terminal session with user/assistant text only", async () => {
  const workspace = join(tempDir(), "ws");
  mkdirSync(join(workspace, "proj"), { recursive: true });
  const harness = await startHarness({
    sessionId: "abc-123",
    cwd: join(workspace, "proj"),
    sessionName: "My terminal session",
    branch: [
      message("user", "hello there"),
      message("assistant", [
        { type: "thinking", thinking: "hidden" },
        textBlock("hi"),
        { type: "toolCall", name: "bash" },
      ]),
      message("toolResult", [textBlock("tool output")]),
    ],
  });
  const socket = await waitForSocket(harness.dir);

  try {
    const bridge = new TerminalSessionBridge({ workspaceRoot: workspace, bridgeDir: harness.dir });
    const metas = await bridge.list();
    assert.match(metas[0]!.instanceId!, /^[0-9a-f]{32}$/);
    assert.deepEqual(metas, [
      {
        sessionId: "terminal:abc-123",
        title: "My terminal session",
        cwd: join(workspace, "proj"),
        activity: "idle",
        runtime: "pi", persistedSessionId: "abc-123", capabilities: { timelineV2: true, toolDetails: true },
        processId: process.pid,
        instanceId: metas[0]!.instanceId, canControl: true,
      },
    ]);

    const snapshot = await bridge.snapshot("terminal:abc-123");
    assert.deepEqual(snapshot.messages, [
      { role: "user", text: "hello there" },
      { role: "assistant", text: "hi" },
    ]);
    assert.equal(snapshot.truncated, false);

    const raw = await rawCall(socket, { op: "get", sessionId: "terminal:abc-123" });
    assert.equal(raw.ok, true);
    assert.deepEqual(raw.data, {
      sessionId: "terminal:abc-123",
      cwd: join(workspace, "proj"),
      title: "My terminal session",
      activity: "idle",
      runtime: "pi", persistedSessionId: "abc-123", capabilities: { timelineV2: true, toolDetails: true },
      processId: process.pid,
      instanceId: metas[0]!.instanceId,
    });
  } finally {
    await harness.stop();
  }
});

test("the title prefers the session name and otherwise truncates the last user text", async () => {
  const named = await startHarness({ sessionId: "s1", sessionName: "  Hello   World  ", branch: [message("user", "ignored")] });
  const unnamed = await startHarness({ sessionId: "s2", branch: [message("user", "x".repeat(200))] });
  const empty = await startHarness({ sessionId: "s3", branch: [] });

  try {
    await waitForSocket(named.dir);
    const bridge = new TerminalSessionBridge({ workspaceRoot: named.workspace, bridgeDir: named.dir });
    assert.equal((await bridge.list())[0]?.title, "Hello World");

    await waitForSocket(unnamed.dir);
    const bridge2 = new TerminalSessionBridge({ workspaceRoot: unnamed.workspace, bridgeDir: unnamed.dir });
    assert.equal((await bridge2.list())[0]?.title, "x".repeat(80));

    await waitForSocket(empty.dir);
    const bridge3 = new TerminalSessionBridge({ workspaceRoot: empty.workspace, bridgeDir: empty.dir });
    assert.equal((await bridge3.list())[0]?.title, "terminal:s3");
  } finally {
    await named.stop();
    await unnamed.stop();
    await empty.stop();
  }
});

test("activity follows the real turn state and busy prompts are rejected", async () => {
  const harness = await startHarness({ sessionId: "s1" });
  await waitForSocket(harness.dir);
  const bridge = new TerminalSessionBridge({ workspaceRoot: harness.workspace, bridgeDir: harness.dir });

  try {
    harness.ctx.idle = false;
    await harness.pi.fire({ type: "agent_start" }, harness.ctx);
    assert.equal((await bridge.list())[0]?.activity, "busy");

    await assert.rejects(bridge.prompt("terminal:s1", "do it"), (error: unknown) => {
      assert.ok(error instanceof TerminalBridgeError);
      assert.equal(error.code, "session_busy");
      return true;
    });
    assert.deepEqual(harness.pi.sent, []);

    harness.ctx.idle = true;
    await harness.pi.fire({ type: "agent_settled" }, harness.ctx);
    await bridge.prompt("terminal:s1", "do it");
    assert.deepEqual(harness.pi.sent, ["do it"]);
    assert.equal((await bridge.list())[0]?.activity, "idle");

    await bridge.abort("terminal:s1");
    assert.equal(harness.ctx.aborted, true);
  } finally {
    await harness.stop();
  }
});

test("requests for a replaced session id are rejected while the new id keeps working", async () => {
  const harness = await startHarness({ sessionId: "old-id" });
  const socket = await waitForSocket(harness.dir);
  const bridge = new TerminalSessionBridge({ workspaceRoot: harness.workspace, bridgeDir: harness.dir });

  try {
    const stale = await rawCall(socket, { op: "snapshot", sessionId: "terminal:other" });
    assert.equal(stale.ok, false);
    assert.deepEqual(stale.error, {
      code: "stale_session",
      message: "request targets \"terminal:other\" but the current session is \"terminal:old-id\"",
    });

    const unboundPrompt = await rawCall(socket, { op: "prompt", message: "no session id" });
    assert.equal(unboundPrompt.ok, false);
    assert.equal((unboundPrompt.error as Record<string, unknown>).code, "invalid_request");
    assert.deepEqual(harness.pi.sent, []);

    harness.ctx.sessionId = "new-id";
    await harness.pi.fire({ type: "session_start" }, harness.ctx);

    const oldId = await rawCall(socket, { op: "get", sessionId: "terminal:old-id" });
    assert.equal(oldId.ok, false);
    assert.equal((oldId.error as Record<string, unknown>).code, "stale_session");

    const newId = await rawCall(socket, { op: "get", sessionId: "terminal:new-id" });
    assert.equal(newId.ok, true);
    assert.equal((newId.data as Record<string, unknown>).sessionId, "terminal:new-id");
    assert.equal((await bridge.list())[0]?.sessionId, "terminal:new-id");
  } finally {
    await harness.stop();
  }
});

test("a streaming assistant partial appears at the end exactly once", async () => {
  const harness = await startHarness({ sessionId: "s1", branch: [message("user", "go")] });
  await waitForSocket(harness.dir);
  const bridge = new TerminalSessionBridge({ workspaceRoot: harness.workspace, bridgeDir: harness.dir });

  try {
    harness.ctx.idle = false;
    await harness.pi.fire({ type: "message_update", message: { role: "assistant", content: [textBlock("partial out")] } }, harness.ctx);
    const streaming = await bridge.snapshot("terminal:s1");
    assert.deepEqual(streaming.messages, [
      { role: "user", text: "go" },
      { role: "assistant", text: "partial out" },
    ]);
    assert.equal(streaming.activity, "busy");

    harness.ctx.branch = [message("user", "go"), message("assistant", [textBlock("partial out")])];
    await harness.pi.fire({ type: "message_end", message: { role: "assistant", content: [textBlock("partial out")] } }, harness.ctx);
    harness.ctx.idle = true;
    await harness.pi.fire({ type: "agent_settled" }, harness.ctx);

    const settled = await bridge.snapshot("terminal:s1");
    assert.deepEqual(settled.messages, [
      { role: "user", text: "go" },
      { role: "assistant", text: "partial out" },
    ]);
  } finally {
    await harness.stop();
  }
});

test("snapshot keeps at most 100 messages and 256 KiB of text", async () => {
  const many = await startHarness({
    sessionId: "count",
    branch: Array.from({ length: 150 }, (_value, index) => message("user", `m${index}`)),
  });
  const big = await startHarness({
    sessionId: "bytes",
    branch: [message("user", "a".repeat(200 * 1024)), message("assistant", [textBlock("b".repeat(100 * 1024))])],
  });

  try {
    await waitForSocket(many.dir);
    const bridge = new TerminalSessionBridge({ workspaceRoot: many.workspace, bridgeDir: many.dir });
    const capped = await bridge.snapshot("terminal:count");
    assert.equal(capped.messages.length, 100);
    assert.equal(capped.messages[0]?.text, "m50");
    assert.equal(capped.messages[99]?.text, "m149");
    assert.equal(capped.truncated, true);

    await waitForSocket(big.dir);
    const bridge2 = new TerminalSessionBridge({ workspaceRoot: big.workspace, bridgeDir: big.dir });
    const trimmed = await bridge2.snapshot("terminal:bytes");
    assert.equal(trimmed.messages.length, 1);
    assert.equal(trimmed.messages[0]?.role, "assistant");
    assert.ok(Buffer.byteLength(trimmed.messages[0]?.text ?? "", "utf8") <= 256 * 1024);
    assert.equal(trimmed.truncated, true);
  } finally {
    await many.stop();
    await big.stop();
  }
});

test("only interactive TUI contexts start a bridge", async () => {
  const hidden = join(tempDir(), "bridge");
  const hiddenHarness = await startHarness({ sessionId: "s1", hasUI: false, dir: hidden });
  const rpc = join(tempDir(), "bridge");
  const rpcHarness = await startHarness({ sessionId: "s2", mode: "rpc", dir: rpc });

  try {
    await delay(150);
    assert.deepEqual(socketNames(hidden), []);
    assert.deepEqual(socketNames(rpc), []);
  } finally {
    await hiddenHarness.stop();
    await rpcHarness.stop();
  }
});

test("shutdown removes the socket and a later session_start restarts the bridge", async () => {
  const harness = await startHarness({ sessionId: "s1" });
  const socket = await waitForSocket(harness.dir);
  const bridge = new TerminalSessionBridge({ workspaceRoot: harness.workspace, bridgeDir: harness.dir, probeTimeoutMs: 200 });

  try {
    await harness.pi.fire({ type: "session_shutdown" }, harness.ctx);
    await delay(50);
    assert.equal(existsSync(socket), false, "shutdown must remove the socket file");
    assert.deepEqual(await bridge.list(), []);

    await harness.pi.fire({ type: "session_start" }, harness.ctx);
    await waitForSocket(harness.dir);
    assert.equal((await bridge.list()).length, 1);
  } finally {
    await harness.stop();
  }
});

test("two terminal instances publish distinct sockets and both show up", async () => {
  const dir = join(tempDir(), "bridge");
  const workspace = join(tempDir(), "ws");
  const first = await startHarness({ sessionId: "one", dir, workspace });
  const second = await startHarness({ sessionId: "two", dir, workspace });

  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && socketNames(dir).length < 2) await delay(10);
    assert.equal(socketNames(dir).length, 2, "each instance must publish its own socket name");

    const bridge = new TerminalSessionBridge({ workspaceRoot: workspace, bridgeDir: dir });
    assert.deepEqual(
      (await bridge.list()).map((meta) => meta.sessionId).sort(),
      ["terminal:one", "terminal:two"],
    );
  } finally {
    await first.stop();
    await second.stop();
  }
});

test("launch metadata is PID-bound, optional for old sockets, and never follows a replacement session", async () => {
  const originalId = process.env.PI_REMOTE_LAUNCH_ID;
  const originalPid = process.env.PI_REMOTE_LAUNCH_PID;
  process.env.PI_REMOTE_LAUNCH_ID = "01234567-89ab-4cde-8fab-0123456789ab";
  process.env.PI_REMOTE_LAUNCH_PID = String(process.pid);
  const harness = await startHarness({ sessionId: "created" });
  try {
    await waitForSocket(harness.dir);
    const bridge = new TerminalSessionBridge({ workspaceRoot: harness.workspace, bridgeDir: harness.dir });
    assert.equal((await bridge.list())[0]?.launchId, process.env.PI_REMOTE_LAUNCH_ID);
    harness.ctx.sessionId = "replacement";
    await harness.pi.fire({ type: "session_start" }, harness.ctx);
    const replacement = (await bridge.list())[0];
    assert.equal(replacement?.sessionId, "terminal:replacement");
    assert.equal(replacement?.launchId, undefined);
    await assert.rejects(bridge.prompt("terminal:created", "must not target replacement"), (error: unknown) => error instanceof TerminalBridgeError && error.code === "unknown_session");
    harness.ctx.sessionId = "created";
    await harness.pi.fire({ type: "session_start" }, harness.ctx);
    assert.equal((await bridge.list())[0]?.launchId, undefined, "returning to the original id must not revive the one-time launchId");
    await harness.stop();
    process.env.PI_REMOTE_LAUNCH_PID = String(process.pid + 1);
    const child = await startHarness({ sessionId: "child" });
    try {
      await delay(30);
      assert.deepEqual(socketNames(child.dir), [], "inherited launch metadata cannot expose child agents");
    } finally { await child.stop(); }
  } finally {
    await harness.stop();
    if (originalId === undefined) delete process.env.PI_REMOTE_LAUNCH_ID;
    else process.env.PI_REMOTE_LAUNCH_ID = originalId;
    if (originalPid === undefined) delete process.env.PI_REMOTE_LAUNCH_PID;
    else process.env.PI_REMOTE_LAUNCH_PID = originalPid;
  }
});

test("local Mac prompts are visible in phone snapshots and noninteractive child events cannot replace the TUI", async () => {
  const harness = await startHarness({ sessionId: "parent" });
  try {
    await waitForSocket(harness.dir);
    const bridge = new TerminalSessionBridge({ workspaceRoot: harness.workspace, bridgeDir: harness.dir });
    harness.ctx.branch.push(message("user", [textBlock("written in the Mac terminal")]));
    harness.ctx.branch.push(message("assistant", [textBlock("same process reply")]));
    for (const options of [{ mode: "rpc" }, { mode: "tui", agent: { kind: "sub" as const } }]) {
      const child = new FakeContext({ sessionId: "child", cwd: harness.workspace, ...options });
      await harness.pi.fire({ type: "session_start" }, child);
      await harness.pi.fire({ type: "agent_start" }, child);
      await harness.pi.fire({ type: "message_update", message: { role: "assistant", content: "child secret" } }, child);
      await harness.pi.fire({ type: "session_shutdown" }, child);
    }
    const snapshot = await bridge.snapshot("terminal:parent");
    assert.deepEqual(snapshot.messages.map((entry) => entry.text), ["written in the Mac terminal", "same process reply"]);
    assert.equal((await bridge.list())[0]?.sessionId, "terminal:parent");
  } finally { await harness.stop(); }
});

test("OMP subagent identity never publishes a socket even when it reports TUI and hasUI", async () => {
  const harness = await startHarness({ sessionId: "sub", mode: "tui", hasUI: true, agent: { kind: "sub" } });
  try {
    await delay(30);
    assert.deepEqual(socketNames(harness.dir), []);
  } finally { await harness.stop(); }
});

test("globally installed copy plus explicit -e copy publish one bridge and survive session replacement", async () => {
  const dir = join(tempDir(), "bridge");
  const workspace = join(tempDir(), "workspace");
  mkdirSync(workspace);
  process.env.PI_REMOTE_BRIDGE_DIR = dir;
  const firstFactory = await loadFactory();
  const copiedPath = join(tempDir(), "copied-extension.ts");
  copyFileSync(new URL("../src/terminal/extension.ts", import.meta.url), copiedPath);
  // This is the same extension module loaded from a distinct path, as OMP's loader does.
  const copiedModule = await import(pathToFileURL(copiedPath).href) as { default: (pi: unknown) => void };
  const first = new FakePi();
  const second = new FakePi();
  firstFactory(first);
  copiedModule.default(first);
  assert.equal(first.handlers.get("session_start")?.length, 1, "same API must not register twice");
  copiedModule.default(second);
  const ctx = new FakeContext({ sessionId: "singleton-initial", cwd: workspace });
  await first.fire({ type: "session_start" }, ctx);
  await second.fire({ type: "session_start" }, ctx);
  try {
    await waitForSocket(dir);
    await delay(30);
    assert.equal(socketNames(dir).length, 1);
    const bridge = new TerminalSessionBridge({ workspaceRoot: workspace, bridgeDir: dir });
    await bridge.prompt("terminal:singleton-initial", "single writer");
    assert.deepEqual(first.sent, ["single writer"]);
    assert.deepEqual(second.sent, []);
    ctx.sessionId = "singleton-replaced";
    // Reverse order checks the suppressed copy cannot claim a new id before the owner updates.
    await second.fire({ type: "session_start" }, ctx);
    await first.fire({ type: "session_start" }, ctx);
    assert.equal(socketNames(dir).length, 1);
    assert.deepEqual((await bridge.list()).map((session) => session.sessionId), ["terminal:singleton-replaced"]);
    await first.fire({ type: "session_shutdown" }, ctx);
    await second.fire({ type: "session_shutdown" }, ctx);
    await delay(20);
    assert.deepEqual(socketNames(dir), []);
    await first.fire({ type: "session_start" }, ctx);
    await second.fire({ type: "session_start" }, ctx);
    await waitForSocket(dir);
    assert.equal(socketNames(dir).length, 1, "the owner alone can restart after shutdown");
  } finally {
    await first.fire({ type: "session_shutdown" }, ctx);
    await second.fire({ type: "session_shutdown" }, ctx);
  }
});

test("v2 stages final assistant until entry identity persists, never deduplicating equal text", async () => {
  const harness = await startHarness({ sessionId: "v2-stream", branch: [
    { id: "user", type: "message", message: { role: "user", content: "start" } },
  ] });
  await waitForSocket(harness.dir);
  const bridge = new TerminalSessionBridge({ workspaceRoot: harness.workspace, bridgeDir: harness.dir });
  try {
    const streamed = { role: "assistant", timestamp: 7, content: [{ type: "text", text: "same text" }] };
    await harness.pi.fire({ type: "message_start", message: streamed }, harness.ctx);
    await harness.pi.fire({ type: "message_update", message: streamed }, harness.ctx);
    const partial = await bridge.view("terminal:v2-stream", { viewVersion: 2 });
    const provisional = partial.items as { id: string; text?: string }[];
    assert.equal(provisional.length, 2);
    assert.ok(provisional[1]!.id.startsWith("stream:"));
    await harness.pi.fire({ type: "message_end", message: streamed }, harness.ctx);
    const staged = await bridge.view("terminal:v2-stream", { viewVersion: 2 });
    assert.deepEqual(staged.items, partial.items, "message_end must not erase the pre-persist window");
    harness.ctx.branch.push({ id: "persisted", type: "message", message: structuredClone(streamed) },
      { id: "other", type: "message", message: { ...streamed, timestamp: 8 } });
    const committed = await bridge.view("terminal:v2-stream", { viewVersion: 2 });
    const items = committed.items as { id: string; text?: string }[];
    assert.deepEqual(items.map(item => item.id), ["user:block-0", "persisted:block-0", "other:block-0"]);
    assert.equal(items.filter(item => item.text === "same text").length, 2);
    assert.equal(committed.branchId, partial.branchId);
    const previousBranch = committed.branchId;
    harness.ctx.branch = [{ id: "user", type: "message", message: { role: "user", content: "start" } },
      { id: "sibling", type: "message", message: { role: "assistant", content: "sibling" } }];
    const switched = await bridge.view("terminal:v2-stream", { viewVersion: 2 });
    assert.notEqual(switched.branchId, previousBranch, "sibling branch switches must reset the page store");
  } finally { bridge.close(); await harness.stop(); }
});

test("v2 tool events expose running and staged safe results through the real bridge", async () => {
  const harness = await startHarness({ sessionId: "v2-tools", branch: [
    { type: "message", id: "calls", message: { role: "assistant", content: [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "fixture", token: "hidden" } },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "second" } },
    ] } },
  ] });
  await waitForSocket(harness.dir);
  const bridge = new TerminalSessionBridge({ workspaceRoot: harness.workspace, bridgeDir: harness.dir });
  try {
    await harness.pi.fire({ type: "tool_execution_start", toolCallId: "c1", toolName: "read" }, harness.ctx);
    let page = await bridge.view("terminal:v2-tools", { viewVersion: 2 });
    let items = page.items as Record<string, unknown>[];
    assert.equal(items[0]?.status, "running");
    assert.equal(items[1]?.status, "unknown");
    await harness.pi.fire({ type: "tool_execution_end", toolCallId: "c1", toolName: "read",
      result: { content: [{ type: "text", text: "synthetic safe result" }], details: { secret: "never-send" } }, isError: false }, harness.ctx);
    page = await bridge.view("terminal:v2-tools", { viewVersion: 2 });
    items = page.items as Record<string, unknown>[];
    assert.equal(items[0]?.status, "succeeded");
    const detail = await bridge.view("terminal:v2-tools", { viewVersion: 2, view: "tool", detailId: items[0]?.detailId, revision: page.revision });
    assert.equal(detail.text, "synthetic safe result");
    assert.ok(!JSON.stringify(detail).includes("never-send"));
    harness.ctx.branch.push({ type: "message", id: "result", message: { role: "toolResult", toolCallId: "c1", content: "synthetic safe result" } });
    page = await bridge.view("terminal:v2-tools", { viewVersion: 2 });
    items = page.items as Record<string, unknown>[];
    assert.equal(items.filter(item => item.kind === "toolResult").length, 1);
    const legacy = await bridge.snapshot("terminal:v2-tools");
    assert.deepEqual(legacy.messages, [], "legacy text-only contract must still omit tool content");
  } finally { bridge.close(); await harness.stop(); }
});

const modelA = { provider: "test", id: "a", name: "A", headers: { Authorization: "secret" } };
const modelB = { provider: "test", id: "b", name: "B", apiKey: "secret" };
const chooseB = { provider: "test", modelId: "b" };

function enableModels(h: BridgeHarness, dialect: "omp" | "pi" = "omp") {
  const state = { current: modelA as typeof modelA | typeof modelB, pending: false, reject: false,
    beforeList: async () => {}, beforeSet: async () => {}, switches: 0 };
  const list = async () => { await state.beforeList(); return [modelA, modelB]; };
  if (dialect === "omp") Object.assign(h.ctx, { models: { list, current: () => state.current } });
  else Object.defineProperties(h.ctx, {
    modelRegistry: { value: { getAvailable: list } }, model: { get: () => state.current },
  });
  Object.assign(h.ctx, { hasPendingMessages: () => state.pending });
  Object.assign(h.pi, { setModel: async (model: typeof modelA | typeof modelB) => {
    await state.beforeSet();
    if (state.reject) return false;
    state.switches++;
    state.current = model;
    return true;
  } });
  return state;
}

test("terminal model API supports OMP and Pi, hides secrets, and preserves conversation", async () => {
  for (const dialect of ["omp", "pi"] as const) {
    const h = await startHarness({ sessionId: `models-${dialect}`, branch: [message("user", "keep this history")] });
    const state = enableModels(h, dialect);
    const bridge = new TerminalSessionBridge({ workspaceRoot: h.workspace, bridgeDir: h.dir });
    const id = `terminal:models-${dialect}`;
    try {
      await waitForSocket(h.dir);
      assert.equal((await bridge.get(id)).capabilities?.modelSelection, true);
      assert.deepEqual(await bridge.models(id), { sessionId: id, models: [
        { provider: "test", modelId: "a", name: "A" }, { ...chooseB, name: "B" }], model: { provider: "test", modelId: "a", name: "A" } });
      assert.deepEqual(await bridge.setModel(id, chooseB), { sessionId: id, model: { ...chooseB, name: "B" } });
      assert.deepEqual(await bridge.getModel(id), { sessionId: id, model: { ...chooseB, name: "B" } });
      state.current = modelA;
      assert.equal((await bridge.getModel(id)).model?.modelId, "a", "Mac model changes must be observed live");
      assert.deepEqual((await bridge.snapshot(id)).messages, [{ role: "user", text: "keep this history" }]);
      assert.deepEqual(h.pi.sent, []);
      assert.equal(state.switches, 1);
    } finally { bridge.close(); await h.stop(); }
  }
});

test("terminal model changes require idle state, valid credentials, and an explicit current session", async () => {
  const h = await startHarness({ sessionId: "model-guards" });
  const state = enableModels(h);
  const socket = await waitForSocket(h.dir);
  const bridge = new TerminalSessionBridge({ workspaceRoot: h.workspace, bridgeDir: h.dir });
  const id = "terminal:model-guards";
  try {
    const missing = await rawCall(socket, { op: "set_model", model: chooseB });
    assert.equal((missing.error as { code: string }).code, "invalid_request");
    const stale = await rawCall(socket, { op: "set_model", sessionId: "terminal:old", model: chooseB });
    assert.equal((stale.error as { code: string }).code, "stale_session");
    h.ctx.idle = false;
    await assert.rejects(bridge.setModel(id, chooseB), { code: "session_busy" });
    h.ctx.idle = true;
    state.pending = true;
    await assert.rejects(bridge.setModel(id, chooseB), { code: "session_busy" });
    state.pending = false;
    await assert.rejects(bridge.setModel(id, { ...chooseB, modelId: "missing" }), { code: "invalid_frame" });
    state.reject = true;
    await assert.rejects(bridge.setModel(id, chooseB), { code: "invalid_frame" });
    assert.equal(state.switches, 0);
    state.reject = false;
    await bridge.setModel(id, chooseB);
    assert.equal(state.switches, 1, "rejected switches release the lock");
  } finally { bridge.close(); await h.stop(); }
});

test("terminal switching blocks prompts and rechecks session identity after asynchronous discovery", async () => {
  const h = await startHarness({ sessionId: "model-race" });
  const state = enableModels(h);
  await waitForSocket(h.dir);
  const bridge = new TerminalSessionBridge({ workspaceRoot: h.workspace, bridgeDir: h.dir });
  const id = "terminal:model-race";
  let release!: () => void;
  state.beforeList = () => new Promise<void>(resolve => { release = resolve; });
  try {
    const pending = bridge.setModel(id, chooseB);
    for (let i = 0; i < 100 && !release; i++) await delay(5);
    assert.ok(release);
    await assert.rejects(bridge.prompt(id, "must not send"), { code: "session_busy" });
    await assert.rejects(bridge.setModel(id, chooseB), { code: "session_busy" });
    h.ctx.sessionId = "model-replaced";
    release();
    await assert.rejects(pending, { code: "unknown_session" });
    assert.equal(state.switches, 0);
    assert.deepEqual(h.pi.sent, []);
  } finally { release?.(); bridge.close(); await h.stop(); }
});

test("old terminal bridges advertise no model capability and fail with upgrade guidance", async () => {
  const h = await startHarness({ sessionId: "old-model-bridge" });
  const bridge = new TerminalSessionBridge({ workspaceRoot: h.workspace, bridgeDir: h.dir });
  try {
    await waitForSocket(h.dir);
    assert.equal((await bridge.get("terminal:old-model-bridge")).capabilities?.modelSelection, undefined);
    await assert.rejects(bridge.setModel("terminal:old-model-bridge", chooseB), { code: "not_implemented" });
  } finally { bridge.close(); await h.stop(); }
});

test("new and resumed terminal sessions apply models only after launch, preserving IDs on failure", async () => {
  const h = await startHarness({ sessionId: "model-resume", branch: [message("user", "original history")] });
  const state = enableModels(h);
  const bridge = new TerminalSessionBridge({ workspaceRoot: h.workspace, bridgeDir: h.dir });
  const manager = new PiProcessManager({ piBin: "must-not-spawn", spawnFn: () => { throw new Error("must not spawn RPC"); } });
  const root = join(realpathSync(h.workspace), "history");
  mkdirSync(join(root, "bucket"), { recursive: true, mode: 0o700 });
  const file = join(root, "bucket", "model-resume.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "model-resume", cwd: h.workspace, timestamp: "2026-10-07T00:00:00Z" }) + "\n", { mode: 0o600 });
  const before = readFileSync(file);
  const history = new OmpHistoryIndex({ workspaceRoot: h.workspace, roots: [root] });
  let launched = 0;
  let resumed = 0;
  const handler = createPiAgentHandler({ manager, workspaceRoot: h.workspace, runtime: "omp", terminalBridge: bridge, history,
    modelCatalog: async cwd => { assert.equal(cwd, realpathSync(h.workspace)); return [{ ...chooseB, name: "B" }]; },
    terminalLauncher: {
      start: async () => { launched++; return bridge.get("terminal:model-resume"); },
      resume: async target => { resumed++; assert.equal(target.file, file); await target.verify(); return bridge.get("terminal:model-resume"); },
    },
  });
  try {
    await waitForSocket(h.dir);
    await history.ready();
    const alias = ((await history.list({})).sessions as { sessionId: string }[])[0]!.sessionId;
    const catalog = await handler(requestFrame("catalog", "model.list", { params: { historySessionId: alias } }));
    assert.equal(catalog.ok, true, JSON.stringify(catalog));
    assert.equal(launched + resumed, 0, "reading models must not restore a session");
    for (const [restore, reject] of [[false, false], [true, false], [true, true]]) {
      state.reject = reject!;
      const started = await handler(requestFrame("start", "session.start", { params: { mode: "terminal", model: chooseB,
        ...(restore ? { historySessionId: alias } : {}) } }));
      assert.equal(started.ok, true);
      const data = started.data as { sessionId: string; modelSelection: { applied: boolean } };
      assert.equal(data.sessionId, "terminal:model-resume");
      assert.equal(data.modelSelection.applied, !reject);
    }
    assert.equal(launched, 1);
    assert.equal(resumed, 2);
    state.reject = false;
    assert.equal((await handler(requestFrame("retry", "session.set_model", { sessionId: "terminal:model-resume", params: { model: chooseB } }))).ok, true);
    assert.equal(launched + resumed, 3, "retry switches the returned session instead of relaunching");
    const switches = state.switches;
    history.hasConflict = async () => true;
    const conflict = await handler(requestFrame("conflict", "session.set_model", { sessionId: "terminal:model-resume", params: { model: chooseB } }));
    assert.equal(conflict.error?.code, "invalid_frame");
    assert.equal(state.switches, switches);
    assert.deepEqual(h.pi.sent, []);
    assert.deepEqual(readFileSync(file), before);
  } finally { history.close(); bridge.close(); await manager.closeAll(); await h.stop(); }
});

test("the production coordinator applies and confirms models through the real guarded bridge socket", async () => {
  process.argv.push("isolated-omp-darwin-test");
  const h = await startHarness({ sessionId: "coordinated-model" });
  const state = enableModels(h);
  const workspace = realpathSync(h.workspace);
  const root = join(workspace, "history");
  mkdirSync(join(root, "bucket"), { recursive: true, mode: 0o700 });
  const file = join(root, "bucket", "original.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "coordinated-model", cwd: workspace, timestamp: "2026-10-08T00:00:00Z" }) + "\n", { mode: 0o600 });
  h.ctx.sessionManager.getSessionFile = () => file;
  const before = readFileSync(file);
  const bridge = new TerminalSessionBridge({ workspaceRoot: workspace, bridgeDir: h.dir });
  const history = new OmpHistoryIndex({ workspaceRoot: workspace, roots: [root] });
  let resumes = 0;
  const launcher = {
    start: async () => { throw new Error("must-not-create"); },
    resume: async () => { resumes++; return bridge.get("terminal:coordinated-model"); },
  };
  const recovery = new HistoryRecoveryCoordinator({ history, bridge, launcher, workspaceRoot: workspace,
    directory: join(workspace, "operations"), ownerPids: async () => [process.pid] });
  bridge.setControlGuard(meta => recovery.canControl(meta));
  const manager = new PiProcessManager({ piBin: "must-not-spawn" });
  const handler = createPiAgentHandler({ manager, workspaceRoot: workspace, runtime: "omp", terminalBridge: bridge, history, recovery, terminalLauncher: launcher });
  try {
    await history.ready();
    await waitForSocket(h.dir);
    const alias = ((await history.list({})).sessions as { sessionId: string }[])[0]!.sessionId;
    const result = await handler(requestFrame("restore-selected", "session.start", { params: { mode: "terminal", historySessionId: alias, model: chooseB } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    const data = result.data as Record<string, unknown>;
    assert.equal(data.recoveryState, "ready");
    assert.equal(data.sessionId, "terminal:coordinated-model");
    assert.equal((data.modelSelection as Record<string, unknown>).applied, true);
    assert.equal((await bridge.getModel("terminal:coordinated-model")).model?.modelId, chooseB.modelId);
    const query = await handler(requestFrame("read-status", "session.start", { params: { mode: "terminal", recoveryVersion: 1, operationId: data.operationId } }));
    assert.deepEqual((query.data as Record<string, unknown>).modelSelection, data.modelSelection);
    assert.equal(resumes, 1);
    assert.equal(state.switches, 1);
    assert.deepEqual(h.pi.sent, []);
    assert.deepEqual(readFileSync(file), before);
  } finally {
    recovery.close(); history.close(); bridge.close(); await manager.closeAll(); await h.stop(); process.argv.pop();
  }
});
