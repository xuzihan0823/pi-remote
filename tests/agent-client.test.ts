import assert from "node:assert/strict";
import test from "node:test";
import { AgentClient } from "../src/agent/agent-client.ts";
import type { RelayRequestFrame } from "../src/protocol/relay-types.ts";
import { FakeSocket, fakeWebSocketImpl, resetFakeSockets } from "./helpers/fake-socket.ts";
import {
  FrameQueue,
  TEST_TOKEN,
  helloFrame,
  openSocket,
  requestFrame,
  send,
  startTestServer,
} from "./helpers/relay-harness.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await delay(5);
  }
}

function createFakeClient(
  options: {
    token?: string;
    logger?: (message: string) => void;
    handshakeTimeoutMs?: number;
    heartbeatIntervalMs?: number;
  } = {},
): AgentClient {
  return new AgentClient({
    url: "ws://relay.test/ws/agent",
    token: options.token ?? "t".repeat(32),
    deviceId: "mac-1",
    WebSocketImpl: fakeWebSocketImpl,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 200,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 20,
    logger: options.logger ?? (() => {}),
  });
}

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

test("the heartbeat keeps a healthy socket alive against a real relay", async () => {
  const { server, port } = await startTestServer();
  const states: string[] = [];
  const agent = new AgentClient({
    url: `ws://127.0.0.1:${port}/ws/agent`,
    token: TEST_TOKEN,
    deviceId: "mac-1",
    logger: () => {},
    handshakeTimeoutMs: 1_000,
    heartbeatIntervalMs: 50,
  });

  try {
    agent.onStateChange((state) => states.push(state));
    await agent.connect();
    await delay(250);
    assert.equal(agent.state, "connected");
    assert.equal(states.includes("closed"), false);
  } finally {
    agent.disconnect();
    await server.stop();
  }
});

test("a late message from a replaced socket is ignored instead of answered on the new one", async () => {
  resetFakeSockets();
  const handled: RelayRequestFrame[] = [];
  const client = new AgentClient({
    url: "ws://relay.test/ws/agent",
    token: "t".repeat(32),
    deviceId: "mac-1",
    WebSocketImpl: fakeWebSocketImpl,
    handshakeTimeoutMs: 200,
    heartbeatIntervalMs: 5_000,
    handler: (request) => {
      handled.push(request);
      return { ok: true, data: {} };
    },
    logger: () => {},
  });

  await client.connect();
  const stale = FakeSocket.instances[0];
  assert.ok(stale);
  stale.serverClose();
  await waitFor(() => client.state === "closed");

  await client.connect();
  const live = FakeSocket.instances[1];
  assert.ok(live);
  assert.equal(live.sent.length, 1);

  stale.emit("message", JSON.stringify(requestFrame("stale-1", "session.list")));
  await delay(30);

  assert.equal(handled.length, 0);
  assert.equal(live.sent.length, 1);
  assert.equal(client.state, "connected");
});

test("a late open from a replaced socket leaves the new socket's handshake timeout armed", async () => {
  resetFakeSockets();
  const agent = createFakeClient({ handshakeTimeoutMs: 500 });

  await agent.connect();
  const stale = FakeSocket.instances[0];
  assert.ok(stale);
  stale.serverClose();
  await waitFor(() => agent.state === "closed");

  FakeSocket.silentConnect = true;
  const pending = agent.connect();
  const live = FakeSocket.instances[1];
  assert.ok(live);

  stale.emit("open");
  const outcome = await Promise.race([
    pending.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    delay(1_500).then(() => "hung"),
  ]);

  assert.match(outcome, /handshake timed out after 500ms/);
  assert.equal(live.terminated, true);
  assert.equal(FakeSocket.instances.length, 2);
});

test("a socket that never answers pings is terminated and reported as closed", async () => {
  resetFakeSockets();
  FakeSocket.autoPong = false;
  const agent = createFakeClient({ handshakeTimeoutMs: 5_000 });

  await agent.connect();
  assert.equal(agent.state, "connected");
  const socket = FakeSocket.instances[0];
  assert.ok(socket);

  await waitFor(() => agent.state === "closed");
  assert.equal(socket.pingCount >= 1, true);
  assert.equal(socket.terminated, true);
  assert.equal(socket.readyState, 3);
});

test("connect rejects and terminates the socket when the handshake never completes", async () => {
  resetFakeSockets();
  FakeSocket.silentConnect = true;
  const agent = createFakeClient({ handshakeTimeoutMs: 30 });

  await assert.rejects(agent.connect(), /handshake timed out after 30ms/);
  assert.equal(agent.state, "closed");
  assert.equal(FakeSocket.instances[0]?.terminated, true);

  FakeSocket.silentConnect = false;
  await agent.connect();
  assert.equal(agent.state, "connected");
  assert.equal(FakeSocket.instances.length, 2);
});

test("handshake timeout logs and errors never contain the token", async () => {
  resetFakeSockets();
  FakeSocket.silentConnect = true;
  const token = "agent-token-9f2c1d4a8b7e6f5c";
  const messages: string[] = [];
  const agent = createFakeClient({ token, handshakeTimeoutMs: 30, logger: (message) => messages.push(message) });

  const error = await agent.connect().catch((reason: unknown) => reason as Error);
  assert.ok(error instanceof Error);
  const transcript = [...messages, error.message].join("\n");
  assert.equal(transcript.includes(token), false);
  assert.equal(/token=/.test(transcript), false);
});

test("disconnect stops the heartbeat and force-closes a stalled socket", async () => {
  resetFakeSockets();
  const agent = createFakeClient();

  await agent.connect();
  const socket = FakeSocket.instances[0];
  assert.ok(socket);
  socket.gracefulCloseStalls = true;

  agent.disconnect();
  assert.equal(agent.state, "closed");
  const pingsAtDisconnect = socket.pingCount;

  await delay(80);
  assert.equal(socket.pingCount, pingsAtDisconnect);
  await waitFor(() => socket.terminated, 2_000);
});
