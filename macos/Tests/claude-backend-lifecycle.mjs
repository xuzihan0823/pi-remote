import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = await mkdtemp(path.join(tmpdir(), "pi-claude-lifecycle-"));
const runtime = process.env.PI_REMOTE_TEST_RUNTIME ?? root;
const supervisor = process.env.PI_REMOTE_TEST_RUNTIME
  ? path.join(runtime, "runtime-supervisor.mjs")
  : path.join(root, "macos/runtime-supervisor.mjs");
const node = process.env.PI_REMOTE_TEST_RUNTIME ? path.join(runtime, "node") : process.execPath;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function port() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const number = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return number;
}

function completion(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function managed(entry, env, tag) {
  const child = spawn(node, [supervisor], { stdio: ["pipe", "pipe", "pipe"] });
  const service = { child, done: completion(child), output: "" };
  children.push(service);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { service.output += chunk; });
  child.stdin.write(JSON.stringify({ command: node, args: [entry], cwd: directory, env, tag, killGraceMs: 5000 }) + "\n");
  return service;
}

async function stop(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  service.child.stdin.end();
  const result = await Promise.race([service.done, sleep(9000).then(() => { throw new Error("supervisor failed to stop"); })]);
  assert.equal(result.code, 0, service.output);
}

async function health(base, token, expectedInstance) {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      response = await fetch(base + "/api/health", { headers: token ? { authorization: "Bearer " + token } : {}, signal: AbortSignal.timeout(1000) });
      if (response.status === 200) break;
    } catch {}
    await sleep(100);
  }
  assert.equal(response?.status, 200);
  const data = await response.json();
  if (expectedInstance) {
    assert.equal(data.service, "pi-remote-claude");
    assert.equal(data.instanceId, expectedInstance);
  }
  return data;
}

async function socket(base, token, allowed, endpoint) {
  const ws = new WebSocket(base.replace("http:", "ws:") + endpoint + "?token=" + encodeURIComponent(token));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket timeout")), 3000);
      ws.once("open", () => { clearTimeout(timer); allowed ? resolve() : reject(new Error("wrong token accepted")); });
      ws.once("error", (error) => {
        clearTimeout(timer);
        !allowed && error.message.includes("401") ? resolve() : reject(error);
      });
    });
    if (allowed) ws.send(JSON.stringify({ type: "subscribe", sessionId: "*" }));
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }
}

try {
  const backend = process.env.PI_REMOTE_TEST_RUNTIME ? path.join(runtime, "claude") : path.join(directory, "claude-runtime");
  if (!process.env.PI_REMOTE_TEST_RUNTIME) {
    const pack = spawn(node, [path.join(root, "backend/claude/scripts/package-runtime.mjs"), backend], { stdio: "ignore" });
    assert.equal((await completion(pack)).code, 0, "Claude runtime packaging failed");
  }
  const piToken = "p".repeat(64);
  const claudeToken = "c".repeat(64);
  const instance = randomUUID().toUpperCase();
  const piPort = await port();
  let claudePort = await port();
  while (claudePort === piPort) claudePort = await port();
  const piBase = "http://127.0.0.1:" + piPort;
  const claudeBase = "http://127.0.0.1:" + claudePort;
  const projects = path.join(directory, "projects");
  await mkdir(projects);
  await writeFile(path.join(directory, ".env"), "BRIDGE_HOST=0.0.0.0\nBRIDGE_PORT=1\nBRIDGE_TOKEN=wrong\n");
  const common = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory };
  const piEnv = { ...common, RELAY_HOST: "127.0.0.1", RELAY_PORT: String(piPort), RELAY_TOKEN: piToken, PI_WORKSPACE_ROOT: directory };
  const claudeEnv = {
    ...common, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(claudePort), BRIDGE_TOKEN: claudeToken,
    BRIDGE_INSTANCE_ID: instance, CLAUDE_BIN: "/usr/bin/true", CLAUDE_PROJECTS_DIR: projects,
    INTERACTIONS_DB_PATH: path.join(directory, "claude-state/interactions.sqlite"), UPLOADS_DIR: path.join(directory, "claude-state/uploads"),
  };
  const pi = managed(path.join(runtime, "src/index.ts"), piEnv, "relay");
  const claude = managed(path.join(backend, "src/index.ts"), claudeEnv, "claude");
  await health(piBase);
  await health(claudeBase, claudeToken, instance);
  assert.equal((await fetch(claudeBase + "/api/health", { headers: { authorization: "Bearer " + piToken } })).status, 401);
  assert.equal((await fetch(claudeBase + "/")).status, 404);
  const pair = await fetch(claudeBase + "/api/pair-info");
  assert.equal(pair.status, 200);
  assert.equal(pair.headers.get("cache-control"), "no-store");
  assert.equal((await pair.json()).token, claudeToken);
  assert.equal((await fetch(claudeBase + "/api/pair-info", { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(claudeBase + "/api/pair-info", { headers: { "x-forwarded-for": "1.2.3.4" } })).status, 403);
  await socket(claudeBase, claudeToken, true, "/ws");
  await socket(claudeBase, piToken, false, "/ws");
  await socket(piBase, piToken, true, "/ws/ios");
  await socket(piBase, claudeToken, false, "/ws/ios");
  await stop(claude);
  await health(piBase);
  const restarted = managed(path.join(backend, "src/index.ts"), claudeEnv, "claude");
  await health(claudeBase, claudeToken, instance);
  await stop(pi);
  await health(claudeBase, claudeToken, instance);
  await stop(restarted);
  for (const service of children) {
    assert.ok(!service.output.includes(piToken) && !service.output.includes(claudeToken), "credentials leaked to output");
  }
  console.log("PASS: packaged Pi/Claude HTTP + WebSocket authentication, pairing gates, .env isolation, independent stop/restart and cleanup");
} finally {
  for (const service of children) await stop(service);
  await rm(directory, { recursive: true, force: true });
}
