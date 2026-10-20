import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { claudePayload, health, piPayload, verifyClaude, verifyPi } from "../src/pairing.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }

test("二维码保持现有手机合约", () => {
  assert.deepEqual(JSON.parse(piPayload("wss://relay.example/ws/agent", "test-token")), { version: 1, serverUrl: "wss://relay.example/ws/ios", token: "test-token" });
  const url = new URL(claudePayload("https://test.trycloudflare.com", "a&=+"));
  assert.equal(url.protocol, "claude-remote:");
  assert.equal(url.hostname, "setup");
  assert.equal(url.searchParams.get("token"), "a&=+");
  assert.equal(url.searchParams.get("bases"), "https://test.trycloudflare.com");
});

test("健康检查验证凭据和实例，拒绝重定向", async () => {
  let mode = "ok", leaked = false;
  const target = createServer((_req, res) => { leaked = true; res.end("{}"); });
  const targetBase = await listen(target);
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer private-token");
    if (mode === "redirect") { res.writeHead(302, { Location: targetBase }).end(); return; }
    if (mode === "auth") { res.writeHead(401).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "pi-remote-claude", instanceId: "fixture" }));
  });
  const base = await listen(server), signal = new AbortController().signal;
  try {
    await verifyClaude(base, "private-token", "fixture", signal);
    await assert.rejects(verifyClaude(base, "private-token", "different", signal), /实例不匹配/);
    mode = "redirect";
    await assert.rejects(health(base, "private-token", signal), /重定向/);
    assert.equal(leaked, false);
    mode = "auth";
    await assert.rejects(health(base, "private-token", signal), /认证失败/);
  } finally { await close(server); await close(target); }
});

test("Pi 就绪检查包含认证的手机 WebSocket 握手", async () => {
  let handshake = false;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/api/status");
    assert.equal(req.headers.authorization, "Bearer private-token");
    res.end(JSON.stringify({ status: "ok", agentConnected: true, agentDeviceId: "fixture-device" }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.url, "/ws/ios");
    assert.equal(req.headers.authorization, "Bearer private-token");
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const hello = JSON.parse(data.toString());
        assert.equal(hello.payload.role, "ios"); handshake = true;
        ws.send(JSON.stringify({ version: 1, type: "hello_ack", payload: { role: "ios", agentConnected: true } }));
      });
    });
  });
  const base = await listen(server);
  try { await verifyPi(base, "private-token", "fixture-device", new AbortController().signal); assert.equal(handshake, true); }
  finally { for (const client of wss.clients) client.terminate(); wss.close(); await close(server); }
});
