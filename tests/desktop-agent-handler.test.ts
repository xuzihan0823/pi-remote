import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopAgentHandler, DESKTOP_SESSION_PREFIX } from "../src/agent/desktop-agent-handler.ts";
import { TimelineRequestError } from "../src/terminal/extension.ts";
import { requestFrame, FrameQueue, TEST_TOKEN, helloFrame, openSocket, send, startTestServer } from "./helpers/relay-harness.ts";
import { AgentClient } from "../src/agent/agent-client.ts";

function fixture() {
  const sessions: Record<string, unknown>[] = [
    { id: "desktop-1", source: "desktop", title: "桌面会话", projectPath: "/projects/app", updatedAt: "2026-10-18T10:00:00Z" },
    { id: "native-pi:cli", source: "pi-native", title: "CLI" },
    { id: "remote-1", source: "remote", title: "远端" },
    { id: "legacy-desktop", title: "旧版桌面" },
  ];
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let running = false;
  const client = { call: async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ tool, args });
    if (tool === "pi_control_describe") return [
      { id: "session/list" }, { id: "session/get" }, { id: "session/create" },
      { id: "agent/getStatus" }, { id: "agent/prompt" }, { id: "agent/abort" },
    ];
    if (tool === "pi_session_list") return { sessions };
    if (tool === "pi_project_list") return { projects: [{ id: 1, path: "/projects/app", name: "app" }] };
    if (tool === "pi_agent_status") return { status: { sessionId: args.sessionId, isRunning: running, pendingToolConfirmations: 0 } };
    if (tool === "pi_session_get") return { session: { ...sessions.find(session => session.id === args.id), messageCount: 1, messageStart: 0, messageEnd: 1,
      messages: [{ id: "u1", role: "user", content: "你好", createdAt: "2026-10-18T10:00:00Z" }] } };
    if (tool === "pi_session_create") {
      const session = { id: "created", source: "desktop", title: "新会话", projectPath: args.projectPath };
      sessions.push(session); return { session };
    }
    if (tool === "pi_agent_prompt") { running = true; return { accepted: true }; }
    if (tool === "pi_agent_abort") { running = false; return { aborted: true }; }
    throw new Error(`unexpected tool ${tool}`);
  } };
  return { sessions, calls, client, handler: createDesktopAgentHandler({ client, workspaceRoot: "/projects" }) };
}

test("existing Relay forwards Desktop creation and control without a protocol or server upgrade", { timeout: 10_000 }, async () => {
  const f = fixture();
  const { server, port } = await startTestServer();
  const agent = new AgentClient({ url: `ws://127.0.0.1:${port}/ws/agent`, token: TEST_TOKEN, deviceId: "desktop-mac", handler: f.handler });
  const ios = await openSocket(port, "/ws/ios");
  const queue = new FrameQueue(ios);
  try {
    await agent.connect();
    send(ios, helloFrame("desktop-iphone", "ios"));
    let frame = await queue.next();
    while (frame.type !== "hello_ack") frame = await queue.next();
    send(ios, requestFrame("create-desktop", "session.start", { params: { mode: "desktop", cwd: "/projects/app" } }));
    frame = await queue.next();
    while (frame.type !== "response" || frame.requestId !== "create-desktop") frame = await queue.next();
    assert.equal(frame.payload.ok, true);
    assert.equal((frame.payload.data as { sessionId: string }).sessionId, "managed:desktop:created");
    send(ios, requestFrame("send-desktop", "session.prompt", { sessionId: "managed:desktop:created", params: { message: "通过 Relay 发送" } }));
    frame = await queue.next();
    while (frame.type !== "response" || frame.requestId !== "send-desktop") frame = await queue.next();
    assert.equal(frame.payload.ok, true);
    assert.equal(f.calls.filter(call => call.tool === "pi_agent_prompt").length, 1);
  } finally {
    ios.close();
    agent.disconnect();
    await server.stop();
  }
});

test("Desktop-only list includes old Desktop records but excludes native CLI and remote sessions", async () => {
  const f = fixture();
  const result = await f.handler(requestFrame("list", "session.list"));
  assert.equal(result.ok, true);
  const data = result.data as { sessions: Record<string, unknown>[]; capabilities: Record<string, unknown> };
  assert.deepEqual(data.sessions.map(session => session.sessionId), ["managed:desktop:desktop-1", "managed:desktop:legacy-desktop"]);
  assert.ok(data.sessions.every(session => session.runtime === "pi-desktop" && session.canControl === true));
  assert.equal(data.capabilities.sessionScope, "pi-desktop");
  assert.equal(data.capabilities.historyResume, false);
  assert.equal(data.capabilities.modelSelection, false);
  assert.equal(data.capabilities.remoteApprovals, false);
});

