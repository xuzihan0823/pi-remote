import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopAgentHandler, DESKTOP_SESSION_PREFIX } from "../src/agent/desktop-agent-handler.ts";
import { requestFrame } from "./helpers/relay-harness.ts";

type Call = { tool: string; args: Record<string, unknown> };

const FULL_OPERATIONS = [
  "session/list", "session/get", "session/create", "session/setModel",
  "agent/getStatus", "agent/prompt", "agent/abort",
  "providers/list", "providers/listModels", "settings/get",
  "agent/pendingInteractive", "tool/resolvePermission", "agent/askTool/resolve",
];

interface FixtureOptions {
  operations?: string[];
  describeError?: Error;
  pendingError?: Error;
  pendingBySession?: Record<string, { asks: unknown[]; permissions: unknown[] }>;
  statusPending?: Record<string, number>;
  running?: Record<string, boolean>;
  resolver?: (operation: string, args: unknown[]) => unknown;
  sessionGetError?: Error;
  failListAfterCreate?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const operations = options.operations ?? FULL_OPERATIONS;
  const pendingBySession = options.pendingBySession ?? {};
  const statusPending = options.statusPending ?? {};
  const running = options.running ?? {};
  const resolver = options.resolver ?? (() => ({ ok: true }));
  const sessions: Record<string, unknown>[] = [
    {
      id: "desktop-1", source: "desktop", title: "一号会话", projectPath: "/projects/app",
      permissionMode: "ask", providerId: "alpha", modelId: "shared",
      capabilities: { canPrompt: true, canStop: true }, updatedAt: "2026-10-18T10:00:00Z",
    },
    {
      id: "desktop-2", source: "desktop", title: "二号会话", projectPath: "/projects/app",
      permissionMode: "inherit", providerId: "beta", modelId: "shared",
      updatedAt: "2026-10-18T09:00:00Z",
    },
  ];
  const calls: Call[] = [];
  const byId = (id:unknown): Record<string, unknown> | undefined =>
    sessions.find(session => session.id === id);
  const client = {
    async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ tool, args });
      if (tool === "pi_control_describe") {
        if (options.describeError) throw options.describeError;
        return operations.map(id => ({ id }));
      }
      if (tool === "pi_session_list") {
        if (options.failListAfterCreate && byId("created")) throw new Error("list unavailable after create");
        return { sessions };
      }
      if (tool === "pi_session_get") {
        if (options.sessionGetError) throw options.sessionGetError;
        const session = byId(args.id);
        if (!session) throw new Error("session missing");
        return { session: { ...session, messageCount: 1, messageStart: 0, messageEnd: 1,
          messages: [{ id: "u1", role: "user", content: "你好", createdAt: "2026-10-18T10:00:00Z" }] } };
      }
      if (tool === "pi_agent_status") {
        return { status: { sessionId: args.sessionId, isRunning: running[String(args.sessionId)] === true,
          pendingToolConfirmations: statusPending[String(args.sessionId)] ?? 0 } };
      }
      if (tool === "pi_project_list") {
        return { projects: [{ id: 1, path: "/projects/app", name: "app" }] };
      }
      if (tool === "pi_session_create") {
        const session: Record<string, unknown> = {
          id: "created", source: "desktop", title: "新会话", projectPath: args.projectPath,
          permissionMode: "ask", providerId: args.providerId, modelId: args.modelId,
        };
        sessions.push(session);
        return { session };
      }
      if (tool === "pi_session_set_model") {
        const session = byId(args.id);
        if (!session) throw new Error("session missing");
        session.providerId = args.providerId;
        session.modelId = args.modelId;
        return { session };
      }
      if (tool === "pi_desktop_invoke") {
        const operation = String(args.operation);
        const operationArgs = Array.isArray(args.args) ? args.args : [];
        if (operation === "providers/list") {
          return { operation, result: { providers: [{ id: "alpha", enabled: true }, { id: "beta", enabled: true }] } };
        }
        if (operation === "providers/listModels") {
          const providerId = (operationArgs[0] as { providerId?: string } | undefined)?.providerId;
          return { operation, result: { models: [
            { modelId: "shared", displayName: `${providerId} Shared` },
            { modelId: `${providerId}-only` },
          ] } };
        }
        if (operation === "settings/get") {
          return { operation, result: { defaultPermissionMode: "auto" } };
        }
        if (operation === "agent/pendingInteractive") {
          if (options.pendingError) throw options.pendingError;
          const sessionId = String((operationArgs[0] as { sessionId?: unknown } | undefined)?.sessionId);
          return { operation, result: pendingBySession[sessionId] ?? { asks: [], permissions: [] } };
        }
        if (operation === "tool/resolvePermission" || operation === "agent/askTool/resolve") {
          return { operation, result: resolver(operation, operationArgs) };
        }
        throw new Error(`unexpected operation ${operation}`);
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
  const handler = createDesktopAgentHandler({ client, workspaceRoot: "/projects" });
  const resolverCalls = () => calls.filter(call => {
    const operation = call.args.operation;
    return call.tool === "pi_desktop_invoke" &&
      (operation === "tool/resolvePermission" || operation === "agent/askTool/resolve");
  });
  return { sessions, calls, handler, resolverCalls };
}

