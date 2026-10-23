// DaemonServer 集成测试：真 HTTP/WS + 真 watcher/tracker/bridge（:memory:），
// SDK 侧走 fake QueryFactory（不触真 SDK/网络）。fixture 会话文件建在临时目录。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, readFile, writeFile, rm, utimes } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

import { InteractionManager, InteractionStore } from "../../src/interactions/index.ts";
import type { QueryFactory } from "../../src/agent-bridge/index.ts";

import { ConfigError, loadConfig, stateRoot, type DaemonConfig } from "../../src/config.ts";
import { readModelCatalog } from "../../src/model-config.ts";
import { ApprovalBridge, TurnRunner, type ActivityGate, type Notifier } from "../../src/run/index.ts";
import { DaemonServer } from "../../src/server.ts";
import { ActivityTracker } from "../../src/watch/activity.ts";
import { SessionWatcher } from "../../src/watch/watcher.ts";
import type { ProjectCatalog } from "../../src/transcript/projects.ts";
import type { SessionSummary } from "../../src/transcript/types.ts";
import { projectWorkspaces } from "./fixtures/project-workspaces.ts";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const SESSION_CWD = "/tmp/claude-remote-it";
const TOKEN = "it-token-0123456789abcdef0123456789abcdef";
const PICKER_MODELS = Array.from({ length: 25 }, (_, index) => ({
  model: `provider-${index}/shared-model`, label: `Configured model ${index}`,
}));

function jsonlLine(o: Record<string, unknown>): string {
  return `${JSON.stringify(o)}\n`;
}

function userLine(uuid: string, parentUuid: string | null, text: string): string {
  return jsonlLine({
    type: "user", uuid, parentUuid, cwd: SESSION_CWD, sessionId: SESSION_ID,
    message: { role: "user", content: text }, timestamp: "2026-07-18T10:00:00.000Z",
  });
}

function assistantLine(uuid: string, parentUuid: string, text: string): string {
  return jsonlLine({
    type: "assistant", uuid, parentUuid, cwd: SESSION_CWD, sessionId: SESSION_ID,
    message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: "2026-07-18T10:00:01.000Z",
  });
}

// -- fake SDK factory：手动控制结束时机 ---------------------------------------

type QueryParams = Parameters<QueryFactory>[0];
type SdkQuery = ReturnType<QueryFactory>;

interface FakeSdk {
  factory: QueryFactory;
  params: QueryParams | undefined;
  /** resolve 后 SDK 消息流结束（run → done）。 */
  finish: () => void;
}

function fakeSdk(): FakeSdk {
  const holder: FakeSdk = { factory: undefined as never, params: undefined, finish: () => {} };
  holder.factory = ((params: QueryParams): SdkQuery => {
    holder.params = params;
    let release: () => void = () => {};
    const gatePromise = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    holder.finish = release;
    const generator = (async function* () {
      const ev = (event: unknown) => ({ type: "stream_event", uuid: "e", session_id: SESSION_ID, parent_tool_use_id: null, event }) as never;
      yield ev({ type: "message_start", message: { id: "msg_t" } });
      yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done " } });
      yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "text" } });
      yield ev({ type: "content_block_stop", index: 0 });
      yield {
        type: "assistant", uuid: "sdk-a1", session_id: SESSION_ID,
        message: { content: [{ type: "text", text: "done text" }] },
      } as never;
      await gatePromise;
    })();
    const augmented = generator as unknown as Record<string, unknown>;
    augmented.interrupt = async (): Promise<void> => release();
    augmented.close = (): void => {};
    return generator as unknown as SdkQuery;
  }) as unknown as QueryFactory;
  return holder;
}

// -- 装配 ---------------------------------------------------------------------

