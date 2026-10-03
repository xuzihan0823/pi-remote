import assert from "node:assert/strict";
import test from "node:test";
import { AgentClient } from "../src/agent/agent-client.ts";
import { AgentRuntime, computeBackoffDelay } from "../src/agent/run.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import { createFakeChild } from "./helpers/fake-child.ts";
import { FakeSocket, fakeWebSocketImpl, resetFakeSockets } from "./helpers/fake-socket.ts";
import { TEST_TOKEN, startTestServer } from "./helpers/relay-harness.ts";
import { startStallingProxy } from "./helpers/stalling-proxy.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await delay(5);
  }
}

function createRuntime(): { runtime: AgentRuntime; client: AgentClient; manager: PiProcessManager; fake: ReturnType<typeof createFakeChild> } {
  const fake = createFakeChild();
  const manager = new PiProcessManager({
    piBin: "pi",
    maxSessions: 1,
    startupDelayMs: 0,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 50,
    spawnFn: fake.spawn,
  });
  const client = new AgentClient({
    url: "ws://relay.test/ws/agent",
    token: "t".repeat(32),
    deviceId: "mac-1",
    WebSocketImpl: fakeWebSocketImpl,
    handshakeTimeoutMs: 50,
    heartbeatIntervalMs: 20,
    logger: () => {},
  });
  const runtime = new AgentRuntime({
    client,
    manager,
    logger: () => {},
    reconnectBaseDelayMs: 2,
    reconnectMaxDelayMs: 8,
  });
  return { runtime, client, manager, fake };
}

test("a relay link that stalls without closing is terminated and reconnected", async () => {
  const { server, port } = await startTestServer();
  const proxy = await startStallingProxy(port);
  const fake = createFakeChild();
  const manager = new PiProcessManager({
    piBin: "pi",
    maxSessions: 1,
    startupDelayMs: 0,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 50,
    spawnFn: fake.spawn,
  });
  const client = new AgentClient({
    url: `ws://127.0.0.1:${proxy.port}/ws/agent`,
    token: TEST_TOKEN,
    deviceId: "mac-1",
    handshakeTimeoutMs: 2_000,
    heartbeatIntervalMs: 150,
    logger: () => {},
  });
  const runtime = new AgentRuntime({ client, manager, logger: () => {}, reconnectBaseDelayMs: 50, reconnectMaxDelayMs: 50 });

  let droppedWhileStalled = false;
  const unsubscribe = client.onStateChange((state) => {
    if (state !== "closed" || droppedWhileStalled) return;
    droppedWhileStalled = true;
    proxy.resume();
  });

  try {
    await runtime.start();
    assert.equal(client.state, "connected");

    proxy.stall();
    await waitFor(() => droppedWhileStalled, 5_000);
    await waitFor(() => client.state === "connected", 5_000);
    assert.equal(proxy.connectionCount >= 2, true);
  } finally {
    unsubscribe();
    await runtime.stop();
    await manager.closeAll();
    await proxy.close();
    await server.stop();
  }
});

test("computeBackoffDelay grows exponentially and respects the cap", () => {
  assert.equal(computeBackoffDelay(0, 100, 5_000), 100);
  assert.equal(computeBackoffDelay(1, 100, 5_000), 200);
  assert.equal(computeBackoffDelay(3, 100, 5_000), 800);
  assert.equal(computeBackoffDelay(6, 100, 5_000), 5_000);
  assert.equal(computeBackoffDelay(-2, 100, 5_000), 100);
});

test("AgentRuntime sends an agent hello and reconnects after the socket drops", async () => {
  resetFakeSockets();
  const { runtime, client, manager } = createRuntime();

  try {
    await runtime.start();
    assert.equal(client.state, "connected");
    assert.equal(FakeSocket.instances.length, 1);

    const hello = JSON.parse(FakeSocket.instances[0]?.sent[0] ?? "{}") as {
      type?: string;
      payload?: { role?: string };
    };
    assert.equal(hello.type, "hello");
    assert.equal(hello.payload?.role, "agent");

    FakeSocket.instances[0]?.serverClose();
    await waitFor(() => FakeSocket.instances.length >= 2 && client.state === "connected");
    assert.equal(FakeSocket.instances[1]?.url.includes("token="), true);
  } finally {
    await runtime.stop();
    await manager.closeAll();
  }

  assert.equal(client.state, "closed");
  const afterStop = FakeSocket.instances.length;
  await delay(40);
  assert.equal(FakeSocket.instances.length, afterStop);
});

test("AgentRuntime keeps retrying while the connection cannot open", async () => {
  resetFakeSockets();
  FakeSocket.autoOpen = false;
  const { runtime, client, manager } = createRuntime();

  try {
    await runtime.start();
    assert.equal(client.state, "closed");
    assert.equal(runtime.isRunning, true);

    await waitFor(() => FakeSocket.instances.length >= 3);
    assert.equal(client.state, "closed");

    FakeSocket.autoOpen = true;
    await waitFor(() => client.state === "connected");
  } finally {
    FakeSocket.autoOpen = true;
    await runtime.stop();
    await manager.closeAll();
  }
});

test("AgentRuntime reconnects after a socket goes silent without a close event", async () => {
  resetFakeSockets();
  FakeSocket.autoPong = false;
  const { runtime, client, manager } = createRuntime();

  try {
    await runtime.start();
    assert.equal(client.state, "connected");
    const silent = FakeSocket.instances[0];
    assert.ok(silent);

    await waitFor(() => silent.terminated && FakeSocket.instances.length >= 2 && client.state === "connected");
    assert.equal(FakeSocket.instances[0]?.terminated, true);
    assert.equal(client.state, "connected");
  } finally {
    await runtime.stop();
    await manager.closeAll();
  }

  assert.equal(client.state, "closed");
  const afterStop = FakeSocket.instances.length;
  await delay(40);
  assert.equal(FakeSocket.instances.length, afterStop);
});

test("a late close from a replaced socket does not disturb the live connection", async () => {
  resetFakeSockets();
  const { runtime, client, manager } = createRuntime();

  try {
    await runtime.start();
    const first = FakeSocket.instances[0];
    assert.ok(first);

    first.serverClose();
    await waitFor(() => FakeSocket.instances.length >= 2 && client.state === "connected");
    const second = FakeSocket.instances[1];
    assert.ok(second);

    first.emit("close", 1006, Buffer.from(""));
    await delay(40);
    assert.equal(client.state, "connected");
    assert.equal(FakeSocket.instances.length, 2);

    client.send({ version: 1, type: "pong", payload: {} });
    assert.equal(second.sent.length, 2);
  } finally {
    await runtime.stop();
    await manager.closeAll();
  }
});
