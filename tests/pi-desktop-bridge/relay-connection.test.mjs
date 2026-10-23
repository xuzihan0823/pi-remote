import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createFakePi, createManualTimers, flush } from "./fake-host.mjs";

const require = createRequire(import.meta.url);
const { RelayConnection } = require("../../plugins/pi-desktop-bridge/lib/relay-connection.js");
const { Backoff } = require("../../plugins/pi-desktop-bridge/lib/backoff.js");
const { SessionWatcher } = require("../../plugins/pi-desktop-bridge/lib/watcher.js");

const CONFIG = { url: "wss://relay.example.com/ws/agent", token: "agent-secret-token", deviceId: "pi-desktop:test", label: "Test Mac", appVersion: "pi-desktop-bridge/0.1.0" };

function setup(options = {}) {
  const pi = createFakePi();
  const timers = createManualTimers();
  const statuses = [];
  const requests = [];
  const connection = new RelayConnection({
    pi,
    handler: options.handler ?? (async (request) => { requests.push(request); return { ok: true, data: { echo: request.payload.method } }; }),
    timers,
    now: timers.now,
    backoff: new Backoff({ baseMs: 1000, maxMs: 30_000, jitter: 0, random: () => 0.5 }),
    heartbeatMs: 25_000,
    onStatus: (status) => statuses.push(status.state),
  });
  return { pi, timers, connection, statuses, requests };
}

async function connectAndAck(context) {
  context.connection.start(CONFIG);
  await flush();
  const socketId = `ws-${context.pi.sockets.nextId - 1}`;
  context.pi.sockets.deliver(socketId, { version: 1, type: "hello_ack", deviceId: CONFIG.deviceId, payload: { role: "agent", protocolVersion: 1, agentConnected: true, iosClients: 1 } });
  await flush();
  return socketId;
}

test("连接：Token 只在 Authorization 头里，先发 hello，收到 hello_ack 才算连上", async () => {
  const context = setup();
  context.connection.start(CONFIG);
  await flush();
  const [connect] = context.pi.sockets.connects;
  assert.equal(connect.url, CONFIG.url);
  assert.ok(!connect.url.includes(CONFIG.token));
  assert.deepEqual(connect.headers, { Authorization: `Bearer ${CONFIG.token}` });
  const [hello] = context.pi.sockets.framesOf("hello");
  assert.deepEqual(hello, { version: 1, type: "hello", deviceId: CONFIG.deviceId, payload: { role: "agent", label: "Test Mac", appVersion: "pi-desktop-bridge/0.1.0" } });
  assert.equal(context.connection.connected, false);
  context.pi.sockets.deliver("ws-1", { version: 1, type: "hello_ack", deviceId: CONFIG.deviceId, payload: { role: "agent", protocolVersion: 1, agentConnected: true, iosClients: 0 } });
  await flush();
  assert.equal(context.connection.connected, true);
  assert.equal(context.statuses.at(-1), "connected");
  assert.equal(context.pi.events.count("net:websocket:message"), 1);
  await context.connection.stop();
  assert.equal(context.pi.events.count("net:websocket:message"), 0);
  assert.deepEqual(context.pi.sockets.closed.at(-1), { socketId: "ws-1", code: 1000, reason: "plugin stopped" });
});

test("请求 → handler → response（带回 requestId / sessionId）；协议 ping 回 pong", async () => {
  const context = setup();
  const socketId = await connectAndAck(context);
  context.pi.sockets.deliver(socketId, { version: 1, type: "request", requestId: "req-1", deviceId: "iphone", sessionId: "terminal:desktop:s1", payload: { method: "session.get", params: { viewVersion: 2 } } });
  await flush();
  assert.equal(context.requests.length, 1);
  const [response] = context.pi.sockets.framesOf("response");
  assert.deepEqual(response, { version: 1, type: "response", requestId: "req-1", deviceId: CONFIG.deviceId, sessionId: "terminal:desktop:s1", payload: { ok: true, data: { echo: "session.get" } } });

  context.pi.sockets.deliver(socketId, { version: 1, type: "ping", payload: {} });
  await flush();
  assert.equal(context.pi.sockets.framesOf("pong").length, 1);
  await context.connection.stop();
});