interface Harness {
  server: DaemonServer;
  base: string;
  wsUrl: (token?: string) => string;
  watcher: SessionWatcher;
  tracker: ActivityTracker;
  bridge: ApprovalBridge;
  sdk: FakeSdk;
  notifications: Array<{ title: string; body: string }>;
  sessionFile: string;
  projectsDir: string;
  uploadsDir: string;
  webRoot: string;
  dispose: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "claude-remote-it-"));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    model: "fable",
    env: { ANTHROPIC_DEFAULT_FABLE_MODEL: PICKER_MODELS[0]?.model, ANTHROPIC_API_KEY: "private-api-key" },
    modelPicker: { options: PICKER_MODELS.map((option) => ({ ...option, description: "private-description" })) },
  }));
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "-tmp-claude-remote-it");
  await mkdir(projectDir, { recursive: true });
  const sessionFile = join(projectDir, `${SESSION_ID}.jsonl`);
  await writeFile(sessionFile, userLine("u1", null, "hello daemon") + assistantLine("a1", "u1", "hi human"));

  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>it</title>");

  const config: DaemonConfig = {
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    projectsDir,
    uploadsDir: join(root, "uploads"),
    cooldownMs: 120_000,
    interactionsDbPath: ":memory:",
    permissionTimeoutMs: 300_000,
  };

  const store = new InteractionStore(":memory:");
  const manager = new InteractionManager(store, { defaultTtlMs: 300_000 });
  const watcher = new SessionWatcher({ projectsDir });
  const tracker = new ActivityTracker({ cooldownMs: 120_000 });
  const gate: ActivityGate = {
    isIdle: (id) => tracker.getStatus(id) === "idle",
    beginRun: (id) => tracker.beginRun(id),
    endRun: (id) => tracker.endRun(id),
  };
  let server: DaemonServer;
  const bridge = new ApprovalBridge({ manager, onEvent: (event) => server.handleApprovalEvent(event) });
  const sdk = fakeSdk();
  const runner = new TurnRunner({ gate, permissions: bridge, queryFactory: sdk.factory });
  const notifications: Array<{ title: string; body: string }> = [];
  const notifier: Notifier = async (title, body) => {
    notifications.push({ title, body });
  };

  server = new DaemonServer({
    config, webRoot, watcher, tracker, runner, approvals: bridge, notifier,
    version: "0.1.0-test", claudeCliVersion: () => "9.9.9-test",
    modelCatalog: () => readModelCatalog(settingsPath),
  });
  await server.listen();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    server, base,
    wsUrl: (token = TOKEN) => `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    watcher, tracker, bridge, sdk, notifications, sessionFile, projectsDir, uploadsDir: config.uploadsDir, webRoot,
    dispose: async () => {
      await server.close();
      watcher.close();
      tracker.dispose();
      manager.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${TOKEN}` } };
}

/** 收集 WS 帧；waitFor 轮询等待谓词命中。 */
class FrameSink {
  readonly frames: Array<Record<string, unknown>> = [];
  readonly ws: WebSocket;
  #opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      this.frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    this.#opened = new Promise((resolvePromise, rejectPromise) => {
      this.ws.once("open", resolvePromise);
      this.ws.once("error", rejectPromise);
    });
  }

  async open(): Promise<void> {
    await this.#opened;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  async waitFor(match: (frame: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(match);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`frame not received; got: ${JSON.stringify(this.frames)}`);
      await delay(20);
    }
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------

const harness = await startHarness();
after(() => harness.dispose());

test("loadConfig: 缺/短 token 拒绝；默认值正确", () => {
  const TOKEN32 = "0123456789abcdef0123456789abcdef";
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ BRIDGE_TOKEN: "  " }), ConfigError);
  assert.throws(() => loadConfig({ BRIDGE_TOKEN: "short" }), ConfigError);
  assert.throws(() => loadConfig({ BRIDGE_TOKEN: `${TOKEN32.slice(0, 31)} ` }), ConfigError); // 32 字符但含空白
  const config = loadConfig({ BRIDGE_TOKEN: TOKEN32 });
  assert.equal(config.token, TOKEN32);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8788);
  assert.equal(config.cooldownMs, 120_000);
  assert.equal(config.permissionTimeoutMs, 300_000);
  assert.ok(config.instanceId);
  // BRIDGE_PUBLIC_BASES 已移除（同 claude-remote d63e50b）：设置了也不再出现在配置里
  assert.equal("publicBases" in loadConfig({ BRIDGE_TOKEN: TOKEN32, BRIDGE_PUBLIC_BASES: "https://a.example.com" }), false);
  const root = stateRoot({});
  assert.equal(config.interactionsDbPath, join(root, "interactions.sqlite"));
  assert.equal(config.uploadsDir, join(root, "uploads"));
  assert.ok(config.projectsDir.endsWith(join(".claude", "projects")));
  assert.throws(() => loadConfig({ BRIDGE_TOKEN: TOKEN32, BRIDGE_PORT: "abc" }), ConfigError);
});

