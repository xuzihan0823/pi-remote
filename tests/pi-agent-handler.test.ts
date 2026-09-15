import assert from "node:assert/strict";
import test from "node:test";
import { AgentClient } from "../src/agent/agent-client.ts";
import { createPiAgentHandler } from "../src/agent/pi-agent-handler.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import type { GatewayEvent } from "../src/protocol/types.ts";
import { createFakeChild, flush, type FakeChild } from "./helpers/fake-child.ts";
import {
  FrameQueue,
  TEST_TOKEN,
  helloFrame,
  openSocket,
  requestFrame,
  send,
  startTestServer,
} from "./helpers/relay-harness.ts";

const WORKSPACE = "/tmp/pi-agent-workspace";

interface Harness {
  fake: FakeChild;
  manager: PiProcessManager;
  handler: ReturnType<typeof createPiAgentHandler>;
  events: { sessionId: string; event: GatewayEvent }[];
}

function createHarness(workspaceRoot = WORKSPACE): Harness {
  const fake = createFakeChild();
  const manager = new PiProcessManager({
    piBin: "pi",
    maxSessions: 4,
    startupDelayMs: 0,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 50,
    spawnFn: fake.spawn,
  });
  const events: Harness["events"] = [];
  const handler = createPiAgentHandler({
    manager,
    workspaceRoot,
    emitSessionEvent: (sessionId, event) => events.push({ sessionId, event }),
    logger: () => {},
  });
  return { fake, manager, handler, events };
}

const respond = (id: string, command: string): string =>
  `${JSON.stringify({ id, type: "response", command, success: true })}\n`;

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("session.list reports the current process state", async () => {
  const { manager, handler } = createHarness();
  try {
    assert.deepEqual(await handler(requestFrame("r1", "session.list")), { ok: true, data: { sessions: [] } });

    await handler(requestFrame("r2", "session.start", { params: { sessionId: "s1" } }));
    const listed = await handler(requestFrame("r3", "session.list"));
    const sessions = (listed.data as { sessions: { sessionId: string; state: string }[] }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "s1");
    assert.equal(sessions[0]?.state, "running");
  } finally {
    await manager.closeAll();
  }
});

test("session.start uses the explicit sessionId and resolves cwd inside the workspace", async () => {
  const { fake, manager, handler } = createHarness();
  try {
    const result = await handler(
      requestFrame("r1", "session.start", { params: { sessionId: "s1", cwd: "sub/dir" } }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual((result.data as { sessionId: string }).sessionId, "s1");
    assert.deepEqual(fake.spawnedArgs, [["pi", "--mode", "rpc"]]);
    assert.equal(fake.spawnedOptions[0]?.cwd, `${WORKSPACE}/sub/dir`);

    const absolute = await handler(
      requestFrame("r2", "session.start", { params: { sessionId: "s2", cwd: `${WORKSPACE}/inside` } }),
    );
    assert.equal(absolute.ok, true);
    assert.equal(fake.spawnedOptions[1]?.cwd, `${WORKSPACE}/inside`);
  } finally {
    await manager.closeAll();
  }
});

test("session.start generates a random UUID when sessionId is missing", async () => {
  const { fake, manager, handler } = createHarness();
  try {
    const result = await handler(requestFrame("r1", "session.start"));
    assert.equal(result.ok, true);
    const sessionId = (result.data as { sessionId: string }).sessionId;
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(fake.spawnedOptions[0]?.cwd, WORKSPACE);
  } finally {
    await manager.closeAll();
  }
});

test("session.start rejects cwd escapes without spawning a process", async () => {
  const { fake, manager, handler } = createHarness();
  try {
    const escapes = ["..", "../outside", "sub/../../..", "/etc", `${WORKSPACE}/../other`];
    for (const [index, cwd] of escapes.entries()) {
      const result = await handler(requestFrame(`r${index}`, "session.start", { params: { cwd } }));
      assert.equal(result.ok, false, `expected ${cwd} to be rejected`);
      assert.equal(result.error?.code, "invalid_frame", `cwd ${cwd}`);
    }
    assert.equal(fake.spawnedArgs.length, 0);
  } finally {
    await manager.closeAll();
  }
});

test("session.start maps a duplicate running session to session_busy", async () => {
  const { manager, handler } = createHarness();
  try {
    await handler(requestFrame("r1", "session.start", { params: { sessionId: "s1" } }));
    const duplicate = await handler(requestFrame("r2", "session.start", { params: { sessionId: "s1" } }));
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error?.code, "session_busy");
  } finally {
    await manager.closeAll();
  }
});

test("session.prompt validates params and only acknowledges the queued message", async () => {
  const { fake, manager, handler } = createHarness();
  try {
    await handler(requestFrame("r0", "session.start", { params: { sessionId: "s1" } }));

    const missingSession = await handler(requestFrame("r1", "session.prompt", { params: { message: "hi" } }));
    assert.equal(missingSession.ok, false);
    assert.equal(missingSession.error?.code, "invalid_frame");

    const missingMessage = await handler(requestFrame("r2", "session.prompt", { sessionId: "s1", params: {} }));
    assert.equal(missingMessage.ok, false);
    assert.equal(missingMessage.error?.code, "invalid_frame");

    const pending = handler(requestFrame("r3", "session.prompt", { sessionId: "s1", params: { message: "hello" } }));
    const written = fake.lastWrittenLine();
    assert.equal(written.type, "prompt");
    assert.equal(written.message, "hello");
    fake.pushStdout(respond(written.id as string, "prompt"));

    assert.deepEqual(await pending, { ok: true, data: { sessionId: "s1", queued: true } });
  } finally {
    await manager.closeAll();
  }
});

test("manager gateway events are forwarded with their sessionId", async () => {
  const { fake, manager, handler, events } = createHarness();
  try {
    await handler(requestFrame("r1", "session.start", { params: { sessionId: "s1" } }));

    fake.pushStdout(`${JSON.stringify({ type: "agent_start" })}\n`);
    await flush();
    assert.deepEqual(events, [{ sessionId: "s1", event: { type: "agent_start", sessionId: "s1" } }]);

    fake.exit(0);
    await flush();
    assert.ok(events.some(({ event }) => event.type === "process_exit"));
  } finally {
    await manager.closeAll();
  }
});

test("session.abort validates the session and forwards the abort command", async () => {
  const { fake, manager, handler } = createHarness();
  try {
    await handler(requestFrame("r0", "session.start", { params: { sessionId: "s1" } }));

    const missing = await handler(requestFrame("r1", "session.abort", {}));
    assert.equal(missing.error?.code, "invalid_frame");

    const unknown = await handler(requestFrame("r2", "session.abort", { sessionId: "missing" }));
    assert.equal(unknown.error?.code, "unknown_session");

    const pending = handler(requestFrame("r3", "session.abort", { sessionId: "s1" }));
    const written = fake.lastWrittenLine();
    assert.equal(written.type, "abort");
    fake.pushStdout(respond(written.id as string, "abort"));

    assert.deepEqual(await pending, { ok: true, data: { sessionId: "s1", aborted: true } });
  } finally {
    await manager.closeAll();
  }
});

test("ui.response becomes an extension_ui_response for the matching pi process", async () => {
  const { fake, manager, handler } = createHarness();
  try {
    await handler(requestFrame("r0", "session.start", { params: { sessionId: "s1" } }));

    const missingRequestId = await handler(requestFrame("r1", "ui.response", { sessionId: "s1", params: {} }));
    assert.equal(missingRequestId.error?.code, "invalid_frame");

    const unknown = await handler(requestFrame("r2", "ui.response", { sessionId: "nope", params: { requestId: "ui-1" } }));
    assert.equal(unknown.error?.code, "unknown_session");

    const result = await handler(
      requestFrame("r3", "ui.response", { sessionId: "s1", params: { requestId: "ui-1", response: { confirmed: true } } }),
    );
    assert.deepEqual(result, { ok: true, data: { sessionId: "s1", requestId: "ui-1" } });
    assert.deepEqual(fake.lastWrittenLine(), { type: "extension_ui_response", id: "ui-1", confirmed: true });
  } finally {
    await manager.closeAll();
  }
});

test("methods the agent does not implement are reported as not_implemented", async () => {
  const { manager, handler } = createHarness();
  try {
    const result = await handler(requestFrame("r1", "subscribe"));
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "not_implemented");
  } finally {
    await manager.closeAll();
  }
});