function permission(requestId: string, sessionId: string): Record<string, unknown> {
  return { requestId, sessionId, toolName: "Bash", reason: "需要执行命令", argsPreview: { command: "ls" } };
}

function question(requestId: string, sessionId: string): Record<string, unknown> {
  return { requestId, sessionId, questions: [{ question: "继续？", options: ["是", "否"] }] };
}

test("old Desktop versions expose metadata controls without enabling model or approval capabilities", async () => {
  const f = fixture({
    operations: ["session/list", "session/get", "agent/getStatus", "agent/prompt", "agent/abort", "session/create"],
    statusPending: { "desktop-1": 2 },
    pendingBySession: {
      "desktop-1": { asks: [question("ask-1", "desktop-1")], permissions: [] },
    },
  });
  const result = await f.handler(requestFrame("list", "session.list"));
  assert.equal(result.ok, true);
  const data = result.data as { sessions: Record<string, unknown>[]; capabilities: Record<string, unknown> };
  assert.equal(data.capabilities.modelCatalog, false);
  assert.equal(data.capabilities.modelSelection, false);
  assert.equal(data.capabilities.modelSelectionOnCreate, false);
  assert.equal(data.capabilities.remoteApprovals, false);
  assert.equal(data.capabilities.sessionControls, true);
  const entry = data.sessions.find(session => session.sessionId === `${DESKTOP_SESSION_PREFIX}desktop-1`)!;
  assert.equal(entry.hasPendingApproval, true);
  assert.ok(!f.calls.some(call => call.args.operation === "agent/pendingInteractive"));
});

test("model catalog keeps provider-distinct models and creation validates the selected provider", async () => {
  const f = fixture();
  const catalog = await f.handler(requestFrame("catalog", "model.list", { params: { mode: "desktop", cwd: "/projects/app" } }));
  assert.equal(catalog.ok, true);
  const models = (catalog.data as { models: { provider: string; modelId: string; name: string }[] }).models;
  assert.deepEqual(models, [
    { provider: "alpha", modelId: "shared", name: "alpha Shared" },
    { provider: "alpha", modelId: "alpha-only", name: "alpha-only" },
    { provider: "beta", modelId: "shared", name: "beta Shared" },
    { provider: "beta", modelId: "beta-only", name: "beta-only" },
  ]);
  assert.equal((await f.handler(requestFrame("bad-catalog", "model.list", { params: { mode: "terminal" } }))).ok, false);
  assert.equal((await f.handler(requestFrame("extra-catalog", "model.list", { params: { mode: "desktop", sessionId: "managed:desktop:desktop-1" } }))).ok, false);

  const created = await f.handler(requestFrame("start", "session.start", {
    params: { mode: "desktop", cwd: "/projects/app", model: { provider: "beta", modelId: "shared" } },
  }));
  assert.equal(created.ok, true);
  assert.deepEqual(f.calls.find(call => call.tool === "pi_session_create")?.args, {
    projectPath: "/projects/app", providerId: "beta", modelId: "shared",
  });
  const data = created.data as { sessionId: string; modelSelection: { applied: boolean; model: { provider: string } } };
  assert.equal(data.sessionId, `${DESKTOP_SESSION_PREFIX}created`);
  assert.equal(data.modelSelection.applied, true);
  assert.equal(data.modelSelection.model.provider, "beta");

  const wrongProvider = await f.handler(requestFrame("wrong-provider", "session.start", {
    params: { mode: "desktop", model: { provider: "beta", modelId: "alpha-only" } },
  }));
  assert.equal(wrongProvider.ok, false);
  assert.equal(f.calls.filter(call => call.tool === "pi_session_create").length, 1);
});

test("creation keeps the real session id and never claims an unconfirmed model", async () => {
  const f = fixture({ failListAfterCreate: true });
  const created = await f.handler(requestFrame("start", "session.start", {
    params: { mode: "desktop", model: { provider: "alpha", modelId: "shared" } },
  }));
  assert.equal(created.ok, true);
  const data = created.data as {
    sessionId: string; status: { activity: string };
    modelSelection: { applied: boolean; error: { message: string } };
  };
  assert.equal(data.sessionId, `${DESKTOP_SESSION_PREFIX}created`);
  assert.equal(data.status.activity, "idle");
  assert.equal(data.modelSelection.applied, false);
  assert.match(data.modelSelection.error.message, /list unavailable/);
  assert.equal(f.calls.filter(call => call.tool === "pi_session_create").length, 1);
});

