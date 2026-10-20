import { createServer, type Server } from "node:http";
import { createDesktopAgentHandler } from "../../src/agent/desktop-agent-handler.ts";
import { AgentClient } from "../../src/agent/agent-client.ts";
import { startTestServer, TEST_TOKEN } from "./relay-harness.ts";

const RELAY_PORT = 18791;
const CONTROLLER_PORT = 18792;
const NATIVE_ID = "mobile-control-fixture";
const PUBLIC_ID = `managed:desktop:${NATIVE_ID}`;
const SESSION_TITLE = "手机控制测试会话";
const PROJECT_PATH = "/tmp/pi-remote-ui-fixture";

interface FixtureModel {
  provider: string;
  modelId: string;
  name: string;
}

interface FixtureMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const models: FixtureModel[] = [
  { provider: "fake", modelId: "a", name: "测试模型 A" },
  { provider: "fake", modelId: "b", name: "测试模型 B" },
];

const messages: FixtureMessage[] = [
  { id: "fixture-user", role: "user", content: "手机控制验收消息" },
  { id: "fixture-assistant", role: "assistant", content: "等待权限与问题的合成会话" },
];

const OPERATIONS = [
  "providers/list",
  "providers/listModels",
  "session/create",
  "session/setModel",
  "agent/pendingInteractive",
  "tool/resolvePermission",
  "agent/askTool/resolve",
  "settings/get",
  "session/list",
  "session/get",
].map(id => ({ id }));

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fixture expected an object");
  return value as Record<string, unknown>;
}

function fixturePermission(): Record<string, unknown> {
  return {
    requestId: "perm-fixture",
    sessionId: NATIVE_ID,
    toolName: "Bash",
    reason: "需要执行测试命令以验证改动",
    argsPreview: { command: "npm test -- fixture" },
  };
}

function fixtureQuestion(): Record<string, unknown> {
  return {
    requestId: "ask-fixture",
    sessionId: NATIVE_ID,
    questions: [
      {
        question: "选择发布渠道",
        options: [
          { label: "A", description: "仅内部测试" },
          { label: "B", description: "对外发布" },
        ],
        multiSelect: false,
      },
      {
        question: "选择覆盖范围",
        options: ["X", "Y"],
        multiSelect: true,
      },
    ],
  };
}

function textQuestion(): Record<string, unknown> {
  return {
    requestId: "ask-text-fixture",
    sessionId: NATIVE_ID,
    questions: [{ question: "请输入验收说明", options: [], multiSelect: false }],
  };
}

class MemoryDesktopClient {
  calls = 0;
  callsByTool: Record<string, number> = {};
  callLog: { tool: string; args: Record<string, unknown> }[] = [];
  activeProviderId = models[0]!.provider;
  activeModelId = models[0]!.modelId;
  modelSwitchCalls = 0;
  permissions: Record<string, unknown>[] = [];
  asks: Record<string, unknown>[] = [];
  decisions: { requestId: string; decision: string }[] = [];
  answers: { requestId: string; answers: unknown }[] = [];
  resolverFailures = 0;
  failNextResponse = false;
  timelineError = false;

  reset(): void {
    this.calls = 0;
    this.callsByTool = {};
    this.callLog = [];
    this.activeProviderId = models[0]!.provider;
    this.activeModelId = models[0]!.modelId;
    this.modelSwitchCalls = 0;
    this.permissions = [];
    this.asks = [];
    this.decisions = [];
    this.answers = [];
    this.resolverFailures = 0;
    this.failNextResponse = false;
    this.timelineError = false;
  }

  addPermission(): void {
    this.permissions = [fixturePermission()];
  }

  addQuestion(): void {
    this.asks = [fixtureQuestion()];
  }

  addTextQuestion(): void {
    this.asks = [textQuestion()];
  }

  resolveAll(): void {
    this.permissions = [];
    this.asks = [];
  }

  private sessionRecord(): Record<string, unknown> {
    return {
      id: NATIVE_ID,
      source: "desktop",
      title: SESSION_TITLE,
      projectPath: PROJECT_PATH,
      providerId: this.activeProviderId,
      modelId: this.activeModelId,
      permissionMode: "ask",
      capabilities: { canPrompt: true, canStop: true },
      createdAt: "2026-10-18T10:00:00Z",
      updatedAt: "2026-10-18T10:00:00Z",
    };
  }

  private sessionPage(args: Record<string, unknown>): Record<string, unknown> {
    if (args.id !== NATIVE_ID) throw new Error("Fixture only serves its own synthetic session");
    const count = messages.length;
    const requestedEnd = typeof args.messageBefore === "number" ? args.messageBefore : count;
    const end = Math.max(0, Math.min(requestedEnd, count));
    const limit = typeof args.messageLimit === "number" ? Math.max(1, args.messageLimit) : 50;
    const start = Math.max(0, end - limit);
    return {
      session: {
        id: NATIVE_ID,
        source: "desktop",
        messages: messages.slice(start, end),
        messageStart: start,
        messageCount: count,
        messageEnd: end,
        hasMoreBefore: start > 0,
        hasMoreAfter: end < count,
      },
    };
  }

  private resolvePermission(args: unknown[]): unknown {
    if (this.failNextResponse) {
      this.failNextResponse = false;
      this.resolverFailures++;
      throw new Error("模拟 Desktop 处理失败");
    }
    const input = record(args[0]);
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    const index = this.permissions.findIndex(permission => permission.requestId === requestId);
    if (index < 0) return { ok: false, error: "not_found" };
    this.permissions.splice(index, 1);
    this.decisions.push({ requestId, decision: String(input.decision) });
    return { ok: true };
  }

