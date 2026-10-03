// production packager 与打包产物冒烟测试：
//  - package-runtime.mjs 产出可运行闭包（含 src/package.json/package-lock/production node_modules）
//  - 排除 dev 依赖与测试目录；不联网
//  - 拒绝危险输出目录
//  - 打包产物在任意 cwd 下 `node src/index.ts` 可启动，health 身份正确、退出码 0、不泄漏 token/QR

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGER = join(BACKEND_ROOT, "scripts", "package-runtime.mjs");
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runNode(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, args, { cwd: options.cwd, env: options.env, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error !== null && typeof (error as NodeJS.ErrnoException).code !== "number") {
        rejectPromise(error);
        return;
      }
      resolvePromise({ code: error === null ? 0 : Number((error as { code?: number }).code ?? 1), stdout, stderr });
    });
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolvePromise(port));
    });
  });
}

let base: string;
let runtimeDir: string;

before(async () => {
  base = await mkdtemp(join(tmpdir(), "claude-packager-"));
  runtimeDir = join(base, "runtime");
  const result = await runNode([PACKAGER, runtimeDir], { cwd: base });
  assert.equal(result.code, 0, `packager 失败: ${result.stderr}`);
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

test("打包产物：src/package 文件 + production 闭包，排除 dev/测试", async () => {
  assert.ok(await exists(join(runtimeDir, "src", "index.ts")));
  assert.ok(await exists(join(runtimeDir, "package.json")));
  assert.ok(await exists(join(runtimeDir, "package-lock.json")));
  assert.ok(await exists(join(runtimeDir, "node_modules", "ws", "package.json")));
  assert.ok(await exists(join(runtimeDir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json")));

  assert.equal(await exists(join(runtimeDir, "test")), false, "不得包含 backend 测试");
  assert.equal(await exists(join(runtimeDir, "node_modules", "typescript")), false, "不得包含 typescript");
  assert.equal(await exists(join(runtimeDir, "node_modules", "@types")), false, "不得包含 @types");

  const pkg = JSON.parse(await readFile(join(runtimeDir, "package.json"), "utf8")) as { name: string };
  assert.equal(pkg.name, "@pi-remote/claude-backend");
  const lock = JSON.parse(await readFile(join(runtimeDir, "package-lock.json"), "utf8")) as { lockfileVersion: number };
  assert.equal(lock.lockfileVersion, 3);
});

test("打包器安全：拒绝 backend 源码目录/其祖先/非空目录，且不破坏现有文件", async () => {
  const inside = await runNode([PACKAGER, join(BACKEND_ROOT, "src")], { cwd: base });
  assert.notEqual(inside.code, 0);
  assert.match(inside.stderr, /拒绝/);

  const ancestor = await runNode([PACKAGER, resolve(BACKEND_ROOT, "..")], { cwd: base });
  assert.notEqual(ancestor.code, 0);
  assert.match(ancestor.stderr, /拒绝/);

  const nonEmpty = join(base, "non-empty");
  await mkdir(nonEmpty, { recursive: true });
  const sentinel = join(nonEmpty, "keep.txt");
  await writeFile(sentinel, "keep");
  const result = await runNode([PACKAGER, nonEmpty], { cwd: base });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /非空/);
  assert.equal(await readFile(sentinel, "utf8"), "keep", "不得删除用户目录内容");
});

test("打包产物：任意 cwd 下可启动，health 强身份、静态 404、优雅退出且不泄漏 token", async () => {
  const runCwd = join(base, "arbitrary-cwd");
  const projects = join(runCwd, "projects");
  await mkdir(projects, { recursive: true });
  const port = await freePort();

  const child = execFile(process.execPath, [join(runtimeDir, "src", "index.ts")], {
    cwd: runCwd,
    env: {
      ...process.env,
      BRIDGE_TOKEN: TOKEN,
      BRIDGE_PORT: String(port),
      BRIDGE_INSTANCE_ID: INSTANCE_ID,
      INTERACTIONS_DB_PATH: ":memory:",
      UPLOADS_DIR: join(runCwd, "uploads"),
      CLAUDE_PROJECTS_DIR: projects,
      CLAUDE_BIN: process.execPath,
    },
  });
  let stdout = "";
  let stderr = "";
  let resolveListening: () => void = () => {};
  const listening = new Promise<void>((resolvePromise) => {
    resolveListening = resolvePromise;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes("listening")) resolveListening();
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  child.once("exit", (code) => resolveExit(code));

  try {
    const outcome = await Promise.race([
      listening.then(() => "ready" as const),
      exited.then(() => "exit" as const),
      delay(20_000).then(() => "timeout" as const),
    ]);
    if (outcome !== "ready") assert.fail(`daemon 未启动(${outcome}): ${stdout}${stderr}`);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(health.status, 200);
    const body = (await health.json()) as Record<string, unknown>;
    assert.equal(body.service, "pi-remote-claude");
    assert.equal(body.instanceId, INSTANCE_ID);

    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 404);

    child.kill("SIGTERM");
    const code = await exited;
    assert.equal(code, 0, "SIGTERM 应优雅退出");
    assert.equal(`${stdout}${stderr}`.includes(TOKEN), false, "输出不得包含 token");
    assert.equal(`${stdout}${stderr}`.includes("claude-remote://"), false, "输出不得包含配对 QR payload");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