test("鉴权：/api 无 token 401；错 token 401；对 token 放行", async () => {
  const anon = await fetch(`${harness.base}/api/health`);
  assert.equal(anon.status, 401);
  assert.deepEqual(await anon.json(), { error: "unauthorized" });
  const wrong = await fetch(`${harness.base}/api/health`, { headers: { Authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
  const ok = await fetch(`${harness.base}/api/health`, authed());
  assert.equal(ok.status, 200);
  const health = (await ok.json()) as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal(health.service, "pi-remote-claude");
  assert.match(String(health.instanceId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(health.version, "0.1.0-test");
  assert.equal(health.claudeCliVersion, "9.9.9-test");
  assert.equal(typeof health.hostname, "string");
});

test("静态托管：/ 返回 index.html；路径穿越 404", async () => {
  const index = await fetch(`${harness.base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await index.text(), /<title>it<\/title>/);
  const traversal = await fetch(`${harness.base}/..%2f..%2fetc%2fpasswd`);
  assert.equal(traversal.status, 404);
});

test("CORS：/api 预检 204 无需鉴权；普通响应带 Allow-Origin", async () => {
  const preflight = await fetch(`${harness.base}/api/health`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  const normal = await fetch(`${harness.base}/api/health`, authed());
  assert.equal(normal.headers.get("access-control-allow-origin"), "*");
});

// pair-info 在 Bearer 校验之前按 socket 源地址放行，前提是「loopback = 物理在本机的人」。
// cloudflared/ngrok/nginx 等代理跑在本机时源地址同样是 127.0.0.1，该前提失效：
// 隧道一开，公网任何人无需鉴权即可读走 token。故带任何代理特征头一律拒绝。
test("配对端点：本机直连放行；带代理特征头（隧道/反代）一律 403，防 token 经隧道泄露", async () => {
  const direct = await fetch(`${harness.base}/api/pair-info`);
  assert.equal(direct.status, 200);
  const info = (await direct.json()) as { token: string; bases: string[] };
  assert.equal(info.token, TOKEN);
  assert.ok(Array.isArray(info.bases));

  for (const header of ["x-forwarded-for", "cf-connecting-ip", "cf-ray", "x-real-ip", "forwarded"]) {
    const viaProxy = await fetch(`${harness.base}/api/pair-info`, { headers: { [header]: "1.2.3.4" } });
    assert.equal(viaProxy.status, 403, `${header} 应被拒绝`);
    assert.deepEqual(await viaProxy.json(), { error: "loopback_only" });
  }

  const qr = await fetch(`${harness.base}/api/pair-qr.svg`, { headers: { "x-forwarded-for": "1.2.3.4" } });
  assert.equal(qr.status, 403);
});

test("POST upload：落盘到 uploadsDir/sessionId、文件名消毒；空体 400；未知会话 404", async () => {
  const res = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/upload?filename=${encodeURIComponent("../evil/no te.txt")}`, authed({
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "hello upload",
  }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { path: string; name: string; sizeBytes: number };
  assert.equal(body.name, "no te.txt");
  assert.equal(body.sizeBytes, 12);
  assert.ok(body.path.startsWith(join(harness.uploadsDir, SESSION_ID) + "/"));
  assert.equal(await readFile(body.path, "utf8"), "hello upload");

  const empty = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/upload?filename=a.txt`, authed({ method: "POST" }));
  assert.equal(empty.status, 400);
  const missing = await fetch(`${harness.base}/api/sessions/nope/upload?filename=a.txt`, authed({
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "x",
  }));
  assert.equal(missing.status, 404);
});

test("GET /api/sessions：fixture 会话 + 状态覆盖 + 分页 total", async () => {
  const res = await fetch(`${harness.base}/api/sessions?limit=10`, authed());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sessions: Array<Record<string, unknown>>; total: number };
  assert.equal(body.total, 1);
  const [session] = body.sessions;
  assert.ok(session);
  assert.equal(session.sessionId, SESSION_ID);
  assert.equal(session.cwd, SESSION_CWD);
  assert.equal(session.status, "idle");
  assert.equal(session.title, "hello daemon");
});

test("项目目录与会话过滤：完整索引、worktree 合并、分页前筛选、鉴权与原 cwd 创建", async (t) => {
  const isolated = await startHarness();
  t.after(() => isolated.dispose());
  const root = await mkdtemp(join(tmpdir(), "claude-project-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, worktree, nested, plainA, plainB } = await projectWorkspaces(root);
  await rm(isolated.sessionFile);
  const dir = join(isolated.projectsDir, "project-fixtures");
  await mkdir(dir);
  const specs = [
    { cwd: worktree, at: 90 }, { cwd: plainA, at: 80 }, { cwd: repo, at: 70 },
    { cwd: plainB, at: 60 }, { cwd: nested, at: 50 }, { cwd: "", at: 40 },
  ];
  const ids = specs.map((_, index) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`);
  for (const [index, spec] of specs.entries()) {
    const file = join(dir, `${ids[index]}.jsonl`);
    await writeFile(file, jsonlLine({
      type: "user", uuid: `user-${index}`, parentUuid: null,
      ...(spec.cwd === "" ? {} : { cwd: spec.cwd }),
      message: { role: "user", content: `conversation ${index}` },
    }));
    await utimes(file, spec.at, spec.at);
  }

  for (const headers of [undefined, { Authorization: "Bearer wrong" }]) {
    const rejected = await fetch(`${isolated.base}/api/projects`, headers === undefined ? {} : { headers });
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), { error: "unauthorized" });
  }
  const response = await fetch(`${isolated.base}/api/projects?limit=1`, authed());
  assert.equal(response.status, 200);
  const catalog = await response.json() as ProjectCatalog & { homeCwd: string };
  assert.deepEqual(catalog, {
    projects: [
      { id: repo, name: "repo with spaces", cwd: worktree, cwds: [worktree, repo, nested], sessionCount: 3, lastActiveAt: 90_000 },
      { id: plainA, name: "same-name", cwd: plainA, cwds: [plainA], sessionCount: 1, lastActiveAt: 80_000 },
      { id: plainB, name: "same-name", cwd: plainB, cwds: [plainB], sessionCount: 1, lastActiveAt: 60_000 },
    ],
    totalSessions: 6, unclassifiedCount: 1, homeCwd: homedir(),
  });

  const page = async (query: string) => {
    const result = await fetch(`${isolated.base}/api/sessions?${query}`, authed());
    assert.equal(result.status, 200);
    return await result.json() as { sessions: SessionSummary[]; total: number };
  };
  const all = await page("limit=2&offset=1");
  assert.equal(all.total, 6);
  assert.deepEqual(all.sessions.map((session) => session.sessionId), [ids[1], ids[2]]);
  isolated.tracker.beginRun(ids[2]!);
  const filtered = await page(new URLSearchParams({ projectId: repo, limit: "1", offset: "1" }).toString());
  assert.equal(filtered.total, 3);
  assert.deepEqual(filtered.sessions.map((session) => session.sessionId), [ids[2]]);
  assert.equal(filtered.sessions[0]?.status, "daemon-driving");
  isolated.tracker.endRun(ids[2]!);
  const older = await page(new URLSearchParams({ projectId: repo, limit: "1", offset: "2" }).toString());
  assert.equal(older.total, 3);
  assert.equal(older.sessions[0]?.cwd, nested);
  const exact = await page(new URLSearchParams({ cwd: worktree }).toString());
  assert.equal(exact.total, 1);
  assert.equal(exact.sessions[0]?.sessionId, ids[0]);
  const combined = await page(new URLSearchParams({ projectId: repo, cwd: nested }).toString());
  assert.equal(combined.total, 1);
  assert.equal(combined.sessions[0]?.sessionId, ids[4]);
  const unclassified = await page("projectId=");
  assert.equal(unclassified.total, 1);
  assert.equal(unclassified.sessions[0]?.sessionId, ids[5]);
  assert.deepEqual(await page("cwd="), unclassified);
  for (const query of [
    new URLSearchParams({ projectId: "/unknown" }).toString(),
    new URLSearchParams({ projectId: worktree }).toString(),
    new URLSearchParams({ projectId: repo, cwd: plainA }).toString(),
    new URLSearchParams({ cwd: "/unknown" }).toString(),
    "projectId=&offset=1",
  ]) {
    const empty = await page(query);
    assert.deepEqual(empty.sessions, []);
    assert.equal(empty.total, query === "projectId=&offset=1" ? 1 : 0);
  }

  const created = await fetch(`${isolated.base}/api/sessions`, authed({
    method: "POST", body: JSON.stringify({ cwd: worktree, text: "worktree target" }),
  }));
  assert.equal(created.status, 202);
  const { sessionId } = await created.json() as { sessionId: string };
  assert.equal((isolated.sdk.params?.options as { cwd?: string } | undefined)?.cwd, worktree);
  const stop = await fetch(`${isolated.base}/api/sessions/${sessionId}/abort`, authed({ method: "POST" }));
  assert.equal(stop.status, 200);

  await rm(join(dir, `${ids[0]}.jsonl`));
  await rm(join(dir, `${ids[2]}.jsonl`));
  const refreshed = await fetch(`${isolated.base}/api/projects`, authed());
  const current = await refreshed.json() as ProjectCatalog;
  assert.deepEqual(current.projects.find((project) => project.id === repo)?.cwds, [nested]);
  assert.equal(current.projects.find((project) => project.id === repo)?.cwd, nested);
  const rootNotKnown = await fetch(`${isolated.base}/api/sessions`, authed({
    method: "POST", body: JSON.stringify({ cwd: repo, text: "repository ID is not a runnable cwd" }),
  }));
  assert.equal(rootNotKnown.status, 400);
  assert.deepEqual(await rootNotKnown.json(), { error: "unknown_cwd" });
});

test("GET /api/models：返回 Mac 模型投影；未鉴权拒绝", async () => {
  const anon = await fetch(`${harness.base}/api/models`);
  assert.equal(anon.status, 401);
  const res = await fetch(`${harness.base}/api/models`, authed());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    defaultModel: PICKER_MODELS[0]?.model,
    models: PICKER_MODELS.map(({ model, label }) => ({ id: model, alias: model, displayName: label })),
  });
});

test("新会话/模型输入校验：未知 cwd、未知模型拒绝；abort 对无活跃 run 幂等", async () => {
  const unknownCwd = await fetch(`${harness.base}/api/sessions`, authed({
    method: "POST", body: JSON.stringify({ cwd: "/tmp/unknown", text: "hello" }),
  }));
  assert.equal(unknownCwd.status, 400);
  assert.deepEqual(await unknownCwd.json(), { error: "unknown_cwd" });

  const home = await fetch(`${harness.base}/api/sessions`, authed({
    method: "POST", body: JSON.stringify({ cwd: homedir(), text: "hello from home" }),
  }));
  assert.equal(home.status, 202);
  const homeSession = await home.json() as { sessionId: string };
  assert.equal((harness.sdk.params?.options as { cwd?: string } | undefined)?.cwd, homedir());
  const homeStop = await fetch(`${harness.base}/api/sessions/${homeSession.sessionId}/abort`, authed({ method: "POST" }));
  assert.equal(homeStop.status, 200);

  const unknownModel = await fetch(`${harness.base}/api/sessions`, authed({
    method: "POST", body: JSON.stringify({ cwd: SESSION_CWD, text: "hello", model: "wat" }),
  }));
  assert.equal(unknownModel.status, 400);
  assert.deepEqual(await unknownModel.json(), { error: "unknown_model" });

  const unknownResumeModel = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/messages`, authed({
    method: "POST", body: JSON.stringify({ text: "hello", model: "provider-25/shared-model" }),
  }));
  assert.equal(unknownResumeModel.status, 400);
  assert.deepEqual(await unknownResumeModel.json(), { error: "unknown_model" });

  const missing = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/abort`, authed({ method: "POST" }));
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { runId: null, status: "idle" });

  // 无 daemon run 但被判 terminal-driving（上一轮报错后的收尾写入等）：停止 = 解除占用
  harness.tracker.noteWrite(SESSION_ID);
  assert.equal(harness.tracker.getStatus(SESSION_ID), "terminal-driving");
  const release = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/abort`, authed({ method: "POST" }));
  assert.equal(release.status, 200);
  assert.deepEqual(await release.json(), { runId: null, status: "released" });
  assert.equal(harness.tracker.getStatus(SESSION_ID), "idle");

  const malformed = await fetch(`${harness.base}/api/sessions/not-a-uuid/abort`, authed({ method: "POST" }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_session_id" });
});

test("GET messages：升序主链；未知会话 404", async () => {
  const res = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/messages?limit=100`, authed());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { messages: Array<Record<string, unknown>>; firstSeq: number; hasMore: boolean };
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0]?.text, "hello daemon");
  assert.equal(body.messages[1]?.text, "hi human");
  assert.equal(body.firstSeq, 1);
  assert.equal(body.hasMore, false);

  const missing = await fetch(`${harness.base}/api/sessions/does-not-exist/messages`, authed());
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "session_not_found" });
});

