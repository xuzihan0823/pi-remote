import assert from "node:assert/strict";
import test from "node:test";
import { AgentClient } from "../src/agent/agent-client.ts";
import type { RelayRequestFrame } from "../src/protocol/relay-types.ts";
import {
  FrameQueue,
  TEST_TOKEN,
  helloFrame,
  openSocket,
  requestFrame,
  send,
  startTestServer,
} from "./helpers/relay-harness.ts";

test("AgentClient connects, handles a routed request, and responds", async () => {
  const { server, port } = await startTestServer();
  const requests: RelayRequestFrame[] = [];
  const agent = new AgentClient({
    url: `ws://127.0.0.1:${port}/ws/agent`,
    token: TEST_TOKEN,
    deviceId: "mac-1",
    handler: (request) => {
      requests.push(request);
      return { ok: true, data: { handled: request.payload.method } };
    },
    logger: () => {},
  });

  try {
    await agent.connect();
    assert.equal(agent.state, "connected");

    const ios = await openSocket(port, "/ws/ios");
    const iosQueue = new FrameQueue(ios);
    send(ios, helloFrame("iphone-1", "ios"));
    await iosQueue.next();

    send(ios, requestFrame("r1", "session.list"));
    const response = await iosQueue.next();
    assert.equal(response.type, "response");
    assert.equal(response.requestId, "r1");
    assert.deepEqual(response.payload, { ok: true, data: { handled: "session.list" } });
    assert.equal(requests.length, 1);
    ios.close();
  } finally {
    agent.disconnect();
    await server.stop();
  }
});

test("AgentClient without a handler answers with not_implemented", async () => {
  const { server, port } = await startTestServer();
  const agent = new AgentClient({
    url: `ws://127.0.0.1:${port}/ws/agent`,
    token: TEST_TOKEN,
    deviceId: "mac-1",
    logger: () => {},
  });

  try {
    await agent.connect();
    const ios = await openSocket(port, "/ws/ios");
    const iosQueue = new FrameQueue(ios);
    send(ios, helloFrame("iphone-1", "ios"));
    await iosQueue.next();

    send(ios, requestFrame("r1", "session.list"));
    const response = await iosQueue.next();
    assert.equal(response.type, "response");
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "not_implemented");
    ios.close();
  } finally {
    agent.disconnect();
    await server.stop();
  }
});

test("a throwing handler becomes an internal_error response", async () => {
  const { server, port } = await startTestServer();
  const agent = new AgentClient({
    url: `ws://127.0.0.1:${port}/ws/agent`,
    token: TEST_TOKEN,
    deviceId: "mac-1",
    handler: () => {
      throw new Error("boom");
    },
    logger: () => {},
  });

  try {
    await agent.connect();
    const ios = await openSocket(port, "/ws/ios");
    const iosQueue = new FrameQueue(ios);
    send(ios, helloFrame("iphone-1", "ios"));
    await iosQueue.next();

    send(ios, requestFrame("r1", "session.list"));
    const response = await iosQueue.next();
    assert.equal(response.type, "response");
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "internal_error");
    assert.match(response.payload.error?.message ?? "", /boom/);
    ios.close();
  } finally {
    agent.disconnect();
    await server.stop();
  }
});

test("AgentClient forwards session events to subscribed iOS clients only", async () => {
  const { server, port } = await startTestServer();
  const agent = new AgentClient({
    url: `ws://127.0.0.1:${port}/ws/agent`,
    token: TEST_TOKEN,
    deviceId: "mac-1",
    handler: () => ({ ok: true, data: {} }),
    logger: () => {},
  });

  try {
    await agent.connect();

    const ios = await openSocket(port, "/ws/ios");
    const iosQueue = new FrameQueue(ios);
    send(ios, helloFrame("iphone-1", "ios"));
    await iosQueue.next();
    send(ios, requestFrame("s1", "subscribe", { sessionId: "sess-1" }));
    await iosQueue.next();

    agent.sendSessionEvent("sess-1", { type: "text_delta", text: "hello" });
    const event = await iosQueue.next();
    assert.equal(event.type, "session_event");
    assert.equal(event.sessionId, "sess-1");
    assert.deepEqual(event.payload, { event: { type: "text_delta", text: "hello" } });
    ios.close();
  } finally {
    agent.disconnect();
    await server.stop();
  }
});
