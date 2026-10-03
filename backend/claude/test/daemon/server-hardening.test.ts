// 独立后端加固测试：health 强身份、无 webRoot 时静态 404、配对端点的
// Host/Origin/代理门禁与无 CORS * 暴露。用裸 http 请求才能精确控制 Host/Origin。

import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { DaemonConfig } from "../../src/config.ts";
import type { ApprovalBridge, Notifier, TurnRunner } from "../../src/run/index.ts";
import { DaemonServer } from "../../src/server.ts";
import { ActivityTracker } from "../../src/watch/activity.ts";
import { SessionWatcher } from "../../src/watch/watcher.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: DaemonServer;
let port: number;
let root: string;
let watcher: SessionWatcher;
let tracker: ActivityTracker;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-hardening-"));
  const config: DaemonConfig = {
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    projectsDir: join(root, "projects"),
    uploadsDir: join(root, "uploads"),
    cooldownMs: 120_000,
    interactionsDbPath: ":memory:",
    permissionTimeoutMs: 300_000,
    publicBases: [],
    instanceId: INSTANCE_ID,
  };
  watcher = new SessionWatcher({ projectsDir: config.projectsDir });
  tracker = new ActivityTracker({ cooldownMs: 120_000 });
  const runner = { abort: () => {}, activeRunId: () => undefined } as unknown as TurnRunner;
  const approvals = { decide: () => ({ status: "not_found" }) } as unknown as ApprovalBridge;
  const notifier: Notifier = async () => {};
  server = new DaemonServer({ config, watcher, tracker, runner, approvals, notifier, version: "0.1.0-test", claudeCliVersion: () => "unknown" });
  await server.listen();
  port = server.address().port;
});

after(async () => {
  await server.close();
  watcher.close();
  tracker.dispose();
  await rm(root, { recursive: true, force: true });
});

function rawGet(path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

test("health 返回强身份 service + instanceId", async () => {
  const res = await rawGet("/api/health", { Authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    service: "pi-remote-claude",
    instanceId: INSTANCE_ID,
    version: "0.1.0-test",
    claudeCliVersion: "unknown",
  });
});

test("无 webRoot：非 API 的 GET/HEAD 一律 404", async () => {
  for (const path of ["/", "/index.html", "/assets/app.js", "/../etc/passwd"]) {
    const res = await rawGet(path);
    assert.equal(res.status, 404, `${path} 应 404`);
    assert.deepEqual(JSON.parse(res.body), { error: "not_found" });
  }
});

test("配对端点：直连/Host 合法放行，Host 非本机名或端口不符 403", async () => {
  const direct = await rawGet("/api/pair-info");
  assert.equal(direct.status, 200);
  assert.equal(direct.headers["cache-control"], "no-store");
  assert.equal(direct.headers["access-control-allow-origin"], undefined, "pair 不得带 CORS *");
  const info = JSON.parse(direct.body) as { token: string };
  assert.equal(info.token, TOKEN);

  for (const host of ["localhost:" + port, "[::1]:" + port]) {
    const res = await rawGet("/api/pair-info", { Host: host });
    assert.equal(res.status, 200, `Host ${host} 应放行`);
  }
  const wrongPort = port === 65535 ? 65000 : port + 1;
  for (const host of ["evil.com:" + port, `127.0.0.1:${wrongPort}`, "127.0.0.1", "localhost", "[::1]"]) {
    const res = await rawGet("/api/pair-info", { Host: host });
    assert.equal(res.status, 403, `Host ${host} 应拒绝`);
    assert.deepEqual(JSON.parse(res.body), { error: "loopback_only" });
  }
});

test("配对端点：Origin 必须与本机 Host 严格同源，null/跨站 403", async () => {
  const sameOrigin = await rawGet("/api/pair-info", { Origin: `http://127.0.0.1:${port}` });
  assert.equal(sameOrigin.status, 200);

  for (const origin of ["null", `http://localhost:${port}`, "http://evil.com", `https://127.0.0.1:${port}`]) {
    const res = await rawGet("/api/pair-info", { Origin: origin });
    assert.equal(res.status, 403, `Origin ${origin} 应拒绝`);
  }
});

test("配对端点：代理特征头一律 403；qr.svg 同样走门禁且 no-store", async () => {
  const viaProxy = await rawGet("/api/pair-info", { "x-forwarded-for": "1.2.3.4" });
  assert.equal(viaProxy.status, 403);
  const qr = await rawGet("/api/pair-qr.svg");
  assert.equal(qr.status, 200);
  assert.equal(qr.headers["content-type"], "image/svg+xml");
  assert.equal(qr.headers["cache-control"], "no-store");
  assert.equal(qr.headers["access-control-allow-origin"], undefined);
  const qrBad = await rawGet("/api/pair-qr.svg", { Origin: "null" });
  assert.equal(qrBad.status, 403);
});

test("普通 API 仍保留 CORS *；pair 分支独立不受影响", async () => {
  const preflight = await new Promise<RawResponse>((resolvePromise, rejectPromise) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/health", method: "OPTIONS" }, (res) => {
      res.resume();
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: "" }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
});
