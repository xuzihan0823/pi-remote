import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import type { RelayFrame } from "../src/protocol/relay-types.ts";
import {
  FrameQueue,
  TEST_TOKEN,
  helloFrame,
  openSocket,
  requestFrame,
  send,
  startTestServer,
  waitForClose,
} from "./helpers/relay-harness.ts";

test("GET /api/health is public and reports relay state", async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.agentConnected, false);
    assert.equal(body.iosClients, 0);
  } finally {
    await server.stop();
  }
});

test("HTTP /api/status requires the bearer token", async () => {
  const { server, port } = await startTestServer();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await server.stop();
  }
});

test("WebSocket upgrades require the relay token", async () => {
  const { server, port } = await startTestServer();
  try {
    await assert.rejects(openSocket(port, "/ws/ios", "wrong-token"));
    await assert.rejects(openSocket(port, "/ws/ios", null));
    await assert.rejects(openSocket(port, "/ws/agent", "wrong-token"));
  } finally {
    await server.stop();
  }
});

test("a client must send hello before other frames", async () => {
  const { server, port } = await startTestServer();
  try {
    const ws = await openSocket(port, "/ws/ios");
    const queue = new FrameQueue(ws);

    send(ws, requestFrame("r1", "session.list"));
    const error = await queue.next();
    assert.equal(error.type, "error");
    assert.equal(error.payload.code, "hello_required");

    send(ws, helloFrame("iphone-1", "ios"));
    const ack = await queue.next();
    assert.equal(ack.type, "hello_ack");
    assert.equal(ack.payload.role, "ios");
    assert.equal(ack.deviceId, "iphone-1");
    ws.close();
  } finally {
    await server.stop();
  }
});

test("routes an iOS request through the agent and returns the response", async () => {
  const { server, port } = await startTestServer();
  try {
    const ios = await openSocket(port, "/ws/ios");
    const agent = await openSocket(port, "/ws/agent");
    const iosQueue = new FrameQueue(ios);
    const agentQueue = new FrameQueue(agent);

    send(ios, helloFrame("iphone-1", "ios"));
    assert.equal((await iosQueue.next()).type, "hello_ack");

    send(agent, helloFrame("mac-1", "agent"));
    const agentAck = await agentQueue.next();
    assert.equal(agentAck.type, "hello_ack");
    assert.equal(agentAck.payload.agentConnected, true);

    send(ios, requestFrame("r1", "session.list"));
    const forwarded = await agentQueue.next();
    assert.equal(forwarded.type, "request");
    assert.equal(forwarded.requestId, "r1");
    assert.equal(forwarded.deviceId, "iphone-1");

    send(agent, { version: 1, type: "response", requestId: "r1", payload: { ok: true, data: { sessions: [] } } });
    const response = await iosQueue.next();
    assert.equal(response.type, "response");
    assert.equal(response.requestId, "r1");
    assert.deepEqual(response.payload, { ok: true, data: { sessions: [] } });

    ios.close();
    agent.close();
  } finally {
    await server.stop();
  }
});

test("only one agent connection is allowed at a time", async () => {
  const { server, port } = await startTestServer();
  try {
    const first = await openSocket(port, "/ws/agent");
    const firstQueue = new FrameQueue(first);
    send(first, helloFrame("mac-1", "agent"));
    assert.equal((await firstQueue.next()).type, "hello_ack");

    const second = await openSocket(port, "/ws/agent");
    const secondQueue = new FrameQueue(second);
    send(second, helloFrame("mac-2", "agent"));
    const error = await secondQueue.next();
    assert.equal(error.type, "error");
    assert.equal(error.payload.code, "agent_already_connected");
    await waitForClose(second);

    first.close();
  } finally {
    await server.stop();
  }
});

test("malformed JSON is answered with a structured error instead of closing", async () => {
  const { server, port } = await startTestServer();
  try {
    const ws = await openSocket(port, "/ws/ios");
    const queue = new FrameQueue(ws);

    ws.send("this is not json");
    const error = await queue.next();
    assert.equal(error.type, "error");
    assert.equal(error.payload.code, "invalid_json");

    send(ws, helloFrame("iphone-1", "ios"));
    assert.equal((await queue.next()).type, "hello_ack");
    ws.close();
  } finally {
    await server.stop();
  }
});

test("agent disconnect fails in-flight iOS requests with agent_disconnected", async () => {
  const { server, port } = await startTestServer();
  try {
    const ios = await openSocket(port, "/ws/ios");
    const agent = await openSocket(port, "/ws/agent");
    const iosQueue = new FrameQueue(ios);
    const agentQueue = new FrameQueue(agent);

    send(ios, helloFrame("iphone-1", "ios"));
    await iosQueue.next();
    send(agent, helloFrame("mac-1", "agent"));
    await agentQueue.next();

    send(ios, requestFrame("r1", "session.prompt", { sessionId: "sess-1", params: { message: "hello" } }));
    await agentQueue.next();

    agent.close();
    const response = await iosQueue.next();
    assert.equal(response.type, "response");
    assert.equal(response.requestId, "r1");
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "agent_disconnected");

    ios.close();
  } finally {
    await server.stop();
  }
});

test("heartbeat keeps healthy clients connected", async () => {
  const { server, port } = await startTestServer({}, { heartbeatIntervalMs: 20 });
  try {
    const ws = await openSocket(port, "/ws/ios");
    const queue = new FrameQueue(ws);
    send(ws, helloFrame("iphone-1", "ios"));
    assert.equal((await queue.next()).type, "hello_ack");

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("unknown paths are rejected", async () => {
  const { server, port } = await startTestServer();
  try {
    await assert.rejects(openSocket(port, "/ws/nope"));
    const res = await fetch(`http://127.0.0.1:${port}/api/missing`);
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
});

test("frames are only forwarded to clients subscribed to the session", async () => {
  const { server, port } = await startTestServer();
  try {
    const subscribed = await openSocket(port, "/ws/ios");
    const idle = await openSocket(port, "/ws/ios");
    const agent = await openSocket(port, "/ws/agent");
    const subscribedQueue = new FrameQueue(subscribed);
    const idleQueue = new FrameQueue(idle);
    const agentQueue = new FrameQueue(agent);

    send(subscribed, helloFrame("iphone-1", "ios"));
    await subscribedQueue.next();
    send(idle, helloFrame("iphone-2", "ios"));
    await idleQueue.next();
    send(agent, helloFrame("mac-1", "agent"));
    await agentQueue.next();

    send(subscribed, requestFrame("s1", "subscribe", { sessionId: "sess-1" }));
    assert.equal((await subscribedQueue.next()).type, "response");

    send(agent, { version: 1, type: "session_event", sessionId: "sess-1", payload: { event: { type: "agent_start" } } });
    const event = await subscribedQueue.next();
    assert.equal(event.type, "session_event");
    assert.equal(event.sessionId, "sess-1");

    const idleFrames: RelayFrame[] = [];
    idle.on("message", (data) => idleFrames.push(JSON.parse(data.toString()) as RelayFrame));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(idleFrames.length, 0);

    subscribed.close();
    idle.close();
    agent.close();
  } finally {
    await server.stop();
  }
});
