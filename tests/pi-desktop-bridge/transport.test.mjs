import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isPrivateHost, normalizeRelayUrl, validateAgentToken, allowsTransport } = require("../../plugins/pi-desktop-bridge/lib/transport.js");
const { Backoff } = require("../../plugins/pi-desktop-bridge/lib/backoff.js");
const { encodeFrame, parseFrame, HOST_MAX_FRAME_BYTES, FRAME_BUDGET_BYTES } = require("../../plugins/pi-desktop-bridge/lib/frames.js");

test("私有地址判定与 iOS TransportSecurity 一致", () => {
  for (const host of ["localhost", "mac.local", "relay.tail1234.ts.net", "127.0.0.1", "10.1.2.3", "192.168.1.10",
    "172.16.0.1", "172.31.255.255", "169.254.1.1", "100.64.0.1", "100.127.255.255", "::1", "[fe80::1]", "fd00::1"]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ["relay.example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2001:db8::1", "", "999.1.1.1"]) {
    assert.equal(isPrivateHost(host), false, host);
  }
  assert.equal(allowsTransport("wss", "relay.example.com"), true);
  assert.equal(allowsTransport("ws", "relay.example.com"), false);
  assert.equal(allowsTransport("ftp", "localhost"), false);
});

test("Relay 地址规范化：公网强制 wss，自动补 /ws/agent", () => {
  assert.deepEqual(normalizeRelayUrl("wss://relay.example.com"), { ok: true, url: "wss://relay.example.com/ws/agent" });
  assert.deepEqual(normalizeRelayUrl(" https://relay.example.com:8443/ "), { ok: true, url: "wss://relay.example.com:8443/ws/agent" });
  assert.deepEqual(normalizeRelayUrl("ws://192.168.1.20:8787/ws/agent"), { ok: true, url: "ws://192.168.1.20:8787/ws/agent" });
  assert.deepEqual(normalizeRelayUrl("http://mac-mini.tail1234.ts.net:8787"), { ok: true, url: "ws://mac-mini.tail1234.ts.net:8787/ws/agent" });
  assert.deepEqual(normalizeRelayUrl("ws://[::1]:8787"), { ok: true, url: "ws://[::1]:8787/ws/agent" });

  assert.equal(normalizeRelayUrl("ws://relay.example.com").ok, false);
  assert.match(normalizeRelayUrl("ws://relay.example.com").error, /wss/);
  assert.equal(normalizeRelayUrl("wss://relay.example.com/ws/agent?token=abc").ok, false);
  assert.equal(normalizeRelayUrl("wss://user:pass@relay.example.com").ok, false);
  assert.equal(normalizeRelayUrl("wss://relay.example.com/ws/ios").ok, false);
  assert.equal(normalizeRelayUrl("ftp://relay.example.com").ok, false);
  assert.equal(normalizeRelayUrl("").ok, false);
  assert.equal(normalizeRelayUrl("not a url").ok, false);
});

test("AGENT_TOKEN 形态检查", () => {
  assert.deepEqual(validateAgentToken("  abc123  "), { ok: true, token: "abc123" });
  assert.equal(validateAgentToken("").ok, false);
  assert.equal(validateAgentToken("has space").ok, false);
  assert.equal(validateAgentToken("x".repeat(5000)).ok, false);
});

test("指数退避：翻倍、封顶、重置与惩罚", () => {
  const backoff = new Backoff({ baseMs: 1000, maxMs: 30_000, jitter: 0.2, random: () => 0.5 });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(() => backoff.next()), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  backoff.reset();
  assert.equal(backoff.next(), 1000);
  backoff.penalize();
  assert.equal(backoff.next(), 30000);

  const jittered = new Backoff({ baseMs: 1000, maxMs: 60_000, jitter: 0.2, random: () => 0 });
  assert.equal(jittered.next(), 800);
  const high = new Backoff({ baseMs: 1000, maxMs: 60_000, jitter: 0.2, random: () => 0.999999 });
  assert.equal(high.next(), 1200);
});

test("帧体积保护：超限 response 改写为 result_too_large，超限事件丢弃", () => {
  assert.ok(FRAME_BUDGET_BYTES < HOST_MAX_FRAME_BYTES);
  const small = { version: 1, type: "response", requestId: "r1", payload: { ok: true, data: { a: 1 } } };
  assert.equal(encodeFrame(small), JSON.stringify(small));

  const big = { version: 1, type: "response", requestId: "r2", sessionId: "terminal:desktop:s1", payload: { ok: true, data: { text: "x".repeat(HOST_MAX_FRAME_BYTES) } } };
  const encoded = encodeFrame(big);
  assert.ok(Buffer.byteLength(encoded) < HOST_MAX_FRAME_BYTES);
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.requestId, "r2");
  assert.equal(parsed.sessionId, "terminal:desktop:s1");
  assert.deepEqual(parsed.payload.ok, false);
  assert.equal(parsed.payload.error.code, "result_too_large");

  const event = { version: 1, type: "session_event", sessionId: "s", payload: { event: { text: "y".repeat(HOST_MAX_FRAME_BYTES) } } };
  assert.equal(encodeFrame(event), null);
});

test("帧解析：只接受协议版本 1 的已知帧", () => {
  assert.equal(parseFrame("{bad json"), null);
  assert.equal(parseFrame(JSON.stringify({ version: 2, type: "ping" })), null);
  assert.equal(parseFrame(JSON.stringify({ version: 1, type: "unknown" })), null);
  assert.equal(parseFrame(JSON.stringify([1])), null);
  assert.equal(parseFrame(JSON.stringify({ version: 1, type: "ping", payload: {} })).type, "ping");
  assert.equal(parseFrame(Buffer.from(JSON.stringify({ version: 1, type: "pong", payload: {} }))).type, "pong");
});