  private resolveQuestion(args: unknown[]): unknown {
    if (this.failNextResponse) {
      this.failNextResponse = false;
      this.resolverFailures++;
      throw new Error("模拟 Desktop 处理失败");
    }
    const input = record(args[0]);
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    const index = this.asks.findIndex(ask => ask.requestId === requestId);
    if (index < 0) return { ok: false, error: "not_found" };
    this.asks.splice(index, 1);
    this.answers.push({ requestId, answers: input.answers });
    return { ok: true };
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls++;
    this.callsByTool[tool] = (this.callsByTool[tool] ?? 0) + 1;
    this.callLog.push({ tool, args });
    if (this.callLog.length > 200) this.callLog.shift();

    if (tool === "pi_control_describe") return OPERATIONS;
    if (tool === "pi_session_list") return { sessions: [this.sessionRecord()] };
    if (tool === "pi_project_list") {
      return { projects: [{ path: PROJECT_PATH, name: "pi-remote-ui-fixture" }] };
    }
    if (tool === "pi_agent_status") {
      if (args.sessionId !== NATIVE_ID) throw new Error("Unknown synthetic session");
      return {
        status: {
          sessionId: NATIVE_ID,
          isRunning: false,
          pendingToolConfirmations: this.permissions.length,
        },
      };
    }
    if (tool === "pi_session_get") {
      if (this.timelineError && args.messageLimit !== 1) throw new Error("合成的正文读取失败");
      return this.sessionPage(args);
    }
    if (tool === "pi_session_set_model") {
      if (args.id !== NATIVE_ID) throw new Error("Unknown synthetic session");
      const providerId = String(args.providerId);
      const modelId = String(args.modelId);
      if (!models.some(model => model.provider === providerId && model.modelId === modelId)) {
        throw new Error("Unknown synthetic model");
      }
      this.activeProviderId = providerId;
      this.activeModelId = modelId;
      this.modelSwitchCalls++;
      return { session: this.sessionRecord() };
    }
    if (tool === "pi_desktop_invoke") {
      const operation = String(args.operation);
      const invokeArgs = Array.isArray(args.args) ? args.args : [];
      if (operation === "providers/list") {
        return { operation, result: { providers: [{ id: "fake", enabled: true }] } };
      }
      if (operation === "providers/listModels") {
        return {
          operation,
          result: { models: models.map(model => ({ modelId: model.modelId, displayName: model.name })) },
        };
      }
      if (operation === "settings/get") return { operation, result: { defaultPermissionMode: "ask" } };
      if (operation === "agent/pendingInteractive") {
        return { operation, result: { asks: this.asks, permissions: this.permissions } };
      }
      if (operation === "tool/resolvePermission") {
        return { operation, result: this.resolvePermission(invokeArgs) };
      }
      if (operation === "agent/askTool/resolve") {
        return { operation, result: this.resolveQuestion(invokeArgs) };
      }
      throw new Error(`Unsupported synthetic Desktop operation: ${operation}`);
    }
    throw new Error(`Unexpected synthetic Desktop tool: ${tool}`);
  }
}

function statePayload(fake: MemoryDesktopClient): Record<string, unknown> {
  return {
    ready: true,
    calls: fake.calls,
    callsByTool: fake.callsByTool,
    callLog: fake.callLog,
    sessionId: PUBLIC_ID,
    activeProviderId: fake.activeProviderId,
    activeModelId: fake.activeModelId,
    modelSwitchCalls: fake.modelSwitchCalls,
    pendingPermissionCount: fake.permissions.length,
    pendingQuestionCount: fake.asks.length,
    pendingPermissions: fake.permissions,
    pendingQuestions: fake.asks,
    decisions: fake.decisions,
    answers: fake.answers,
    resolverFailures: fake.resolverFailures,
    timelineError: fake.timelineError,
    failNextResponse: fake.failNextResponse,
  };
}

const fake = new MemoryDesktopClient();
const handler = createDesktopAgentHandler({ client: fake, workspaceRoot: PROJECT_PATH });
const { server } = await startTestServer({ relayPort: RELAY_PORT, piWorkspaceRoot: PROJECT_PATH });
const agent = new AgentClient({
  url: `ws://127.0.0.1:${RELAY_PORT}/ws/agent`,
  token: TEST_TOKEN,
  deviceId: "synthetic-desktop-controls-agent",
  handler,
});
await agent.connect();

function respond(response: import("node:http").ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

const controller: Server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/state") {
      respond(response, statePayload(fake));
      return;
    }
    if (method === "POST") {
      switch (url.pathname) {
        case "/reset":
          fake.reset();
          break;
        case "/permission":
          fake.addPermission();
          break;
        case "/question":
          fake.addQuestion();
          break;
        case "/text-question":
          fake.addTextQuestion();
          break;
        case "/fail-next-response":
          fake.failNextResponse = true;
          break;
        case "/resolve-all":
          fake.resolveAll();
          break;
        case "/timeline-error":
          fake.timelineError = true;
          break;
        default:
          respond(response, { ready: false, error: "unknown control endpoint" }, 404);
          return;
      }
      respond(response, statePayload(fake));
      return;
    }
    respond(response, { ready: false, error: "not found" }, 404);
  })().catch(error => {
    respond(response, { ready: false, error: error instanceof Error ? error.message : String(error) }, 500);
  });
});

await new Promise<void>((resolveListen, rejectListen) => {
  controller.once("error", rejectListen);
  controller.listen(CONTROLLER_PORT, "127.0.0.1", resolveListen);
});

console.log("DESKTOP_CONTROLS_UI_READY");

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  agent.disconnect();
  await server.stop();
  await new Promise<void>(resolveClose => controller.close(() => resolveClose()));
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
