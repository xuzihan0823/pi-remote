import assert from "node:assert/strict";
import { spawnSync, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { TerminalBridgeError, type TerminalSessionMeta } from "../src/terminal/bridge-client.ts";
import { TERMINAL_APP, TerminalSessionLauncher, resolveTerminalCwd, resolveTerminalExecutable, type TerminalSessionLauncherOptions } from "../src/terminal/launcher.ts";

class FakeOpen extends EventEmitter {
  killed = 0;
  kill(): boolean { this.killed++; return true; }
}


function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(overrides: Partial<TerminalSessionLauncherOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "launch-test-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const cli = join(root, "omp-test");
  writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let sessions: TerminalSessionMeta[] = [];
  let commandPath = "";
  let command = "";
  let launchId = "";
  const calls: { executable: string; args: string[]; options: SpawnOptions }[] = [];
  const child = new FakeOpen();
  const opened = deferred<void>();
  const bridge = { bridgeDir: join(root, "bridge"), list: async () => sessions };
  const launcher = new TerminalSessionLauncher({
    piBin: cli, workspaceRoot: workspace, bridge, platform: "darwin", timeoutMs: 500, pollIntervalMs: 5,
    spawnFn: (executable, args, options) => {
      calls.push({ executable, args, options });
      commandPath = args[2]!;
      command = readFileSync(commandPath, "utf8");
      launchId = /PI_REMOTE_LAUNCH_ID=([0-9a-f-]{36})/.exec(command)?.[1] ?? "";
      assert.notEqual(launchId, "");
      opened.resolve();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }, ...overrides,
  });
  return {
    root, workspace, cli, calls, child, launcher, bridge, opened: opened.promise,
    get commandPath() { return commandPath; }, get command() { return command; }, get launchId() { return launchId; },
    setSessions(value: TerminalSessionMeta[]) { sessions = value; },
    meta(sessionId = "terminal:new", extra: Partial<TerminalSessionMeta> = {}): TerminalSessionMeta {
      return { sessionId, cwd: workspace, title: "new terminal", activity: "idle", launchId, ...extra };
    },
    cleanup() { launcher.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

async function rejectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof TerminalBridgeError && error.code === code);
}

test("launch pins the real Terminal bundle, private command and exact one-time bridge", async () => {
  const h = harness();
  try {
    const pending = h.launcher.start();
    await h.opened;
    assert.equal(statSync(h.commandPath).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(h.commandPath)).mode & 0o777, 0o700);
    assert.equal(h.calls[0]?.executable, "/usr/bin/open");
    assert.deepEqual(h.calls[0]?.args.slice(0, 2), ["-a", TERMINAL_APP]);
    assert.deepEqual(h.calls[0]?.options.env, {});
    assert.match(h.command, /exec \/usr\/bin\/env -i/);
    assert.match(h.command, /'-e' '[^\n]*\/src\/terminal\/extension.ts'/);
    assert.doesNotMatch(h.command, /--resume|--mode|osascript|RELAY_TOKEN|AGENT_TOKEN/);
    h.setSessions([h.meta("terminal:wrong", { launchId: "00000000-0000-0000-0000-000000000000" }), h.meta()]);
    assert.equal((await pending).sessionId, "terminal:new");
    assert.equal(existsSync(dirname(h.commandPath)), false);
    assert.equal(h.child.killed, 0);
  } finally { h.cleanup(); }
});

test("shell quoting executes literal cwd/binary safely, deletes launch file before exec and strips gateway secrets", async () => {
  const h = harness();
  const output = join(h.root, "output.json");
  const dangerousCwd = join(h.workspace, "work' ; $(echo attack) #");
  mkdirSync(dangerousCwd);
  const dangerousBinary = join(h.root, "omp' ; $(echo attack) #");
  writeFileSync(dangerousBinary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({cwd: process.cwd(), env: process.env, args: process.argv.slice(2), pid: process.pid}));\n`, { mode: 0o700 });
  let commandPath = "";
  const launcher = new TerminalSessionLauncher({
    piBin: dangerousBinary, workspaceRoot: h.workspace, bridge: h.bridge, platform: "darwin", timeoutMs: 1_000,
    spawnFn: (_executable, args) => {
      commandPath = args[2]!;
      const result = spawnSync("/bin/sh", [commandPath], { env: { RELAY_TOKEN: "sensitive-token", AGENT_TOKEN: "agent-secret", MALICIOUS_EXTRA: "must-not-inherit" } });
      assert.equal(result.status, 0, result.stderr?.toString());
      assert.equal(existsSync(commandPath), false);
      assert.equal(existsSync(dirname(commandPath)), false);
      const data = JSON.parse(readFileSync(output, "utf8")) as { cwd: string; env: Record<string, string>; args: string[]; pid: number };
      assert.equal(data.cwd, dangerousCwd);
      assert.equal(data.env.RELAY_TOKEN, undefined);
      assert.equal(data.env.AGENT_TOKEN, undefined);
      assert.equal(data.env.MALICIOUS_EXTRA, undefined);
      assert.equal(data.env.PI_REMOTE_LAUNCH_PID, String(data.pid));
      assert.deepEqual(data.args.slice(0, 1), ["-e"]);
      assert.match(data.args[1]!, /\/src\/terminal\/extension.ts$/);
      h.setSessions([h.meta("terminal:literal", { cwd: dangerousCwd, launchId: data.env.PI_REMOTE_LAUNCH_ID })]);
      queueMicrotask(() => h.child.emit("exit", 0, null));
      return h.child;
    },
  });
  try {
    assert.equal((await launcher.start(dangerousCwd)).sessionId, "terminal:literal");
  } finally { launcher.close(); h.cleanup(); }
});

test("unrelated terminals and old session IDs cannot satisfy a launch; timeout cleans only its own command", async () => {
  const h = harness({ timeoutMs: 80 });
  h.setSessions([h.meta("terminal:existing", { launchId: undefined })]);
  try {
    const pending = h.launcher.start();
    await h.opened;
    h.setSessions([h.meta("terminal:existing"), h.meta("terminal:unrelated", { launchId: "00000000-0000-0000-0000-000000000000" })]);
    await rejectCode(pending, "timeout");
    assert.equal(existsSync(dirname(h.commandPath)), false);
    assert.equal(h.child.killed, 0, "successful open must not signal any terminal on bridge timeout");
    assert.equal((await h.bridge.list()).length, 2, "existing terminals are untouched");
  } finally { h.cleanup(); }
});

test("real cwd allowlist rejects symlink escapes, non-directories, nonexistent paths and traversal before opening", async () => {
  const h = harness();
  const outside = join(h.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(h.workspace, "escape"));
  writeFileSync(join(h.workspace, "file"), "file");
  try {
    for (const cwd of ["escape", "file", "missing", "..", outside, "", "a\0b", 42]) {
      await rejectCode(h.launcher.start(cwd), "invalid_frame");
    }
    assert.equal(h.calls.length, 0);
    symlinkSync(h.workspace, join(h.root, "root-link"));
    assert.equal(await resolveTerminalCwd(join(h.root, "root-link"), undefined), h.workspace);
  } finally { h.cleanup(); }
});

test("configured binary must be a real executable; short names use only the trusted PATH", async () => {
  const h = harness();
  try {
    assert.equal(await resolveTerminalExecutable(h.cli), h.cli);
    const link = join(h.root, "cli-link");
    symlinkSync(h.cli, link);
    assert.equal(await resolveTerminalExecutable(link), h.cli);
    chmodSync(h.cli, 0o600);
    for (const configured of [h.cli, h.workspace, "./omp", "omp --resume", "bad\0path", join(h.root, "missing")]) {
      await rejectCode(resolveTerminalExecutable(configured), "internal_error");
    }
    assert.equal(await resolveTerminalExecutable("sh"), realpathSync("/bin/sh"));
  } finally { h.cleanup(); }
});

test("in-flight launches are rejected and close interrupts a stuck bridge without opening a terminal", async () => {
  const waiting = deferred<TerminalSessionMeta[]>();
  const h = harness({ bridge: { bridgeDir: "/unused", list: () => waiting.promise } });
  try {
    const pending = h.launcher.start();
    await rejectCode(h.launcher.start(), "session_busy");
    h.launcher.close();
    await rejectCode(pending, "internal_error");
    assert.equal(h.calls.length, 0);
    await rejectCode(h.launcher.start(), "internal_error");
  } finally { waiting.resolve([]); h.cleanup(); }
});

test("live terminal and managed sessions count toward the launch cap; non-Mac creation fails explicitly", async () => {
  const h = harness({ maxSessions: 2, managedSessionCount: () => 1 });
  h.setSessions([h.meta("terminal:existing")]);
  try {
    await rejectCode(h.launcher.start(), "session_busy");
    assert.equal(h.calls.length, 0);
    const linux = new TerminalSessionLauncher({ piBin: h.cli, workspaceRoot: h.workspace, bridge: h.bridge, platform: "linux" });
    await rejectCode(linux.start(), "not_implemented");
  } finally { h.cleanup(); }
});

test("failed open and hanging helper are bounded, cleaned up and never target existing terminal processes", async () => {
  const h = harness();
  let commandPath = "";
  const create = (event?: "error" | "exit") => new TerminalSessionLauncher({
    piBin: h.cli, workspaceRoot: h.workspace, bridge: h.bridge, platform: "darwin", timeoutMs: 50,
    spawnFn: (_command, args) => {
      commandPath = args[2]!;
      if (event === "error") queueMicrotask(() => h.child.emit("error", new Error("open error")));
      if (event === "exit") queueMicrotask(() => h.child.emit("exit", 1, null));
      return h.child;
    },
  });
  try {
    for (const event of ["error", "exit", undefined] as const) {
      const launcher = create(event);
      await rejectCode(launcher.start(), event ? "internal_error" : "timeout");
      assert.equal(existsSync(dirname(commandPath)), false);
      launcher.close();
    }
    assert.equal(h.child.killed, 1, "only a still-running open helper is killed");
  } finally { h.cleanup(); }
});

test("duplicate launch claims and wrong cwd are errors rather than choosing the wrong terminal", async () => {
  for (const ambiguous of [true, false]) {
    const h = harness();
    try {
      const pending = h.launcher.start();
      await h.opened;
      h.setSessions(ambiguous ? [h.meta("terminal:a"), h.meta("terminal:b")] : [h.meta("terminal:bad", { cwd: h.root })]);
      await rejectCode(pending, "internal_error");
      assert.equal(existsSync(dirname(h.commandPath)), false);
    } finally { h.cleanup(); }
  }
});
