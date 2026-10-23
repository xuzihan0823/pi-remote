// 端到端：真实的 pi-remote RelayServer（src/relay/server.ts）+ 通过 main.js 加载的插件 + 假 PI-Desktop 宿主。
// 插件的 pi.net.websocket 用 ws 库实现，行为对齐 PI-Desktop 的 plugin-websocket.ts（事件经 pi.events 送达）。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { RelayServer } from "../../src/relay/server.ts";
import { createFakePi, flush } from "./fake-host.mjs";

const require = createRequire(import.meta.url);
const AGENT_TOKEN = "agent-token-0123456789abcdef0123456789abcdef";
const RELAY_TOKEN = "relay-token-0123456789abcdef0123456789abcdef";

function hostWebSockets(events) {
  const sockets = new Map();
  let next = 1;
  return {
    sockets,
    async connect({ url, headers, timeoutMs }) {
      const socketId = `ws-${next++}`;
      const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs ?? 15_000, maxPayload: 1024 * 1024 });
      sockets.set(socketId, ws);
      ws.on("message", (data, isBinary) => events.emit("net:websocket:message", { type: "message", socketId, data: isBinary ? new Uint8Array(data) : data.toString() }));
      ws.on("close", (code, reason) => { sockets.delete(socketId); events.emit("net:websocket:close", { type: "close", socketId, code, reason: reason.toString(), wasClean: code === 1000 }); });
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", (error) => { sockets.delete(socketId); reject(Object.assign(new Error(error.message), { code: "CONNECT_FAILED" })); });
      });
      ws.on("error", (error) => events.emit("net:websocket:error", { type: "error", socketId, code: "SOCKET_ERROR", message: error.message }));
      return { socketId };
    },
    async send({ socketId, data }) {
      const ws = sockets.get(socketId);
      if (!ws) throw Object.assign(new Error("no socket"), { code: "NOT_FOUND" });
      if (Buffer.byteLength(data) > 1024 * 1024) throw Object.assign(new Error("frame too large"), { code: "LIMIT_EXCEEDED" });
      ws.send(data);
    },
    async close({ socketId, code, reason }) {
      sockets.get(socketId)?.close(code, reason);
    },
  };
}