test("hello_ack 之前到达的请求不处理；handler 抛错变成 internal_error 响应", async () => {
  const context = setup({ handler: async () => { throw new Error("boom"); } });
  context.connection.start(CONFIG);
  await flush();
  context.pi.sockets.deliver("ws-1", { version: 1, type: "request", requestId: "early", payload: { method: "session.list" } });
  await flush();
  assert.equal(context.pi.sockets.framesOf("response").length, 0);
  context.pi.sockets.deliver("ws-1", { version: 1, type: "hello_ack", deviceId: CONFIG.deviceId, payload: { role: "agent" } });
  context.pi.sockets.deliver("ws-1", { version: 1, type: "request", requestId: "r2", payload: { method: "session.list" } });
  await flush();
  const [response] = context.pi.sockets.framesOf("response");
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error.code, "internal_error");
  await context.connection.stop();
});

test("超过 1 MiB 的响应被改写为 result_too_large，不会让宿主断开连接", async () => {
  const context = setup({ handler: async () => ({ ok: true, data: { blob: "x".repeat(2 * 1024 * 1024) } }) });
  const socketId = await connectAndAck(context);
  context.pi.sockets.deliver(socketId, { version: 1, type: "request", requestId: "big", payload: { method: "session.get" } });
  await flush();
  const entry = context.pi.sockets.sent.find((candidate) => candidate.frame.type === "response");
  assert.ok(entry.bytes < 1024 * 1024);
  assert.equal(entry.frame.requestId, "big");
  assert.equal(entry.frame.payload.error.code, "result_too_large");
  await context.connection.stop();
});

test("断线后按指数退避重连，连上后退避归零", async () => {
  const context = setup();
  const socketId = await connectAndAck(context);
  context.pi.sockets.drop(socketId, 1006, "");
  await flush();
  assert.equal(context.connection.connected, false);
  assert.equal(context.statuses.at(-1), "waiting");
  assert.equal(context.pi.sockets.connects.length, 1);
  await context.timers.advance(999);
  assert.equal(context.pi.sockets.connects.length, 1);
  await context.timers.advance(1);
  assert.equal(context.pi.sockets.connects.length, 2);

  // 第二次连接失败 → 2 秒后再试
  context.pi.sockets.drop("ws-2", 1006, "");
  await flush();
  await context.timers.advance(1999);
  assert.equal(context.pi.sockets.connects.length, 2);
  await context.timers.advance(1);
  assert.equal(context.pi.sockets.connects.length, 3);

  context.pi.sockets.deliver("ws-3", { version: 1, type: "hello_ack", deviceId: CONFIG.deviceId, payload: { role: "agent" } });
  await flush();
  assert.equal(context.connection.connected, true);
  assert.equal(context.connection.backoff.attempt, 0);
  // 旧 socket 的迟到事件被忽略
  context.pi.sockets.drop("ws-1", 1006, "");
  await flush();
  assert.equal(context.connection.connected, true);
  await context.connection.stop();
});

test("401 认证失败退到最长间隔；宿主拒绝出站（PERMISSION_DENIED）时停止重试", async () => {
  const context = setup();
  context.pi.sockets.failNext = Object.assign(new Error("Unexpected server response: 401"), { code: "CONNECT_FAILED" });
  context.connection.start(CONFIG);
  await flush();
  assert.equal(context.statuses.at(-1), "waiting");
  assert.match(context.connection.status.message, /AGENT_TOKEN/);
  assert.deepEqual(context.timers.pendingDelays(), [30_000]);
  await context.connection.stop();

  const denied = setup();
  denied.pi.sockets.failNext = Object.assign(new Error("host not allowed"), { code: "PERMISSION_DENIED" });
  denied.connection.start(CONFIG);
  await flush();
  assert.equal(denied.statuses.at(-1), "error");
  assert.match(denied.connection.status.message, /net\.anyHost/);
  assert.deepEqual(denied.timers.pendingDelays(), []);
});

test("同一 Relay 已有 Agent 时退避到上限", async () => {
  const context = setup();
  context.connection.start(CONFIG);
  await flush();
  context.pi.sockets.deliver("ws-1", { version: 1, type: "error", payload: { code: "agent_already_connected", message: "An agent is already connected" } });
  context.pi.sockets.drop("ws-1", 1008, "agent already connected");
  await flush();
  assert.match(context.connection.status.message, /已断开/);
  assert.deepEqual(context.timers.pendingDelays(), [30_000]);
  await context.connection.stop();
});