test("a real AgentClient + relay + PiProcessManager handler streams session events", async () => {
  const { server, port } = await startTestServer();
  const fake = createFakeChild();
  const manager = new PiProcessManager({
    piBin: "pi",
    maxSessions: 2,
    startupDelayMs: 0,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 50,
    spawnFn: fake.spawn,
  });
  let client: AgentClient | undefined;
  const handler = createPiAgentHandler({
    manager,
    workspaceRoot: WORKSPACE,
    emitSessionEvent: (sessionId, event) => client?.sendSessionEvent(sessionId, event),
    logger: () => {},
  });
  client = new AgentClient({
    url: `ws://127.0.0.1:${port}/ws/agent`,
    token: TEST_TOKEN,
    deviceId: "mac-1",
    handler,
    logger: () => {},
  });
  const ios = await openSocket(port, "/ws/ios");

  try {
    await client.connect();
    const queue = new FrameQueue(ios);
    send(ios, helloFrame("iphone-1", "ios"));
    await queue.next();

    send(ios, requestFrame("r1", "session.start", { params: { sessionId: "s1", cwd: "proj" } }));
    const started = await queue.next();
    assert.equal(started.type, "response");
    assert.equal(started.payload.ok, true);
    assert.equal(started.sessionId, "s1");
    assert.equal(fake.spawnedOptions[0]?.cwd, `${WORKSPACE}/proj`);

    send(ios, requestFrame("r2", "session.prompt", { sessionId: "s1", params: { message: "hi" } }));
    await waitFor(() => fake.writtenLines().some((line) => line.type === "prompt"));
    const prompt = fake.writtenLines().find((line) => line.type === "prompt");
    fake.pushStdout(respond(prompt?.id as string, "prompt"));

    const queued = await queue.next();
    assert.equal(queued.type, "response");
    assert.equal(queued.payload.ok, true);
    assert.deepEqual(queued.payload.data, { sessionId: "s1", queued: true });

    fake.pushStdout(`${JSON.stringify({ type: "agent_start" })}\n`);
    const event = await queue.next();
    assert.equal(event.type, "session_event");
    assert.equal(event.sessionId, "s1");
    assert.deepEqual(event.payload.event, { type: "agent_start", sessionId: "s1" });
  } finally {
    client.disconnect();
    ios.close();
    await manager.closeAll();
    await server.stop();
  }
});