class Phone {
  constructor(port) {
    this.frames = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ios`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } });
    this.ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) if (waiter.match(frame)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(frame); }
    });
  }
  open() { return new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); }); }
  wait(match, timeoutMs = 5000) {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
      this.waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
    });
  }
  async request(requestId, method, { sessionId, params } = {}) {
    this.ws.send(JSON.stringify({ version: 1, type: "request", requestId, ...(sessionId ? { sessionId } : {}), payload: { method, ...(params ? { params } : {}) } }));
    return this.wait((frame) => frame.type === "response" && frame.requestId === requestId);
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("手机经真实 Relay 读取、发送、停止 Pi Desktop 会话", async () => {
  const relay = new RelayServer({
    config: { relayHost: "127.0.0.1", relayPort: 0, relayToken: RELAY_TOKEN, agentToken: AGENT_TOKEN, relayUrl: "ws://127.0.0.1/ws/agent", agentDeviceId: "x", piRuntime: "pi", piBin: "pi", piWorkspaceRoot: "/tmp", maxSessions: 4 },
    logger: () => {},
  });
  const { port } = await relay.start();
  const pi = createFakePi({ settings: { relayUrl: `ws://127.0.0.1:${port}`, agentToken: AGENT_TOKEN, deviceName: "Studio Mac" } });
  pi.net.websocket = hostWebSockets(pi.events);
  globalThis.pi = pi;
  const main = require("../../plugins/pi-desktop-bridge/main.js");
  let phone;
  try {
    await main.onLoad();
    const service = pi.services.registered.get("relay");
    assert.ok(service, "常驻服务 relay 已注册");
    assert.ok(pi.commands.registered.has("pi-remote-bridge.status"));
    service.start({ log: () => {} });
    await waitFor(() => relay.router.hasAgent());
    assert.equal(relay.router.agentDeviceId(), "pi-desktop:studio-mac");

    phone = new Phone(port);
    await phone.open();
    phone.ws.send(JSON.stringify({ version: 1, type: "hello", deviceId: "iphone", payload: { role: "ios" } }));
    const ack = await phone.wait((frame) => frame.type === "hello_ack");
    assert.equal(ack.payload.agentConnected, true);

    const list = await phone.request("l1", "session.list", { params: {} });
    assert.equal(list.payload.ok, true);
    assert.deepEqual(list.payload.data.sessions.map((session) => session.sessionId), ["terminal:desktop:s2", "terminal:desktop:s1"]);

    const view = await phone.request("g1", "session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "timeline", limit: 50 } });
    assert.equal(view.payload.ok, true);
    assert.equal(view.sessionId, "terminal:desktop:s1");
    assert.equal(view.payload.data.items[0].text, "帮我看看登录为什么失败");

    const sent = await phone.request("p1", "session.prompt", { sessionId: "terminal:desktop:s1", params: { message: "继续排查" } });
    assert.deepEqual(sent.payload, { ok: true, data: { sessionId: "terminal:desktop:s1", queued: true } });
    // 观察者发现会话进入运行，推送 agent_start（手机已因响应自动订阅该会话）
    const started = await phone.wait((frame) => frame.type === "session_event" && frame.payload.event.type === "agent_start");
    assert.equal(started.sessionId, "terminal:desktop:s1");

    // 宿主广播 turnEnded → 立即推送 agent_settled
    pi.store.status.s1 = { sessionId: "s1", isRunning: false, pendingToolConfirmations: 0 };
    pi.events.emit("session:turnEnded", { sessionId: "s1", turnId: "t-1", reason: "completed" });
    await phone.wait((frame) => frame.type === "session_event" && frame.payload.event.type === "agent_settled");

    const aborted = await phone.request("a1", "session.abort", { sessionId: "terminal:desktop:s1" });
    assert.equal(aborted.payload.ok, true);

    // 修改设置会按新配置重连；关闭开关后断开
    pi.setSettings({ enabled: false });
    pi.events.emit("plugin:settingsChanged", {});
    await waitFor(() => !relay.router.hasAgent());
    await pi.commands.registered.get("pi-remote-bridge.status").run();
    assert.match(pi.ui.toasts.at(-1).message, /已关闭/);
    pi.setSettings({ enabled: true });
    pi.events.emit("plugin:settingsChanged", {});
    await waitFor(() => relay.router.hasAgent());
  } finally {
    phone?.ws.close();
    await pi.services.registered.get("relay")?.stop();
    await main.onUnload();
    await relay.stop();
    delete globalThis.pi;
    await flush();
  }
});

test("错误的 AGENT_TOKEN 无法注册为 Agent", async () => {
  const relay = new RelayServer({
    config: { relayHost: "127.0.0.1", relayPort: 0, relayToken: RELAY_TOKEN, agentToken: AGENT_TOKEN, relayUrl: "ws://127.0.0.1/ws/agent", agentDeviceId: "x", piRuntime: "pi", piBin: "pi", piWorkspaceRoot: "/tmp", maxSessions: 4 },
    logger: () => {},
  });
  const { port } = await relay.start();
  const pi = createFakePi({ settings: { relayUrl: `ws://127.0.0.1:${port}`, agentToken: RELAY_TOKEN } });
  pi.net.websocket = hostWebSockets(pi.events);
  const { Bridge } = require("../../plugins/pi-desktop-bridge/lib/bridge.js");
  const bridge = new Bridge(pi, { logger: () => {} });
  try {
    bridge.start();
    await waitFor(() => bridge.status.state === "waiting");
    assert.match(bridge.status.message, /401|AGENT_TOKEN/);
    assert.equal(relay.router.hasAgent(), false);
  } finally {
    await bridge.stop();
    await relay.stop();
  }
});
