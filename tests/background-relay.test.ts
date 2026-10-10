import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { AgentClient } from "../src/agent/agent-client.ts";
import { createPiAgentHandler } from "../src/agent/pi-agent-handler.ts";
import { BackgroundHost } from "../src/background/host.ts";
import { backgroundEnvironment } from "../src/background/environment.ts";
import { OmpHistoryIndex } from "../src/history/history-index.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import type { RelayRequestMethod } from "../src/protocol/relay-types.ts";
import { TerminalSessionBridge } from "../src/terminal/bridge-client.ts";
import { HistoryRecoveryCoordinator } from "../src/terminal/history-recovery.ts";
import { TerminalSessionLauncher } from "../src/terminal/launcher.ts";
import { backgroundFixture } from "./helpers/background-fixture.ts";
import { helloFrame, openSocket, requestFrame, send, startTestServer, TEST_TOKEN } from "./helpers/relay-harness.ts";

class Phone {
  readonly events: Record<string, any>[] = [];
  readonly changed = new EventEmitter();
  readonly pending = new Map<string, { resolve: (data: Record<string, any>) => void; reject: (error: Error) => void }>();
  readonly socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "response") {
        const pending = this.pending.get(frame.requestId);
        if (frame.payload.ok) pending?.resolve(frame.payload.data);
        else pending?.reject(new Error(`${frame.payload.error?.code}: ${frame.payload.error?.message}`));
      }
      if (frame.type === "session_event") { this.events.push(frame.payload.event); this.changed.emit("event"); }
    });
    send(socket, helloFrame(randomUUID(), "ios"));
  }
  async request(method: RelayRequestMethod, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = randomUUID();
    const gate = Promise.withResolvers<Record<string, any>>();
    this.pending.set(id, gate);
    const timer = setTimeout(() => gate.reject(new Error(`${method} response unknown; never replay`)), 45_000);
    send(this.socket, requestFrame(id, method, { params, sessionId }));
    try { return await gate.promise; }
    finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async event(predicate: (event: Record<string, any>) => boolean, after = 0, timeout = 60_000) {
    const gate = Promise.withResolvers<Record<string, any>>();
    const check = () => { const found = this.events.slice(after).find(predicate); if (found) gate.resolve(found); };
    this.changed.on("event", check);
    const timer = setTimeout(() => gate.reject(new Error(`expected real OMP event was not delivered: ${predicate}; received ${this.events.slice(after).map(event => `${event.type}:${event.method ?? ""}`).join(",")}`)), timeout);
    check();
    try { return await gate.promise; }
    finally { clearTimeout(timer); this.changed.off("event", check); }
  }
  close() { this.socket.close(); }
}