test("WS：错 token 拒绝；订阅后收到增量 message 与 status 帧；* 订阅收 status", async (t) => {
  await assert.rejects(async () => {
    const bad = new FrameSink(harness.wsUrl("wrong"));
    t.after(() => bad.close());
    await bad.open();
  });

  const sink = new FrameSink(harness.wsUrl());
  const star = new FrameSink(harness.wsUrl());
  t.after(() => {
    sink.close();
    star.close();
  });
  await sink.open();
  await star.open();
  sink.send({ type: "subscribe", sessionId: SESSION_ID });
  star.send({ type: "subscribe", sessionId: "*" });
  await delay(50); // subscribe 帧处理（含 watcher 初扫）

  await appendFile(harness.sessionFile, userLine("u2", "a1", "terminal turn"));
  await harness.watcher.pollNow(SESSION_ID);

  const message = await sink.waitFor((frame) => frame.type === "message");
  assert.equal((message.message as Record<string, unknown>).text, "terminal turn");
  const status = await sink.waitFor((frame) => frame.type === "status");
  assert.equal(status.status, "terminal-driving");
  await star.waitFor((frame) => frame.type === "status" && frame.sessionId === SESSION_ID);
  // "*" 不该收到 message 帧
  assert.equal(star.frames.some((frame) => frame.type === "message"), false);

  // 终端驾驶中发送 → 409 + 当前状态
  const rejected = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/messages`, authed({
    method: "POST", body: JSON.stringify({ text: "should fail" }),
  }));
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: "not_idle", status: "terminal-driving" });

  // 回 idle：直接结束终端驾驶（等价 cooldown 到期，不真等 120s）
  harness.tracker.beginRun(SESSION_ID);
  harness.tracker.endRun(SESSION_ID);
});

test("POST messages：202 起 run、cwd 来自 JSONL、run 帧广播、完成通知；空 text 400", async (t) => {
  const bad = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/messages`, authed({
    method: "POST", body: JSON.stringify({ text: "   " }),
  }));
  assert.equal(bad.status, 400);

  const sink = new FrameSink(harness.wsUrl());
  t.after(() => sink.close());
  await sink.open();
  sink.send({ type: "subscribe", sessionId: SESSION_ID });
  await delay(50);

  const res = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/messages`, authed({
    method: "POST", body: JSON.stringify({ text: "web turn" }),
  }));
  assert.equal(res.status, 202);
  const { runId } = (await res.json()) as { runId: string };
  assert.ok(runId.length > 0);
  const sdkOptions = harness.sdk.params?.options as { cwd?: string; model?: string } | undefined;
  assert.equal(sdkOptions?.cwd, SESSION_CWD);
  assert.equal(Object.hasOwn(sdkOptions ?? {}, "model"), false, "未选择模型时必须跟随 Mac 默认");

  await sink.waitFor((frame) => frame.type === "run" && frame.state === "started" && frame.runId === runId);
  await sink.waitFor((frame) => frame.type === "status" && frame.status === "daemon-driving");
  // 流式草稿：增量合帧后推给订阅者，block 结束带 done
  await sink.waitFor((frame) => frame.type === "stream" && frame.done === true);
  const all = sink.frames.filter((f) => f.type === "stream" && f.key === "msg_t:0");
  assert.equal(all.map((f) => f.text).join(""), "done text");
  // 中途订阅的客户端拿到完整快照
  const late = new FrameSink(harness.wsUrl());
  t.after(() => late.close());
  await late.open();
  late.send({ type: "subscribe", sessionId: SESSION_ID });
  await late.waitFor((frame) => frame.type === "stream" && frame.offset === 0 && frame.text === "done text");

  // run 未结束时再次发送 → 409 daemon-driving
  const busy = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/messages`, authed({
    method: "POST", body: JSON.stringify({ text: "again" }),
  }));
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: "not_idle", status: "daemon-driving" });

  harness.sdk.finish();
  await sink.waitFor((frame) => frame.type === "run" && frame.state === "done" && frame.runId === runId);
  await sink.waitFor((frame) => frame.type === "stream" && frame.clear === true);
  await sink.waitFor((frame) => frame.type === "status" && frame.status === "idle");
  assert.ok(harness.notifications.some((n) => n.title === "Claude 已完成" && n.body === "web turn"));
});

