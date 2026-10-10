import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { OmpHistoryIndex } from "../history/history-index.ts";
import { RpcClient } from "../pi/rpc-client.ts";
import type { GatewayEvent, UiDialogResponse } from "../protocol/types.ts";
import { publicModel, publicModels, safeText, type PiSessionEntry, type PiMessage } from "../terminal/extension.ts";

interface Config {
  file: string; id: string; cwd: string; launchId: string; instanceId: string;
  socketPath: string; statusPath: string; bun: string; runtime: string; args?: string[];
}
interface State {
  sessionId: string; sessionFile: string; sessionName?: string;
  isStreaming: boolean; isCompacting: boolean; queuedMessageCount: number; hasPendingAsyncWork: boolean; isSettled: boolean;
  model?: unknown;
}

const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Config;
const sessionId = `managed:${config.id}`;
const history = new OmpHistoryIndex({ workspaceRoot: config.cwd, roots: [dirname(dirname(config.file))] });
const listeners = new Set<Socket>();
const pendingUi = new Map<string, GatewayEvent>();
let identity: Record<string, unknown> | undefined;
let ready = false;
let changingModel = false;
let busy = false;
let streaming: PiSessionEntry | undefined;
const client = new RpcClient({
  sessionId, piBin: config.bun, cwd: config.cwd, mode: "rpc-ui", waitForReady: true, requestTimeoutMs: 60_000,
  args: ["--session", config.file, ...config.args ?? []],
  env: { ...process.env, PI_REMOTE_STRICT_TARGET: JSON.stringify(config) },
  spawnFn: (bin, args, options) => spawn(bin, [config.runtime, ...args], options),
  onFrame: frame => {
    if (frame.type === "strict_identity") identity = frame;
    if (frame.type === "extension_ui_request" && frame.method === "ask" && typeof frame.id === "string") {
      client.respondToUi(frame.id, { cancelled: true });
      broadcast({ type: "notice", sessionId, level: "warning", text: "手机暂不支持结构化 Ask 对话，已取消本次请求；请在 Mac 完成。没有批准任何选项。" });
    }
    if (["message_start", "message_update", "message_end"].includes(String(frame.type)) &&
      typeof frame.messageId === "string" && frame.message && typeof frame.message === "object" && "role" in frame.message && frame.message.role === "assistant") {
      const raw = frame.message;
      const message: PiMessage = { role: "assistant", content: "content" in raw ? raw.content : [],
        timestamp: "timestamp" in raw && typeof raw.timestamp === "number" ? raw.timestamp : undefined,
        stopReason: "stopReason" in raw && typeof raw.stopReason === "string" ? raw.stopReason : undefined,
        errorMessage: "errorMessage" in raw && typeof raw.errorMessage === "string" ? raw.errorMessage : undefined };
      streaming = { type: "message", id: `stream:${config.instanceId}:${frame.messageId}`, message };
    }
    if (frame.type === "prompt_result" && frame.sessionSettled === true) {
      busy = false;
      pendingUi.clear();
      broadcast({ type: "agent_settled", sessionId });
    }
    if (frame.type === "prompt_result" && frame.status === "error") {
      const error = frame.error && typeof frame.error === "object" && "message" in frame.error ? frame.error.message : undefined;
      const reason = typeof error === "string" ? safeText(error).slice(0, 1024) : "";
      const message = /certificate|cert_verify|证书/i.test(reason)
        ? "模型服务证书校验失败，请检查 Mac 的代理或受信任证书；不会自动重发。"
        : `本次消息执行失败${reason ? `：${reason}` : "，请查看会话记录"}；不会自动重发。`;
      broadcast({ type: "process_error", sessionId, message });
    }
  },
});

function broadcast(event: GatewayEvent): void {
  const line = JSON.stringify({ event }) + "\n";
  for (const socket of listeners) {
    if (!socket.write(line) || socket.writableLength > 1024 * 1024) socket.destroy();
  }
}
client.onEvent(event => {
  if (event.type === "agent_start") busy = true;
  if (event.type === "agent_settled") { busy = false; pendingUi.clear(); }
  if (event.type === "ui_request" && event.expectsResponse) {
    event = { ...event, requestId: `${config.instanceId}:${event.requestId}` };
    pendingUi.set(event.requestId, event);
  }
  if (event.type === "ui_request" && event.method === "cancel" && typeof event.payload.targetId === "string") {
    pendingUi.delete(`${config.instanceId}:${event.payload.targetId}`);
  }
  broadcast(event);
  if (event.type === "process_exit") {
    ready = false;
    process.stderr.write(client.getStderr());
    void saveStatus(`exited ${process.pid} ${event.code ?? 1}`).finally(() => {
      if (server.listening) server.close(() => process.exit(event.code ?? 1));
    });
    for (const socket of listeners) socket.end();
  }
});

async function saveStatus(value: string): Promise<void> {
  const staged = `${config.statusPath}.${randomUUID()}.tmp`;
  await writeFile(staged, value + "\n", { mode: 0o600 });
  await rename(staged, config.statusPath);
}

