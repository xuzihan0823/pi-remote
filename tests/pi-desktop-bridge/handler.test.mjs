import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { CATALOG, createDesktopApi, createDesktopStore, message } from "./fake-host.mjs";

const require = createRequire(import.meta.url);
const { DesktopGateway } = require("../../plugins/pi-desktop-bridge/lib/desktop.js");
const { createRequestHandler } = require("../../plugins/pi-desktop-bridge/lib/handler.js");
const { TimelineService, projectMessage } = require("../../plugins/pi-desktop-bridge/lib/timeline.js");

async function setup(options = {}) {
  const store = options.store ?? createDesktopStore();
  const pi = { desktop: createDesktopApi(store, options.catalog ?? CATALOG) };
  const desktop = new DesktopGateway(pi);
  await desktop.refresh();
  const tracked = [];
  const handler = createRequestHandler({
    desktop,
    watcher: { track: (id, opts) => tracked.push({ id, ...(opts ?? {}) }) },
    timeline: new TimelineService(desktop),
    homeDir: "/Users/me",
  });
  const call = (method, { sessionId, params } = {}) => handler({
    version: 1, type: "request", requestId: `r-${Math.random()}`, ...(sessionId ? { sessionId } : {}),
    payload: { method, ...(params ? { params } : {}) },
  });
  return { store, desktop, handler, call, tracked };
}

test("能力探测：只把白名单内的 read/write 操作视为可用，dangerous 一律不可用", async () => {
  const { desktop } = await setup();
  assert.equal(desktop.ready, true);
  assert.equal(desktop.has("session/get"), true);
  assert.equal(desktop.has("tool/resolvePermission"), false);
  assert.equal(desktop.has("session/configure"), false);
  assert.equal(desktop.has("plans/resolve"), false);
  await assert.rejects(desktop.invoke("tool/resolvePermission", [{}]), /不允许/);
  await assert.rejects(desktop.invoke("session/delete", ["s1"]), /不允许/);

  // 目录里把白名单操作标成 dangerous 时同样拒绝
  const odd = await setup({ catalog: CATALOG.map((entry) => entry.id === "session/create" ? { ...entry, risk: "dangerous" } : entry) });
  assert.equal(odd.desktop.has("session/create"), false);
});

test("session.list：只列本机 Pi Desktop 会话，并给出 iOS 需要的字段与能力", async () => {
  const { call, store } = await setup();
  store.status.s1 = { sessionId: "s1", isRunning: true, pendingToolConfirmations: 0 };
  const result = await call("session.list", { params: {} });
  assert.equal(result.ok, true);
  const ids = result.data.sessions.map((session) => session.sessionId);
  assert.deepEqual(ids, ["terminal:desktop:s2", "terminal:desktop:s1"]);
  const s1 = result.data.sessions.find((session) => session.sessionId === "terminal:desktop:s1");
  assert.equal(s1.source, "terminal");
  assert.equal(s1.runtime, "pi-desktop");
  assert.equal(s1.activity, "busy");
  assert.equal(s1.availability, "live");
  assert.equal(s1.canControl, true);
  assert.equal(s1.cwd, "/Users/me/app");
  assert.equal(s1.project, "app");
  assert.equal(typeof s1.startedAt, "number");
  assert.equal(s1.startedAt, Date.parse("2026-10-23T08:00:00Z"));
  const caps = result.data.capabilities;
  assert.equal(caps.timelineV2, true);
  assert.equal(caps.timelineAnchors, false);
  assert.equal(caps.ompArchiveRead, false);
  assert.equal(caps.modelSelection, true);
  assert.equal(caps.modelCatalog, true);
  assert.equal(caps.projectSelection, true);
  assert.equal(caps.remoteApprovals, false);
  assert.equal(result.data.nextCursor, null);
  // 从不调用 dangerous 操作
  assert.ok(store.calls.every((entry) => !["tool/resolvePermission", "agent/askTool/resolve", "plans/resolve", "session/configure", "session/delete"].includes(entry.operation)));
  assert.ok(store.calls.every((entry) => entry.confirm === undefined));
});