test("POST messages：picker 末项和内置别名均传入 fake SDK", async (t) => {
  const sink = new FrameSink(harness.wsUrl());
  t.after(() => sink.close());
  await sink.open();
  sink.send({ type: "subscribe", sessionId: SESSION_ID });
  await delay(30);

  for (const model of ["provider-24/shared-model", "sonnet"]) {
    const res = await fetch(`${harness.base}/api/sessions/${SESSION_ID}/messages`, authed({
      method: "POST", body: JSON.stringify({ text: "selected model turn", model }),
    }));
    assert.equal(res.status, 202);
    const { runId } = (await res.json()) as { runId: string };
    const sdkOptions = harness.sdk.params?.options as Record<string, unknown> | undefined;
    assert.equal(sdkOptions?.model, model);
    assert.equal(sdkOptions?.resume, SESSION_ID);
    harness.sdk.finish();
    await sink.waitFor((frame) => frame.type === "run" && frame.state === "done" && frame.runId === runId);
    assert.equal(harness.tracker.getStatus(SESSION_ID), "idle");
  }
});

test("POST sessions：显式 UUID、模型覆盖、JSONL 延迟出现后 resync、abort 幂等", async (t) => {
  const res = await fetch(`${harness.base}/api/sessions`, authed({
    method: "POST",
    body: JSON.stringify({ cwd: SESSION_CWD, text: "new mobile chat", model: PICKER_MODELS[24]?.model }),
  }));
  assert.equal(res.status, 202);
  const created = (await res.json()) as { sessionId: string; runId: string };
  assert.match(created.sessionId, /^[0-9a-f-]{36}$/i);
  assert.ok(created.runId.length > 0);

  const sdkOptions = harness.sdk.params?.options as Record<string, unknown> | undefined;
  assert.equal(sdkOptions?.cwd, SESSION_CWD);
  assert.equal(sdkOptions?.sessionId, created.sessionId);
  assert.equal(sdkOptions?.model, PICKER_MODELS[24]?.model);
  assert.equal(Object.hasOwn(sdkOptions ?? {}, "resume"), false);

  const sink = new FrameSink(harness.wsUrl());
  t.after(() => sink.close());
  await sink.open();
  sink.send({ type: "subscribe", sessionId: created.sessionId });
  await delay(30);
  await writeFile(join(harness.projectsDir, "-tmp-claude-remote-it", `${created.sessionId}.jsonl`), jsonlLine({
    type: "user",
    uuid: "new-u1",
    parentUuid: null,
    cwd: SESSION_CWD,
    sessionId: created.sessionId,
    message: { role: "user", content: "new mobile chat" },
  }));
  await sink.waitFor((frame) => frame.type === "resync" && frame.sessionId === created.sessionId);

  const stopped = await fetch(`${harness.base}/api/sessions/${created.sessionId}/abort`, authed({ method: "POST" }));
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { runId: created.runId, status: "aborted" });

  for (let attempt = 0; attempt < 50 && harness.tracker.getStatus(created.sessionId) !== "idle"; attempt += 1) {
    await delay(10);
  }
  const duplicate = await fetch(`${harness.base}/api/sessions/${created.sessionId}/abort`, authed({ method: "POST" }));
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { runId: null, status: "idle" });
});