test("Desktop create, read, send, status and abort stay on the same host-owned session", async () => {
  const f = fixture();
  const startedWithoutProject = await f.handler(requestFrame("start-default", "session.start", { params: { mode: "desktop" } }));
  assert.equal(startedWithoutProject.ok, true);
  assert.deepEqual(f.calls.find(call => call.tool === "pi_session_create")?.args, {});
  const started = await f.handler(requestFrame("start", "session.start", { params: { mode: "desktop", cwd: "/projects/app" } }));
  assert.equal(started.ok, true);
  assert.deepEqual(f.calls.find(call => call.tool === "pi_session_create" && call.args.projectPath)?.args, { projectPath: "/projects/app" });
  const { sessionId } = started.data as { sessionId: string };
  assert.equal(sessionId, `${DESKTOP_SESSION_PREFIX}created`);
  const prompt = await f.handler(requestFrame("prompt", "session.prompt", { sessionId, params: { message: "任务" } }));
  assert.equal(prompt.ok, true);
  const view = await f.handler(requestFrame("get", "session.get", { sessionId, params: { viewVersion: 2 } }));
  assert.equal(view.ok, true);
  assert.equal((view.data as { activity: string }).activity, "busy");
  const abort = await f.handler(requestFrame("abort", "session.abort", { sessionId }));
  assert.equal(abort.ok, true);
  const stopped = await f.handler(requestFrame("stopped", "session.get", { sessionId, params: { viewVersion: 2 } }));
  assert.equal((stopped.data as { activity: string }).activity, "idle");
  assert.deepEqual(f.calls.filter(call => call.tool === "pi_agent_prompt" || call.tool === "pi_agent_abort"), [
    { tool: "pi_agent_prompt", args: { sessionId: "created", content: "任务" } },
    { tool: "pi_agent_abort", args: { sessionId: "created" } },
  ]);
});

test("CLI ids, non-Desktop sources and parameter escapes never invoke mutation tools", async () => {
  const f = fixture();
  for (const sessionId of ["terminal:cli", "managed:omp", "history:cli", "native-pi:cli", "managed:desktop:remote-1"]) {
    for (const method of ["session.get", "session.prompt", "session.abort", "session.set_model", "ui.response"] as const) {
      const result = await f.handler(requestFrame("invalid", method, { sessionId, params: { message: "no" } }));
      assert.equal(result.ok, false, `${method} ${sessionId}`);
    }
  }
  for (const params of [{ mode: "terminal" }, { mode: "rpc" }, { mode: "desktop", args: ["--unsafe"] }, { mode: "desktop", permissionMode: "auto" },
    { mode: "desktop", historySessionId: "history:cli" }, { mode: "desktop", cwd: "/unlisted" }]) {
    assert.equal((await f.handler(requestFrame("bad-start", "session.start", { params }))).ok, false);
  }
  assert.equal((await f.handler(requestFrame("bad-prompt", "session.prompt", { sessionId: "managed:desktop:desktop-1", params: { message: "no", images: [] } }))).ok, false);
  assert.equal((await f.handler(requestFrame("conflict", "session.abort", { sessionId: "managed:desktop:desktop-1", params: { sessionId: "managed:desktop:legacy-desktop" } }))).ok, false);
  assert.ok(!f.calls.some(call => ["pi_session_create", "pi_agent_prompt", "pi_agent_abort", "pi_desktop_invoke"].includes(call.tool)));
});

test("Desktop scope is revalidated immediately before control and errors do not become empty success", async () => {
  const f = fixture();
  await f.handler(requestFrame("list", "session.list"));
  f.sessions[0]!.source = "pi-native";
  assert.equal((await f.handler(requestFrame("send", "session.prompt", { sessionId: "managed:desktop:desktop-1", params: { message: "no" } }))).ok, false);
  assert.ok(!f.calls.some(call => call.tool === "pi_agent_prompt"));
  const handler = createDesktopAgentHandler({ client: { call: async () => { throw new Error("Pi Desktop 控制未启用"); } }, workspaceRoot: "/projects" });
  const failed = await handler(requestFrame("list", "session.list"));
  assert.equal(failed.ok, false);
  assert.match(failed.error!.message, /控制未启用/);
});