async function state(): Promise<State> {
  if (!ready || !identity || !client.isRunning()) throw new Error("background_not_ready");
  const result = await client.send<State>({ type: "get_state" });
  if (result.sessionId !== config.id || result.sessionFile !== config.file || identity.id !== config.id || identity.file !== config.file || identity.processId !== client.pid) throw new Error("background_identity_changed");
  return result;
}
function isBusy(value: State): boolean {
  return busy || value.isStreaming || value.isCompacting || value.queuedMessageCount > 0 || value.hasPendingAsyncWork || value.isSettled === false;
}
async function meta() {
  const value = await state();
  return { sessionId, title: value.sessionName ?? "后台 OMP 会话", cwd: config.cwd, runtime: "omp", source: "managed",
    activity: isBusy(value) ? "busy" : "idle", persistedSessionId: config.id, persistedSessionFile: config.file,
    processId: client.pid, instanceId: config.instanceId, launchId: config.launchId, canControl: true,
    fileIdentity: identity!.fileIdentity, rewriteGeneration: identity!.generation,
    subagentModelIsolation: true,
    capabilities: { timelineV2: true, toolDetails: true, modelSelection: true }, approvalLocation: "phone" };
}

const supervisorPid = Number(process.env.PI_REMOTE_SUPERVISOR_PID);
if (Number.isSafeInteger(supervisorPid) && supervisorPid > 1) {
  setInterval(() => {
    try { process.kill(supervisorPid, 0); }
    catch { void shutdown(); }
  }, 1_000).unref();
}

async function request(message: Record<string, unknown>, socket: Socket): Promise<unknown> {
  if (message.op !== "list" && message.sessionId !== sessionId) throw new Error("unknown_session");
  if (message.op !== "list" && message.instanceId !== config.instanceId) throw new Error("background_instance_changed");
  if (message.op === "shutdown") {
    await client.close();
    return { stopped: true };
  }
  if (message.op === "list") return [await meta()];
  if (message.op === "subscribe") {
    await state();
    listeners.add(socket);
    for (const event of pendingUi.values()) socket.write(JSON.stringify({ event }) + "\n");
    return { subscribed: true };
  }
  if (message.op === "snapshot") {
    const value = await state();
    const leaf = identity!.leafId;
    if (leaf !== null && typeof leaf !== "string") throw new Error("background_branch_unconfirmed");
    const data = await history.live(config, message, {
      context: { sessionId, branchId: `${config.instanceId}:${identity!.branchGeneration}`, availability: "live", canControl: true,
        activity: isBusy(value) ? "busy" : "idle" },
      leaf, extraEntries: streaming ? [streaming] : [],
    });
    return { ...data, pendingUi: [...pendingUi.values()] };
  }
  if (message.op === "models" || message.op === "get_model") {
    const value = await state();
    const models = message.op === "models" ? publicModels((await client.send<{ models: unknown }>({ type: "get_available_models" })).models) : undefined;
    return { sessionId, model: publicModel(value.model), ...(models ? { models } : {}) };
  }
  if (message.op === "set_model") {
    if (changingModel || isBusy(await state())) throw new Error("session_busy");
    changingModel = true;
    try {
      const model = message.model as { provider: string; modelId: string };
      const available = await client.send<{ models: unknown }>({ type: "get_available_models" });
      if (!publicModels(available.models).some(value => value.provider === model.provider && value.modelId === model.modelId)) throw new Error("model_unavailable");
      if (isBusy(await state())) throw new Error("session_busy");
      await client.send({ type: "set_model", provider: model.provider, modelId: model.modelId });
      const confirmed = publicModel((await state()).model);
      if (!confirmed || confirmed.provider !== model.provider || confirmed.modelId !== model.modelId) throw new Error("model_unconfirmed");
      return { sessionId, model: confirmed };
    } finally { changingModel = false; }
  }
  if (message.op === "prompt") {
    if (changingModel || isBusy(await state())) throw new Error("session_busy");
    if (typeof message.message !== "string" || !message.message.trim()) throw new Error("invalid_frame");
    busy = true;
    try {
      const result = await client.send<{ agentInvoked?: boolean }>({ type: "prompt", message: message.message });
      if (result?.agentInvoked === false) busy = false;
    }
    catch (error) { busy = false; throw error; }
    return { sessionId, queued: true };
  }
  if (message.op === "abort") { await state(); await client.abort(); return { stopped: true }; }
  if (message.op === "ui_response") {
    await state();
    const id = String(message.requestId);
    if (!pendingUi.has(id)) throw new Error("unknown_ui_request");
    client.respondToUi(id.slice(config.instanceId.length + 1), message.response as UiDialogResponse);
    pendingUi.delete(id);
    return { acknowledged: true };
  }
  throw new Error("unsupported_background_operation");
}

const server = createServer(socket => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("close", () => listeners.delete(socket));
  socket.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 256 * 1024) { socket.destroy(); return; }
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      void request(message, socket).then(data => socket.write(JSON.stringify({ id: message.id, ok: true, data }) + "\n"), error => {
        const reason = error instanceof Error ? error.message : "background_error";
        const code = reason === "session_busy" ? "session_busy" : reason.includes("unavailable") ? "invalid_frame" : "internal_error";
        socket.write(JSON.stringify({ id: message.id, ok: false, error: { code, message: "后台请求未完成，请刷新状态后确认；不会自动重发。" } }) + "\n");
      });
    }
  });
});

try {
  await saveStatus(`waiting_omp ${process.pid}`);
  await client.start();
  ready = true;
  await state();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(config.socketPath, listening.resolve);
  await listening.promise;
  await chmod(config.socketPath, 0o600);
  await saveStatus(`waiting_omp ${process.pid}`);
} catch (error) {
  await saveStatus(`exited ${process.pid} 78`);
  await client.close();
  process.stderr.write(`${error instanceof Error ? error.message : "background_start_failed"}\n`);
  process.exit(78);
}

async function shutdown(): Promise<void> {
  ready = false;
  history.close();
  await client.close();
  await unlink(config.socketPath).catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