test("set_model only sends model fields after catalog, scope and idle checks", async () => {
  const f = fixture();
  const changed = await f.handler(requestFrame("set", "session.set_model", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { model: { provider: "alpha", modelId: "shared" } },
  }));
  assert.equal(changed.ok, true);
  const call = f.calls.find(item => item.tool === "pi_session_set_model")!;
  assert.deepEqual(call.args, { id: "desktop-1", providerId: "alpha", modelId: "shared", confirm: true });
  assert.deepEqual(Object.keys(call.args).sort(), ["confirm", "id", "modelId", "providerId"]);
  assert.deepEqual((changed.data as { model: unknown }).model, {
    provider: "alpha", modelId: "shared", name: "alpha Shared",
  });

  const before = f.calls.filter(item => item.tool === "pi_session_set_model").length;
  assert.equal((await f.handler(requestFrame("extra", "session.set_model", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { model: { provider: "alpha", modelId: "shared" }, mode: "auto" },
  }))).ok, false);
  assert.equal((await f.handler(requestFrame("extra-model", "session.set_model", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { model: { provider: "alpha", modelId: "shared", thinkingLevel: "high" } },
  }))).ok, false);
  assert.equal((await f.handler(requestFrame("wrong-model", "session.set_model", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { model: { provider: "beta", modelId: "alpha-only" } },
  }))).ok, false);
  assert.equal(f.calls.filter(item => item.tool === "pi_session_set_model").length, before);

  const busy = fixture({ running: { "desktop-1": true } });
  const rejected = await busy.handler(requestFrame("busy", "session.set_model", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { model: { provider: "alpha", modelId: "shared" } },
  }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "session_busy");
  assert.equal(busy.calls.some(item => item.tool === "pi_session_set_model"), false);
});