test("real Relay restores without Terminal, replays pending UI only, refuses stale approval and persists confirmed work in the original history", { skip: process.env.PI_STRICT_RUNTIME !== "1", timeout: 240_000 }, async () => {
  const { root, cwd, sessions, bucket, id, file, original } = await backgroundFixture();
  const extension = join(root, "verification-extension.ts");
  await writeFile(extension, `export default function(pi) {
    pi.registerCommand("bg-confirm", { handler: async (_, ctx) => {
      const approved = await ctx.ui.confirm("Isolated verification", "Do not approve automatically", { timeout: 60000 });
      await pi.setSessionName(approved ? "confirmed-from-phone" : "declined-from-phone");
    }});
    pi.registerCommand("bg-custom", { handler: async (_, ctx) => { await ctx.ui.custom(() => undefined); }});
  }`, { mode: 0o600 });
  const terminal = new TerminalSessionBridge({ workspaceRoot: cwd, bridgeDir: join(root, "terminal") });
  const launcher = new TerminalSessionLauncher({ piBin: "must-not-run", workspaceRoot: cwd, bridge: terminal, spawnFn: () => { throw new Error("opening Terminal is forbidden in background acceptance"); } });
  let agent: AgentClient;
  const selected = process.env.PI_VERIFY_MODEL_PROVIDER && process.env.PI_VERIFY_MODEL_ID ? `${process.env.PI_VERIFY_MODEL_PROVIDER}/${process.env.PI_VERIFY_MODEL_ID}` : "@default";
  const host = new BackgroundHost({ workspaceRoot: cwd, terminalBridge: terminal, directory: join(root, "workers"),
    runtimeArgs: ["--model", selected, "--no-extensions", "-e", extension, "--no-tools", "--no-skills"],
    env: { ...await backgroundEnvironment(), PI_TEST_SESSION_OWNERS_DIR: join(root, "owners") }, emit: (sessionId, event) => agent?.sendSessionEvent(sessionId, event) });
  const history = new OmpHistoryIndex({ workspaceRoot: cwd, roots: [sessions] });
  const recovery = new HistoryRecoveryCoordinator({ history, launcher: host, workspaceRoot: cwd, directory: join(root, "operations"), offlineSource: "managed",
    bridge: { instances: async () => [...await terminal.instances(), ...await host.instances()], get: host.get.bind(host), setModel: host.setModel.bind(host) } });
  host.setControlGuard(meta => recovery.canControl(meta));
  const manager = new PiProcessManager({ piBin: "must-not-run" });
  const handler = createPiAgentHandler({ manager, workspaceRoot: cwd, terminalBridge: terminal, terminalLauncher: launcher, backgroundHost: host, history, recovery, runtime: "omp" });
  const { server, port } = await startTestServer();
  agent = new AgentClient({ url: `ws://127.0.0.1:${port}/ws/agent`, token: TEST_TOKEN, deviceId: randomUUID(), handler });
  let phone: Phone | undefined;
  try {
    await history.ready();
    await agent.connect();
    phone = new Phone(await openSocket(port, "/ws/ios"));
    const list = await phone.request("session.list", { viewVersion: 2, includeArchived: true });
    assert.equal(list.capabilities.backgroundHistoryResume, true);
    const alias = list.sessions.find((value: Record<string, any>) => value.availability === "archived").sessionId;
    const started = await phone.request("session.start", { mode: "terminal", recoveryVersion: 1, historySessionId: alias, operationId: randomUUID() });
    await recovery.wait(started.operationId);
    const ready = await phone.request("session.start", { mode: "terminal", recoveryVersion: 1, operationId: started.operationId });
    assert.equal(ready.recoveryState, "ready", JSON.stringify(ready));
    const sessionId = ready.sessionId;
    assert.equal(sessionId, `managed:${id}`);
    const meta = await host.get(sessionId);
    assert.equal(meta.persistedSessionFile, file);
    assert.equal(meta.subagentModelIsolation, true);
    assert.equal(await readFile(file, "utf8"), original);
    const modelList = await phone.request("model.list", {}, sessionId);
    const originalModel = modelList.model;
    const alternative = modelList.models.find((model: Record<string, any>) => model.provider !== originalModel.provider || model.modelId !== originalModel.modelId);
    assert.ok(alternative, "configured model catalog must supply a second model for isolated switching acceptance");
    await phone.request("session.set_model", { model: { provider: alternative.provider, modelId: alternative.modelId } }, sessionId);
    const switched = await phone.request("session.get_model", {}, sessionId);
    assert.equal(switched.model.provider, alternative.provider);
    assert.equal(switched.model.modelId, alternative.modelId);
    await phone.request("session.set_model", { model: { provider: originalModel.provider, modelId: originalModel.modelId } }, sessionId);
    const restoredModel = await phone.request("session.get_model", {}, sessionId);
    assert.equal(restoredModel.model.provider, originalModel.provider);
    assert.equal(restoredModel.model.modelId, originalModel.modelId);
    await phone.request("subscribe", { sessionId }, sessionId);
    const page = await phone.request("session.get", { viewVersion: 2, limit: 30 }, sessionId);
    assert.ok(page.items.some((item: Record<string, any>) => item.text === "correct last branch"));
    assert.ok(!page.items.some((item: Record<string, any>) => item.text === "wrong branch"));
    const tool = page.items.find((item: Record<string, any>) => item.kind === "toolResult");
    const detail = await phone.request("session.get", { viewVersion: 2, view: "tool", revision: page.revision, detailId: tool.detailId, field: "result" }, sessionId);
    assert.equal(detail.truncated, true); assert.ok(detail.nextCursor);
    let early = page;
    while (early.page.before) early = await phone.request("session.get", { viewVersion: 2, limit: 30, before: early.page.before }, sessionId);
    assert.ok(early.items.some((item: Record<string, any>) => item.text === "synthetic 0"));
    await phone.request("session.prompt", { message: "/bg-confirm" }, sessionId);
    const ui = await phone.event(event => event.type === "ui_request" && event.method === "confirm");
    assert.ok(ui.requestId.startsWith(`${meta.instanceId}:`));
    assert.equal((await host.view(sessionId, { viewVersion: 2 })).pendingUi instanceof Array, true);
    assert.notEqual((await host.get(sessionId)).title, "confirmed-from-phone", "no automatic approval");
    phone.close();
    phone = new Phone(await openSocket(port, "/ws/ios"));
    await phone.request("subscribe", { sessionId }, sessionId);
    const replayedSnapshot = await phone.request("session.get", { viewVersion: 2 }, sessionId);
    assert.equal(replayedSnapshot.pendingUi.length, 1);
    const replay = replayedSnapshot.pendingUi[0];
    assert.equal(replay.requestId, ui.requestId, "reconnect presents the same pending request, not a prompt replay");
    assert.equal((await host.get(sessionId)).processId, meta.processId);
    await assert.rejects(phone.request("ui.response", { requestId: `wrong-instance:${ui.requestId}`, response: { confirmed: true } }, sessionId));
    await phone.request("ui.response", { requestId: ui.requestId, response: { confirmed: false, cancelled: true } }, sessionId);
    const done = await phone.event(event => event.type === "agent_settled");
    assert.ok(done);
    assert.equal((await host.get(sessionId)).title, "declined-from-phone");
    await assert.rejects(phone.request("ui.response", { requestId: ui.requestId, response: { confirmed: true } }, sessionId));
    const mark = phone.events.length;
    await phone.request("session.prompt", { message: "/bg-custom" }, sessionId);
    await phone.event(event => event.type === "extension_error" && event.error?.includes("不支持自定义终端 UI"), mark);
    await phone.event(event => event.type === "agent_settled", mark);
    assert.equal((await host.view(sessionId, { viewVersion: 2 })).activity, "idle");
    if (process.env.PI_REAL_BACKGROUND === "1") {
      const responseMark = phone.events.length;
      await phone.request("session.prompt", { message: "Isolated Pi Remote verification. Do not use tools. Reply only BACKGROUND_RESUME_OK." }, sessionId);
      await phone.event(event => event.type === "agent_settled", responseMark, 120_000);
      const answer = await phone.request("session.get", { viewVersion: 2 }, sessionId);
      assert.ok(answer.items.some((item: Record<string, any>) => item.role === "assistant" && item.text?.includes("BACKGROUND_RESUME_OK")), "must be an actual model reply, not fixture text");
      const stopMark = phone.events.length;
      await phone.request("session.prompt", { message: "BACKGROUND_STOP_CHECK: output 1000 numbered lines, one per line, do not use tools." }, sessionId);
      await phone.event(event => event.type === "agent_start", stopMark);
      assert.equal((await phone.request("session.get", { viewVersion: 2 }, sessionId)).activity, "busy");
      await phone.request("session.abort", {}, sessionId);
      await phone.event(event => event.type === "agent_settled", stopMark);
      assert.equal((await phone.request("session.get", { viewVersion: 2 }, sessionId)).activity, "idle");
      console.log("PASS real Relay + native OMP model reply + abort without Terminal");
    }
    const after = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(after.find(entry => entry.type === "session").id, id);
    for (const entry of original.trim().split("\n").map(line => JSON.parse(line)).slice(1)) {
      const actual = after.find(value => value.id === entry.id);
      assert.ok(actual, `原记录 ${entry.id} 必须保留`);
      assert.deepEqual({ type: actual.type, id: actual.id, parentId: actual.parentId, timestamp: actual.timestamp, message: { ...actual.message, usage: undefined } }, { ...entry, message: { ...entry.message, usage: undefined } });
    }
    assert.deepEqual((await readdir(bucket)).filter(name => name.endsWith(".jsonl")), [`${id}.jsonl`]);
    assert.equal((await host.instances()).length, 1);
    const confirmed = await recovery.query(started.operationId);
    assert.equal(confirmed.recoveryState, "ready", JSON.stringify(confirmed));
    assert.equal((confirmed.status as Record<string, unknown>).canControl, true);
  } finally {
    phone?.close(); agent.disconnect();
    await host.shutdownAll(); host.close(); recovery.close(); history.close(); terminal.close(); launcher.close();
    await manager.closeAll(); await server.stop();
  }
});
