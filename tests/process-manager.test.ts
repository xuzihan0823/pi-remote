import assert from "node:assert/strict";
import test from "node:test";
import {
  PiProcessManager,
  SessionAlreadyRunningError,
  SessionBusyError,
  SessionNotFoundError,
} from "../src/pi/process-manager.ts";
import type { GatewayEvent } from "../src/protocol/types.ts";
import { createFakeChild, flush, type FakeChild } from "./helpers/fake-child.ts";

function createManager(fake: FakeChild, maxSessions = 2): PiProcessManager {
  return new PiProcessManager({
    piBin: "pi",
    maxSessions,
    startupDelayMs: 0,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 50,
    spawnFn: fake.spawn,
  });
}

const respond = (id: string, command: string): string =>
  `${JSON.stringify({ id, type: "response", command, success: true })}\n`;

test("start spawns one controlled pi RPC process per session", async () => {
  const fake = createFakeChild();
  const manager = createManager(fake);

  const status = await manager.start("s1", { args: ["--no-session"] });

  assert.deepEqual(fake.spawnedArgs, [["pi", "--mode", "rpc", "--no-session"]]);
  assert.equal(status.state, "running");
  assert.equal(status.pid, 4242);
  assert.equal(manager.get("s1")?.sessionId, "s1");
  assert.equal(manager.list().length, 1);

  await manager.closeAll();
});

test("starting the same session twice is rejected and does not spawn a second process", async () => {
  const fake = createFakeChild();
  const manager = createManager(fake);
  await manager.start("s1");

  await assert.rejects(manager.start("s1"), SessionAlreadyRunningError);
  assert.equal(fake.spawnedArgs.length, 1);

  await manager.closeAll();
});

test("unknown sessions are rejected for send and abort", async () => {
  const fake = createFakeChild();
  const manager = createManager(fake);

  await assert.rejects(manager.send("missing", { type: "get_state" }), SessionNotFoundError);
  await assert.rejects(manager.abort("missing"), SessionNotFoundError);
  await manager.close("missing");
});

test("an abnormal process exit is observable through status, events, and later commands", async () => {
  const fake = createFakeChild();
  const manager = createManager(fake);
  const events: GatewayEvent[] = [];
  const statuses: string[] = [];
  manager.onEvent((event) => events.push(event));
  manager.onStatusChange((status) => statuses.push(status.state));

  await manager.start("s1");
  fake.exit(1);
  await flush();

  const status = manager.getStatus("s1");
  assert.equal(status?.state, "failed");
  assert.match(status?.error ?? "", /exited/);
  assert.ok(events.some((event) => event.type === "process_exit"));
  assert.ok(statuses.includes("failed"));
  await assert.rejects(manager.send("s1", { type: "get_state" }), /not running/);

  await manager.closeAll();
});

test("a second prompt is rejected while the session is streaming", async () => {
  const fake = createFakeChild();
  const manager = createManager(fake);
  await manager.start("s1");

  const first = manager.prompt("s1", "hello");
  const request = fake.lastWrittenLine();
  assert.equal(request.type, "prompt");
  assert.equal(request.message, "hello");

  await assert.rejects(manager.prompt("s1", "again"), SessionBusyError);

  fake.pushStdout(respond(request.id as string, "prompt"));
  await first;
  assert.equal(manager.isBusy("s1"), true);

  fake.pushStdout(`${JSON.stringify({ type: "agent_settled" })}\n`);
  await flush();
  assert.equal(manager.isBusy("s1"), false);

  await manager.closeAll();
});

test("close removes the session and terminates its process", async () => {
  const fake = createFakeChild();
  const manager = createManager(fake);
  await manager.start("s1");

  await manager.close("s1");

  assert.equal(manager.get("s1"), undefined);
  assert.equal(manager.getStatus("s1"), undefined);
  assert.deepEqual(fake.killedWith, ["SIGTERM"]);
});

test("maxSessions bounds how many child processes can run", async () => {
  const fake = createFakeChild();
  const manager = createManager(fake, 1);
  await manager.start("s1");

  await assert.rejects(manager.start("s2"), /max sessions/);
  await manager.closeAll();
});