test("controls use metadata even when transcript reads fail, and pending failures are not empty success", async () => {
  const f = fixture({
    sessionGetError: Object.assign(new Error("transcript too large"), { code: "result_too_large" }),
    pendingBySession: {
      "desktop-1": { asks: [question("ask-1", "desktop-1")], permissions: [permission("perm-1", "desktop-1")] },
    },
    running: { "desktop-1": true },
  });
  const controls = await f.handler(requestFrame("controls", "session.get", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`, params: { view: "controls" },
  }));
  assert.equal(controls.ok, true);
  const data = controls.data as Record<string, unknown>;
  assert.equal(data.sessionId, `${DESKTOP_SESSION_PREFIX}desktop-1`);
  assert.deepEqual(data.permission, { mode: "ask", effectiveMode: "ask" });
  assert.deepEqual(data.model, { provider: "alpha", modelId: "shared", name: "shared" });
  assert.equal(data.interactionsSupported, true);
  assert.equal(data.canControl, true);
  assert.equal(data.activity, "busy");
  assert.equal((data.pendingInteractions as unknown[]).length, 2);
  assert.equal(f.calls.some(call => call.tool === "pi_session_get"), false);

  const inherited = await f.handler(requestFrame("inherit", "session.get", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-2`, params: { view: "controls" },
  }));
  assert.deepEqual((inherited.data as { permission: unknown }).permission, {
    mode: "inherit", effectiveMode: "auto",
  });

  const broken = fixture({ pendingError: new Error("pending unavailable") });
  const failed = await broken.handler(requestFrame("broken", "session.get", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`, params: { view: "controls" },
  }));
  assert.equal(failed.ok, false);
  assert.equal(failed.data, undefined);
  assert.match(failed.error!.message, /pending unavailable/);
});

test("controls fail explicitly when the control catalog cannot be read", async () => {
  const f = fixture({ describeError: new Error("control unavailable") });
  const result = await f.handler(requestFrame("controls-unavailable", "session.get", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`, params: { view: "controls" },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.equal(result.error?.code, "not_implemented");
  assert.match(result.error!.message, /control unavailable/);
  assert.equal(f.calls.some(call => call.args.operation === "agent/pendingInteractive"), false);
});

test("controls degrade to unsupported interactions on an old Desktop catalog", async () => {
  const f = fixture({
    operations: ["session/list", "session/get", "agent/getStatus", "agent/prompt", "agent/abort"],
  });
  const result = await f.handler(requestFrame("controls-old", "session.get", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`, params: { view: "controls" },
  }));
  assert.equal(result.ok, true);
  const data = result.data as { interactionsSupported: boolean; pendingInteractions: unknown[] };
  assert.equal(data.interactionsSupported, false);
  assert.deepEqual(data.pendingInteractions, []);
  assert.equal(f.calls.some(call => call.args.operation === "agent/pendingInteractive"), false);
});

test("session.list marks pending unknown when the control catalog cannot be read", async () => {
  const f = fixture({ describeError: new Error("control unavailable"), statusPending: { "desktop-1": 0 } });
  const result = await f.handler(requestFrame("list-catalog-unavailable", "session.list"));
  assert.equal(result.ok, true);
  const entries = (result.data as { sessions: Record<string, unknown>[] }).sessions;
  const first = entries.find(session => session.sessionId === `${DESKTOP_SESSION_PREFIX}desktop-1`)!;
  assert.equal(first.hasPendingApproval, false);
  assert.equal(first.pendingStateKnown, false);
});

test("session.list counts remote questions as pending approvals", async () => {
  const f = fixture({
    pendingBySession: {
      "desktop-1": { asks: [question("ask-1", "desktop-1")], permissions: [] },
    },
  });
  const listed = await f.handler(requestFrame("list", "session.list"));
  assert.equal(listed.ok, true);
  const entries = (listed.data as { sessions: Record<string, unknown>[] }).sessions;
  const first = entries.find(session => session.sessionId === `${DESKTOP_SESSION_PREFIX}desktop-1`)!;
  const second = entries.find(session => session.sessionId === `${DESKTOP_SESSION_PREFIX}desktop-2`)!;
  assert.equal(first.hasPendingApproval, true);
  assert.equal(first.pendingStateKnown, true);
  assert.equal(second.hasPendingApproval, false);
});

test("session.list marks pending unknown on failed interaction queries without clearing tool confirmations", async () => {
  const broken = fixture({ pendingError: new Error("pending unavailable"), statusPending: { "desktop-1": 1 } });
  const listed = await broken.handler(requestFrame("list", "session.list"));
  assert.equal(listed.ok, true);
  const entries = (listed.data as { sessions: Record<string, unknown>[] }).sessions;
  const first = entries.find(session => session.sessionId === `${DESKTOP_SESSION_PREFIX}desktop-1`)!;
  assert.equal(first.hasPendingApproval, true);
  assert.equal(first.pendingStateKnown, false);
});

test("ui.response requires remote approvals, revalidates ownership and only acknowledges confirmed writes", async () => {
  const f = fixture({
    running: { "desktop-1": true },
    pendingBySession: {
      "desktop-1": { asks: [], permissions: [permission("perm-1", "desktop-1")] },
      "desktop-2": { asks: [], permissions: [permission("perm-2", "desktop-2")] },
    },
  });
  const acknowledged = await f.handler(requestFrame("ack", "ui.response", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { requestId: "perm-1", response: { kind: "permission", decision: "allow-once" } },
  }));
  assert.equal(acknowledged.ok, true);
  assert.deepEqual(acknowledged.data, {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`, requestId: "perm-1", acknowledged: true,
  });
  assert.deepEqual(f.resolverCalls().map(call => call.args), [{
    operation: "tool/resolvePermission", confirm: true,
    args: [{ requestId: "perm-1", decision: "allow-once" }],
  }]);

  const crossSession = await f.handler(requestFrame("cross", "ui.response", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { requestId: "perm-2", response: { kind: "permission", decision: "deny" } },
  }));
  assert.equal(crossSession.ok, false);
  assert.equal(crossSession.error?.code, "unknown_session");
  assert.equal(f.resolverCalls().length, 1);

  const uncertain = fixture({
    pendingBySession: { "desktop-1": { asks: [], permissions: [permission("perm-3", "desktop-1")] } },
    resolver: () => ({ ok: false }),
  });
  const notAcknowledged = await uncertain.handler(requestFrame("nack", "ui.response", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { requestId: "perm-3", response: { kind: "permission", decision: "deny" } },
  }));
  assert.equal(notAcknowledged.ok, false);
  assert.equal(notAcknowledged.error?.code, "internal_error");
  assert.match(notAcknowledged.error!.message, /无法确认/);

  const unsupported = fixture({ operations: ["session/list", "session/get", "agent/getStatus"] });
  const denied = await unsupported.handler(requestFrame("unsupported", "ui.response", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
    params: { requestId: "perm-1", response: { kind: "permission", decision: "deny" } },
  }));
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, "not_implemented");
  assert.equal(unsupported.resolverCalls().length, 0);
});

test("model reads survive an unavailable control catalog while model lists fail explicitly", async () => {
  const f = fixture({ describeError: new Error("control unavailable") });
  const current = await f.handler(requestFrame("get", "session.get_model", {
    sessionId: `${DESKTOP_SESSION_PREFIX}desktop-1`,
  }));
  assert.equal(current.ok, true);
  assert.deepEqual((current.data as { model: unknown }).model, {
    provider: "alpha", modelId: "shared", name: "shared",
  });
  const catalog = await f.handler(requestFrame("catalog", "model.list", { params: { mode: "desktop" } }));
  assert.equal(catalog.ok, false);
  assert.match(catalog.error!.message, /control unavailable/);
});
