import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { AgentClient } from "../src/agent/agent-client.ts";
import { AgentRuntime, computeBackoffDelay } from "../src/agent/run.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import { createFakeChild } from "./helpers/fake-child.ts";

type Listener = (...args: unknown[]) => void;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await delay(5);
  }
}

class FakeSocket {
  static readonly instances: FakeSocket[] = [];
  static autoOpen = true;

  readyState = 0;
  readonly url: string;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
    setImmediate(() => {
      if (FakeSocket.autoOpen) this.open();
      else {
        this.emit("error", new Error("connection refused"));
        this.serverClose();
      }
    });
  }

  on(event: string, listener: Listener): this {
    const set = this.#listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args);
  }

  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit("open");
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.serverClose(1000);
  }

  serverClose(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(""));
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
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
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

test("computeBackoffDelay grows exponentially and respects the cap", () => {
  assert.equal(computeBackoffDelay(0, 100, 5_000), 100);
  assert.equal(computeBackoffDelay(1, 100, 5_000), 200);
  assert.equal(computeBackoffDelay(3, 100, 5_000), 800);
  assert.equal(computeBackoffDelay(6, 100, 5_000), 5_000);
  assert.equal(computeBackoffDelay(-2, 100, 5_000), 100);
});

test("AgentRuntime sends an agent hello and reconnects after the socket drops", async () => {
  FakeSocket.instances.length = 0;
  FakeSocket.autoOpen = true;
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
  FakeSocket.instances.length = 0;
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