test("POST sessions：未选择模型时省略 SDK model 参数", async (t) => {
  const sink = new FrameSink(harness.wsUrl());
  t.after(() => sink.close());
  await sink.open();

  const res = await fetch(`${harness.base}/api/sessions`, authed({
    method: "POST", body: JSON.stringify({ cwd: SESSION_CWD, text: "follow Mac default" }),
  }));
  assert.equal(res.status, 202);
  const { sessionId, runId } = (await res.json()) as { sessionId: string; runId: string };
  const sdkOptions = harness.sdk.params?.options as Record<string, unknown> | undefined;
  assert.equal(sdkOptions?.sessionId, sessionId);
  assert.equal(Object.hasOwn(sdkOptions ?? {}, "model"), false);

  sink.send({ type: "subscribe", sessionId });
  await delay(30);
  harness.sdk.finish();
  await sink.waitFor((frame) => frame.type === "run" && frame.state === "done" && frame.runId === runId);
});

test("审批闭环：approval 帧广播 → HTTP 决议 200 → resolved 帧；重复决议 409；未知 404", async (t) => {
  const sink = new FrameSink(harness.wsUrl());
  t.after(() => sink.close());
  await sink.open(); // 不 subscribe：审批帧是广播语义

  const decisionPromise = harness.bridge.request({
    requestId: "req-1", sessionKey: SESSION_ID, userId: "web", kind: "approval",
    toolName: "Bash", input: { command: "ls" }, prompt: "Run Bash?",
  }, new AbortController().signal);

  const card = await sink.waitFor((frame) => frame.type === "approval");
  const interaction = card.interaction as Record<string, unknown>;
  assert.equal(interaction.toolName, "Bash");
  assert.equal(interaction.sessionId, SESSION_ID);
  assert.ok(harness.notifications.some((n) => n.title === "Claude 待审批" && n.body.includes("Bash")));

  const id = interaction.interactionId as string;
  const allow = await fetch(`${harness.base}/api/interactions/${id}/decision`, authed({
    method: "POST", body: JSON.stringify({ type: "allow_once" }),
  }));
  assert.equal(allow.status, 200);
  assert.deepEqual(await allow.json(), { status: "allowed" });
  assert.deepEqual(await decisionPromise, { type: "allow_once" });
  await sink.waitFor((frame) => frame.type === "approval.resolved" && frame.interactionId === id && frame.status === "allowed");

  const dup = await fetch(`${harness.base}/api/interactions/${id}/decision`, authed({
    method: "POST", body: JSON.stringify({ type: "deny" }),
  }));
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: "already_resolved" });

  const missing = await fetch(`${harness.base}/api/interactions/nope/decision`, authed({
    method: "POST", body: JSON.stringify({ type: "allow_once" }),
  }));
  assert.equal(missing.status, 404);

  const invalid = await fetch(`${harness.base}/api/interactions/${id}/decision`, authed({
    method: "POST", body: JSON.stringify({ type: "wat" }),
  }));
  assert.equal(invalid.status, 400);
});

