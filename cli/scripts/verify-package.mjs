import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "pi-cli-package-"));
let child;
let closed;
try {
  await execFile("npm", ["run", "build"], { cwd: root, timeout: 60_000 });
  const { stdout } = await execFile("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, timeout: 60_000 });
  const metadata = JSON.parse(stdout)[0];
  for (const entry of metadata.files) {
    assert.ok(!/(^|\/)(node_modules|test|\.env)(\/|$)/.test(entry.path), entry.path);
    assert.ok(!/\.(pem|key|ts)$/.test(entry.path), entry.path);
  }
  const prefix = join(scratch, "installation");
  await execFile("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", join(scratch, metadata.filename)], { cwd: scratch, timeout: 120_000 });
  const installed = join(prefix, "node_modules", "@pi-remote", "cli");
  const binary = join(prefix, "node_modules", ".bin", "pi-remote");
  const help = await execFile(binary, ["--help"], { cwd: scratch });
  assert.match(help.stdout, /pi-remote start/);
  const version = await execFile(binary, ["--version"], { cwd: scratch });
  assert.match(version.stdout, /^0\.1\.0/);
  await assert.rejects(execFile(binary, ["start", "--config", join(scratch, "missing.json")], { cwd: scratch }), /首次配置需要交互终端/);
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const token = randomBytes(32).toString("hex"), instanceId = randomUUID();
  const data = join(scratch, "data"), projects = join(scratch, "projects");
  await mkdir(data); await mkdir(projects);
  let stderr = "";
  child = spawn(process.execPath, [join(installed, "dist/services/claude/src/index.js")], {
    cwd: scratch, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(port), BRIDGE_TOKEN: token, BRIDGE_INSTANCE_ID: instanceId,
      CLAUDE_BIN: process.execPath, CLAUDE_PROJECTS_DIR: projects, INTERACTIONS_DB_PATH: join(data, "interactions.sqlite"), UPLOADS_DIR: join(data, "uploads") },
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  closed = new Promise((done) => child.once("close", (code) => done(code)));
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Packaged backend exited: ${stderr.replaceAll(token, "[hidden]")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      const info = await response.json();
      assert.equal(response.status, 200); assert.equal(info.service, "pi-remote-claude"); assert.equal(info.instanceId, instanceId);
      healthy = true; break;
    } catch { await delay(100); }
  }
  assert.ok(healthy, "Packaged backend did not become healthy");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try { assert.equal(await closed, 0); } finally { clearTimeout(timer); }
  console.log("隔离安装验证通过：仓库外命令、非交互失败提示、真实后端健康与退出；未调用模型。");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
  await rm(scratch, { recursive: true, force: true });
}