test("handler preserves typed timeline errors and does not turn oversized session lists into empty success", async () => {
  const listHandler = createDesktopAgentHandler({ workspaceRoot: "/projects", client: { call: async tool => {
    if (tool === "pi_session_list") throw new ErrorWithCode("private-preview", "result_too_large");
    return {};
  } } });
  const listError = await listHandler(requestFrame("large-list", "session.list"));
  assert.equal(listError.ok, false);
  assert.equal(listError.error?.code, "result_too_large");
  assert.doesNotMatch(listError.error!.message, /private-preview/);

  for (const code of ["result_too_large", "refresh_required"] as const) {
    const handler = createDesktopAgentHandler({ workspaceRoot: "/projects", client: { call: async (tool, args) => {
      if (tool === "pi_session_get" && args?.messageLimit === 50) {
        throw new TimelineRequestError("unsafe diagnostic", code);
      }
      return fixture().client.call(tool, args);
    } } });
    const response = await handler(requestFrame("typed", "session.get", { sessionId: "managed:desktop:desktop-1" }));
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, code);
    if (code === "result_too_large") assert.doesNotMatch(response.error!.message, /unsafe diagnostic/);
    else assert.match(response.error!.message, /unsafe diagnostic/);
  }
  const oversizedList = createDesktopAgentHandler({ workspaceRoot: "/projects", client: { call: async () => {
    throw new ErrorWithCode("do not expose preview", "result_too_large");
  } } });
  const listed = await oversizedList(requestFrame("oversized-list", "session.list"));
  assert.equal(listed.ok, false);
  assert.equal(listed.error?.code, "result_too_large");
  assert.doesNotMatch(listed.error!.message, /preview/);
});

class ErrorWithCode extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

test("Desktop list pagination does not lose sessions and rejects cross-snapshot cursors", async () => {
  const f = fixture();
  for (let i = 0; i < 70; i++) f.sessions.push({ id: `page-${i}`, source: "desktop", title: `会话 ${i}` });
  const ids: string[] = [];
  let cursor: unknown;
  let firstCursor: unknown;
  do {
    const page = await f.handler(requestFrame("list", "session.list", { params: { limit: 17, ...(cursor ? { cursor } : {}) } }));
    assert.equal(page.ok, true);
    const data = page.data as { sessions: { sessionId: string }[]; nextCursor: unknown };
    ids.push(...data.sessions.map(session => session.sessionId));
    cursor = data.nextCursor;
    firstCursor ??= cursor;
  } while (cursor);
  assert.equal(ids.length, 72);
  assert.equal(new Set(ids).size, 72);
  f.sessions.push({ id: "newer", source: "desktop" });
  assert.equal((await f.handler(requestFrame("stale", "session.list", { params: { cursor: firstCursor } }))).ok, false);
});

test("unwrapped or mismatched host status never authorizes a prompt", async () => {
  for (const status of [{ sessionId: "desktop-1", isRunning: false }, { status: { sessionId: "other", isRunning: false } }]) {
    const f = fixture();
    const handler = createDesktopAgentHandler({ workspaceRoot: "/projects", client: { call: async (tool, args) =>
      tool === "pi_agent_status" ? status : f.client.call(tool, args) } });
    const response = await handler(requestFrame("send", "session.prompt", {
      sessionId: "managed:desktop:desktop-1", params: { message: "任务" },
    }));
    assert.equal(response.ok, false);
    assert.equal(f.calls.some(call => call.tool === "pi_agent_prompt"), false);
  }
});

test("successful creation keeps its session reference when the follow-up status query fails", async () => {
  const f = fixture();
  const handler = createDesktopAgentHandler({ workspaceRoot: "/projects", client: { call: async (tool, args) => {
    if (tool === "pi_agent_status") throw new Error("status unavailable");
    return f.client.call(tool, args);
  } } });
  const created = await handler(requestFrame("start", "session.start", { params: { mode: "desktop" } }));
  assert.equal(created.ok, true);
  const data = created.data as { sessionId: string; status: { activity: string; canControl: boolean } };
  assert.equal(data.sessionId, "managed:desktop:created");
  assert.equal(data.status.activity, "unknown");
  assert.equal(data.status.canControl, false);
  assert.equal(f.calls.filter(call => call.tool === "pi_session_create").length, 1);
});

test("busy Desktop sessions reject another prompt without a second host submission", async () => {
  const f = fixture();
  const request = () => requestFrame("send", "session.prompt", { sessionId: "managed:desktop:desktop-1", params: { message: "任务" } });
  assert.equal((await f.handler(request())).ok, true);
  assert.equal((await f.handler(request())).ok, false);
  assert.equal(f.calls.filter(call => call.tool === "pi_agent_prompt").length, 1);
});