test("GET /api/sessions/search：默认只搜标题/路径；full=1 搜全文并给片段；空 q 400", async () => {
  const empty = await fetch(`${harness.base}/api/sessions/search?q=`, authed());
  assert.equal(empty.status, 400);

  const byTitle = await fetch(`${harness.base}/api/sessions/search?q=HELLO`, authed());
  assert.equal(byTitle.status, 200);
  const titleBody = (await byTitle.json()) as { results: Array<Record<string, unknown>>; truncated: boolean };
  assert.equal(titleBody.results.length, 1);
  assert.equal(titleBody.results[0]?.sessionId, SESSION_ID);
  assert.deepEqual((titleBody.results[0]?.match as Record<string, unknown>).field, "title");

  const byCwd = (await (await fetch(`${harness.base}/api/sessions/search?q=claude-remote-it`, authed())).json()) as {
    results: Array<{ match: { field: string } }>;
  };
  assert.equal(byCwd.results[0]?.match.field, "cwd");

  // "human" 只出现在 assistant 回复正文：默认搜不到，full=1 搜到
  const metaOnly = (await (await fetch(`${harness.base}/api/sessions/search?q=nonexistent-zzz`, authed())).json()) as {
    results: unknown[];
  };
  assert.equal(metaOnly.results.length, 0);

  // 再追加一条，保证命中行不是 lastPreview（否则默认档也会从预览命中）
  await appendFile(harness.sessionFile,
    assistantLine("a-search", "a1", "这里提到 git filter-repo 重写历史") + assistantLine("a-search-2", "a-search", "收尾"));
  const noFull = (await (await fetch(`${harness.base}/api/sessions/search?q=filter-repo`, authed())).json()) as {
    results: unknown[];
  };
  assert.equal(noFull.results.length, 0);
  const full = (await (await fetch(`${harness.base}/api/sessions/search?q=FILTER-REPO&full=1`, authed())).json()) as {
    results: Array<{ sessionId: string; status: string; match: { field: string; snippet: string; seq: number } }>;
  };
  assert.equal(full.results.length, 1);
  assert.equal(full.results[0]?.match.field, "content");
  assert.match(full.results[0]?.match.snippet ?? "", /filter-repo/);
  assert.equal(typeof full.results[0]?.match.seq, "number");
  assert.equal(full.results[0]?.status, "idle");

  const unauthorized = await fetch(`${harness.base}/api/sessions/search?q=hello`);
  assert.equal(unauthorized.status, 401);
});