test("session.list：v2 分页游标", async () => {
  const { call } = await setup();
  const first = await call("session.list", { params: { viewVersion: 2, includeArchived: true, limit: 1 } });
  assert.equal(first.data.sessions.length, 1);
  assert.equal(first.data.nextCursor, "1");
  const second = await call("session.list", { params: { viewVersion: 2, includeArchived: true, limit: 1, cursor: "1" } });
  assert.equal(second.data.sessions[0].sessionId, "terminal:desktop:s1");
  assert.equal(second.data.nextCursor, null);
  const bad = await call("session.list", { params: { viewVersion: 2, limit: 1, cursor: "zzz" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "invalid_frame");
});

test("session.list projectView=recent 返回 PI-Desktop 已知项目；目录浏览不支持", async () => {
  const { call } = await setup();
  const recent = await call("session.list", { params: { projectView: "recent" } });
  assert.deepEqual(recent.data, { projects: [{ path: "/Users/me/app", name: "app" }], home: "/Users/me", defaultDirectory: "/Users/me/app" });
  const directory = await call("session.list", { params: { projectView: "directory", path: "/" } });
  assert.equal(directory.ok, false);
  assert.equal(directory.error.code, "not_implemented");
});

test("session.get：时间线条目映射（正文、工具调用/结果、附件、跳过子 agent 行）", async () => {
  const { call, tracked } = await setup();
  const result = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "timeline", limit: 50 } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const data = result.data;
  assert.equal(data.viewVersion, 2);
  assert.equal(data.sessionId, "terminal:desktop:s1");
  assert.equal(data.branchId, "desktop:main");
  assert.equal(data.availability, "live");
  assert.equal(data.activity, "idle");
  assert.equal(data.canControl, true);
  assert.equal(typeof data.revision, "string");
  assert.deepEqual(data.page, { hasMoreBefore: false, before: null });
  const kinds = data.items.map((item) => `${item.kind}:${item.role ?? item.name ?? ""}:${item.status ?? ""}`);
  assert.deepEqual(kinds, [
    "message:user:",
    "message:assistant:",
    "toolCall:Read:succeeded",
    "toolResult:Read:succeeded",
    "toolCall:Bash:running",
    "message:user:",
    "unsupported::",
  ]);
  const read = data.items[2];
  assert.ok(read.detailId);
  assert.doesNotMatch(read.preview, /sk-should-hide/);
  assert.match(read.preview, /\[已隐藏\]/);
  assert.equal(data.items[3].preview, "ERROR token expired");
  assert.equal(data.items.at(-1).text, "附件：screen shot.png");
  assert.ok(!JSON.stringify(data).includes("子 agent 的输出"));
  assert.deepEqual(data.messages[0], { role: "user", text: "帮我看看登录为什么失败" });
  assert.deepEqual(tracked, [{ id: "s1" }]);
  // 条目 id 稳定：再读一次相同
  const again = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "timeline", limit: 50 } });
  assert.deepEqual(again.data.items.map((item) => item.id), data.items.map((item) => item.id));
  assert.equal(again.data.revision, data.revision);
});

test("session.get：before 游标按 PI-Desktop 消息窗口向前翻页", async () => {
  const store = createDesktopStore();
  store.messages.s1 = Array.from({ length: 75 }, (_, index) => message(`x${index}`, index % 2 ? "assistant" : "user", `第 ${index} 条`));
  const { call } = await setup({ store });
  const latest = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "timeline", limit: 50 } });
  assert.equal(latest.data.items.length, 30);
  assert.equal(latest.data.items[0].text, "第 45 条");
  assert.equal(latest.data.page.hasMoreBefore, true);
  const older = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "timeline", before: latest.data.page.before, limit: 50 } });
  assert.equal(older.data.items[0].text, "第 15 条");
  assert.equal(older.data.items.at(-1).text, "第 44 条");
  const oldest = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "timeline", before: older.data.page.before, limit: 50 } });
  assert.equal(oldest.data.items.length, 15);
  assert.equal(oldest.data.page.hasMoreBefore, false);
  assert.equal(oldest.data.page.before, null);

  const forged = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, before: "abc.def" } });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, "invalid_frame");
  // 别的会话的游标不能拿来用
  const crossed = await call("session.get", { sessionId: "terminal:desktop:s2", params: { viewVersion: 2, before: latest.data.page.before } });
  assert.equal(crossed.ok, false);
});

