import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { TerminalBridgeError, TerminalSessionBridge } from "../src/terminal/bridge-client.ts";

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
    assert.deepEqual(await bridge.list(), [
      {
        sessionId: "terminal:abc-123",
        title: "My terminal session",
        cwd: join(workspace, "proj"),
        activity: "idle",
        runtime: "pi", persistedSessionId: "abc-123", capabilities: { timelineV2: true, toolDetails: true },
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