test("GET /api/interactions/pending：后连上的客户端能补到待决审批，决议后消失", async () => {
  const before = (await (await fetch(`${harness.base}/api/interactions/pending`, authed())).json()) as {
    interactions: unknown[];
  };
  assert.equal(before.interactions.length, 0);

  const decision = harness.bridge.request({
    requestId: "req-pending", sessionKey: SESSION_ID, userId: "web", kind: "approval",
    toolName: "Bash", input: { command: "rm -rf build" }, prompt: "Run Bash?",
  }, new AbortController().signal);

  let listed: Array<{ interactionId: string; toolName: string; sessionId: string }> = [];
  for (let i = 0; i < 50 && listed.length === 0; i += 1) {
    listed = ((await (await fetch(`${harness.base}/api/interactions/pending`, authed())).json()) as {
      interactions: typeof listed;
    }).interactions;
    if (listed.length === 0) await delay(20);
  }
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.toolName, "Bash");
  assert.equal(listed[0]?.sessionId, SESSION_ID);

  const id = listed[0]?.interactionId ?? "";
  const deny = await fetch(`${harness.base}/api/interactions/${id}/decision`, authed({
    method: "POST", body: JSON.stringify({ type: "deny", message: "no" }),
  }));
  assert.equal(deny.status, 200);
  assert.equal((await decision).type, "deny");

  const after = (await (await fetch(`${harness.base}/api/interactions/pending`, authed())).json()) as {
    interactions: unknown[];
  };
  assert.equal(after.interactions.length, 0);
});