test("session.get：工具详情按字段分段读取，长正文可展开", async () => {
  const store = createDesktopStore();
  store.messages.s1.push(message("long", "assistant", "长".repeat(3000)));
  store.messages.s1.push(message("big", "tool", "", { toolName: "Bash", toolCallId: "call-big", toolStatus: "error", toolArgs: { command: "make" }, toolResult: "e".repeat(150_000) }));
  const { call } = await setup({ store });
  const timeline = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "timeline", limit: 50 } });
  const longItem = timeline.data.items.find((item) => item.kind === "message" && item.truncated);
  assert.ok(longItem, "长正文应被截断并带 detailId");
  const body = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "tool", detailId: longItem.detailId, revision: timeline.data.revision, field: "result" } });
  assert.equal(body.ok, true, JSON.stringify(body.error));
  assert.equal(body.data.text, "长".repeat(3000));

  const call2 = timeline.data.items.find((item) => item.kind === "toolCall" && item.name === "Bash" && item.status === "failed");
  const args = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "tool", detailId: call2.detailId, revision: timeline.data.revision, field: "arguments" } });
  assert.match(args.data.text, /make/);
  const first = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "tool", detailId: call2.detailId, revision: timeline.data.revision, field: "error" } });
  assert.equal(first.data.recorded, true);
  assert.equal(first.data.totalBytes, 150_000);
  assert.ok(first.data.nextCursor);
  const second = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "tool", detailId: call2.detailId, revision: timeline.data.revision, field: "error", cursor: first.data.nextCursor } });
  assert.equal(first.data.returnedBytes + second.data.returnedBytes + (second.data.nextCursor ? 1 : 0) > 100_000, true);
});

test("session.get：等待处理的权限 / 计划 / AskTool 以警告形式提示“需要在 Mac 上处理”", async () => {
  const store = createDesktopStore();
  store.status.s1 = { sessionId: "s1", isRunning: true, pendingToolConfirmations: 2, planningState: "awaiting_approval" };
  store.messages.s1.push(message("ask", "tool", "", { toolName: "asktool", toolCallId: "ask-1", toolStatus: "running", toolArgs: { questions: [] } }));
  const { call } = await setup({ store });
  const result = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, view: "timeline" } });
  assert.equal(result.data.activity, "busy");
  assert.ok(result.data.warnings.some((warning) => /2 个工具权限请求.*计划等待批准.*Mac/.test(warning)), result.data.warnings.join("|"));
  assert.ok(result.data.warnings.some((warning) => /正在提问.*Mac/.test(warning)));

  const askMode = await call("session.get", { sessionId: "terminal:desktop:s2", params: { viewVersion: 2, view: "timeline" } });
  assert.ok(askMode.data.warnings.some((warning) => /auto/.test(warning)));
});

test("session.get 拒绝非 Pi Desktop 会话引用与旧版视图", async () => {
  const { call } = await setup();
  for (const sessionId of ["terminal:abc", "managed:x", "terminal:desktop:native-pi:abc", "terminal:desktop:../etc"]) {
    const result = await call("session.get", { sessionId, params: { viewVersion: 2 } });
    assert.equal(result.ok, false, sessionId);
  }
  const unknown = await call("session.get", { sessionId: "terminal:desktop:nope", params: { viewVersion: 2 } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "unknown_session");
  const legacy = await call("session.get", { sessionId: "terminal:desktop:s1", params: {} });
  assert.equal(legacy.ok, false);
  const anchors = await call("session.get", { sessionId: "terminal:desktop:s1", params: { viewVersion: 2, afterItemId: "x" } });
  assert.equal(anchors.ok, false);
});

test("session.prompt → agent/prompt；运行中拒绝；停止 → agent/abort", async () => {
  const { call, store, tracked } = await setup();
  const sent = await call("session.prompt", { sessionId: "terminal:desktop:s1", params: { message: "继续" } });
  assert.deepEqual(sent, { ok: true, data: { sessionId: "terminal:desktop:s1", queued: true } });
  const prompt = store.calls.find((entry) => entry.operation === "agent/prompt");
  assert.deepEqual(prompt.args, [{ sessionId: "s1", content: "继续" }]);
  assert.deepEqual(tracked.at(-1), { id: "s1", poke: true });

  const busy = await call("session.prompt", { sessionId: "terminal:desktop:s1", params: { message: "再来" } });
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, "session_busy");

  const aborted = await call("session.abort", { sessionId: "terminal:desktop:s1" });
  assert.deepEqual(aborted, { ok: true, data: { sessionId: "terminal:desktop:s1", aborted: true } });
  assert.deepEqual(store.calls.find((entry) => entry.operation === "agent/abort").args, [{ sessionId: "s1" }]);

  const empty = await call("session.prompt", { sessionId: "terminal:desktop:s1", params: { message: "   " } });
  assert.equal(empty.ok, false);
  const images = await call("session.prompt", { sessionId: "terminal:desktop:s1", params: { message: "看图", images: [{}] } });
  assert.equal(images.ok, false);
  assert.equal(images.error.code, "not_implemented");
});