test("心跳：定期发 ping；两个周期没有任何帧就重连；hello 超时也重连", async () => {
  const context = setup();
  const socketId = await connectAndAck(context);
  await context.timers.advance(25_000);
  assert.equal(context.pi.sockets.framesOf("ping").length, 1);
  context.pi.sockets.deliver(socketId, { version: 1, type: "pong", payload: {} });
  await flush();
  await context.timers.advance(25_000);
  assert.equal(context.connection.connected, true);
  await context.timers.advance(50_000);
  assert.equal(context.connection.connected, false);
  assert.ok(context.pi.sockets.closed.some((entry) => entry.socketId === socketId));
  await context.connection.stop();

  const silent = setup();
  silent.connection.start(CONFIG);
  await flush();
  await silent.timers.advance(10_000);
  assert.equal(silent.statuses.at(-1), "waiting");
  assert.match(silent.connection.status.message, /hello/);
  await silent.connection.stop();
});

test("在 connect() 返回前送达的帧会被暂存并补处理", async () => {
  const context = setup();
  const original = context.pi.sockets.connect;
  context.pi.sockets.connect = async (input) => {
    const result = await original(input);
    context.pi.sockets.deliver(result.socketId, { version: 1, type: "ping", payload: {} });
    return result;
  };
  context.connection.start(CONFIG);
  await flush();
  assert.equal(context.pi.sockets.framesOf("pong").length, 1);
  await context.connection.stop();
});

test("会话事件只在连上时发送", async () => {
  const context = setup();
  assert.equal(await context.connection.sendSessionEvent("terminal:desktop:s1", { type: "agent_settled" }), false);
  await connectAndAck(context);
  assert.equal(await context.connection.sendSessionEvent("terminal:desktop:s1", { type: "agent_settled", sessionId: "terminal:desktop:s1" }), true);
  const [event] = context.pi.sockets.framesOf("session_event");
  assert.deepEqual(event, { version: 1, type: "session_event", deviceId: CONFIG.deviceId, sessionId: "terminal:desktop:s1", payload: { event: { type: "agent_settled", sessionId: "terminal:desktop:s1" } } });
  await context.connection.stop();
});

test("会话观察者：运行中约 1 秒轮询，忙闲变化转成 agent_start / agent_settled，待处理事项发提示", async () => {
  const timers = createManualTimers();
  const statuses = { s1: { isRunning: false, pendingToolConfirmations: 0 } };
  const reads = [];
  const events = [];
  const watcher = new SessionWatcher({
    readStatus: async (id) => { reads.push(timers.now()); return statuses[id]; },
    emit: (id, event) => events.push({ id, ...event }),
    timers,
    now: timers.now,
    busyMs: 1000,
    idleMs: 5000,
    ttlMs: 60_000,
  });
  watcher.track("s1");
  await timers.advance(0);
  assert.deepEqual(events, []);
  statuses.s1 = { isRunning: true, pendingToolConfirmations: 0 };
  watcher.track("s1", { poke: true });
  await timers.advance(0);
  assert.deepEqual(events.map((event) => event.type), ["agent_start"]);
  const before = reads.length;
  await timers.advance(3000);
  assert.equal(reads.length - before, 3, "运行中每秒一次");

  statuses.s1 = { isRunning: true, pendingToolConfirmations: 1 };
  await timers.advance(1000);
  assert.equal(events.at(-1).type, "notice");
  assert.match(events.at(-1).text, /1 个工具权限请求.*Mac/);
  await timers.advance(1000);
  assert.equal(events.filter((event) => event.type === "notice").length, 1, "同一待处理状态只提示一次");

  // 宿主的 turnEnded 先到：立即 agent_settled，同一 turn 不重复
  statuses.s1 = { isRunning: false, pendingToolConfirmations: 0 };
  watcher.onTurnEnded({ sessionId: "s1", turnId: "t1", reason: "completed" });
  watcher.onTurnEnded({ sessionId: "s1", turnId: "t1", reason: "completed" });
  await timers.advance(1000);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);

  const idleBefore = reads.length;
  await timers.advance(10_000);
  assert.equal(reads.length - idleBefore, 2, "空闲时 5 秒一次");
  // 超过 ttl 未被手机触碰，停止观察
  await timers.advance(60_000);
  assert.equal(watcher.isTracked("s1"), false);
  watcher.stop();
});