test("session.start → session/create：只接受 Mac 共享模式、已知项目与目录内模型", async () => {
  const { call, store } = await setup();
  const rpc = await call("session.start", { params: { mode: "rpc" } });
  assert.equal(rpc.ok, false);
  assert.match(rpc.error.message, /Mac 共享会话/);

  const unknownProject = await call("session.start", { params: { mode: "terminal", cwd: "/etc" } });
  assert.equal(unknownProject.ok, false);

  const badModel = await call("session.start", { params: { mode: "terminal", model: { provider: "anthropic", modelId: "nope" } } });
  assert.equal(badModel.ok, false);

  const created = await call("session.start", { params: { mode: "terminal", cwd: "/Users/me/app", model: { provider: "anthropic", modelId: "claude-sonnet" } } });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.match(created.data.sessionId, /^terminal:desktop:new\d+$/);
  assert.equal(created.data.source, "terminal");
  assert.equal(created.data.status.source, "terminal");
  assert.equal(created.data.status.activity, "idle");
  assert.deepEqual(created.data.modelSelection, { applied: true, model: { provider: "anthropic", modelId: "claude-sonnet", name: "Claude Sonnet", contextWindow: 200000 } });
  assert.deepEqual(store.calls.find((entry) => entry.operation === "session/create").args, [{ projectPath: "/Users/me/app", providerId: "anthropic", modelId: "claude-sonnet" }]);

  const resume = await call("session.start", { params: { mode: "terminal", historySessionId: "history:x" } });
  assert.equal(resume.ok, false);
});

test("模型：新建前列出目录；已有会话只返回当前模型；切换模型与 UI 回应需在 Mac 上完成", async () => {
  const { call, store } = await setup();
  const catalog = await call("model.list", { params: { mode: "terminal" } });
  assert.deepEqual(catalog.data.models.map((model) => `${model.provider}/${model.modelId}`), ["anthropic/claude-sonnet", "openai/gpt-5"]);
  assert.ok(store.calls.filter((entry) => entry.operation === "providers/listModels").every((entry) => entry.args[0].source === "cache"));

  const session = await call("model.list", { sessionId: "terminal:desktop:s1" });
  assert.deepEqual(session.data, {
    sessionId: "terminal:desktop:s1",
    model: { provider: "anthropic", modelId: "claude-sonnet", name: "claude-sonnet" },
    models: [{ provider: "anthropic", modelId: "claude-sonnet", name: "claude-sonnet" }],
  });
  const current = await call("session.get_model", { sessionId: "terminal:desktop:s2" });
  assert.equal(current.data.model.modelId, "gpt-5");

  const setModel = await call("session.set_model", { sessionId: "terminal:desktop:s1", params: { model: { provider: "openai", modelId: "gpt-5" } } });
  assert.equal(setModel.ok, false);
  assert.equal(setModel.error.code, "not_implemented");
  const ui = await call("ui.response", { sessionId: "terminal:desktop:s1", params: { requestId: "x", response: { confirmed: true } } });
  assert.equal(ui.ok, false);
  assert.equal(ui.error.code, "not_implemented");
  assert.ok(store.calls.every((entry) => entry.operation !== "session/configure"));
});

test("缺少 desktop.control 时每个请求都返回明确原因", async () => {
  const pi = { desktop: { listOperations: async () => { throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" }); } } };
  const desktop = new DesktopGateway(pi);
  await desktop.refresh();
  const handler = createRequestHandler({ desktop });
  const result = await handler({ version: 1, type: "request", requestId: "r", payload: { method: "session.list" } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not_implemented");
  assert.match(result.error.message, /desktop\.control/);
});

test("projectMessage 处理拒绝执行与错误消息", () => {
  const denied = projectMessage("s1", message("d", "tool", "", { toolName: "Write", toolStatus: "denied", toolArgs: {} }));
  assert.equal(denied.items[0].status, "cancelled");
  assert.equal(denied.items[1].isError, true);
  const failed = projectMessage("s1", message("e", "assistant", "", { status: "error", error: { message: "rate limited" } }));
  assert.equal(failed.items.length, 1);
  assert.equal(failed.items[0].isError, true);
  assert.match(failed.items[0].text, /rate limited/);
  const aborted = projectMessage("s1", message("a", "assistant", "一半", { status: "aborted" }));
  assert.deepEqual(aborted.items.map((item) => item.kind), ["message", "boundary"]);
  assert.deepEqual(projectMessage("s1", message("sys", "system", "x")).items, []);
});
