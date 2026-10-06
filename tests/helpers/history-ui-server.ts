import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import bridgeExtension, { type PiMessage, type PiSessionEntry } from "../../src/terminal/extension.ts";
import { TerminalSessionBridge } from "../../src/terminal/bridge-client.ts";
import { OmpHistoryIndex } from "../../src/history/history-index.ts";
import { PiProcessManager } from "../../src/pi/process-manager.ts";
import { createPiAgentHandler } from "../../src/agent/pi-agent-handler.ts";
import { AgentClient } from "../../src/agent/agent-client.ts";
import { startTestServer, TEST_TOKEN } from "./relay-harness.ts";

const dir = mkdtempSync("/private/tmp/pi-hui-");
const workspace = join(dir, "workspace");
const archiveRoot = join(dir, "sessions");
const bucket = join(archiveRoot, "synthetic-workspace");
const bridgeDir = join(dir, "bridge");
mkdirSync(workspace, { mode: 0o700 }); mkdirSync(bucket, { mode: 0o700, recursive: true });
process.env.PI_REMOTE_BRIDGE_DIR = bridgeDir;
const markdown = "## 合成 Markdown 验收\n\n**粗体保持正常**\n\n7. 第一项\n   列表续行\n   - 嵌套子项\n8. 第二项\n\n````swift\nlet value = \"中文😀\"\n~~~\n```\n````\n\n| 第一列 | 第二列 |\n| --- | --- |\n| a\\|b | 中文 |\n\n最后一条合成消息";
const entries = (count: number): PiSessionEntry[] => Array.from({ length: count }, (_, i) => ({
  type: "message", id: `entry-${i}`, parentId: i === 0 ? null : `entry-${i - 1}`,
  message: { role: "assistant", content: [{ type: "text", text: `合成消息 ${i}：用于验证阅读锚点，中文正文与 emoji 😀。` }] },
}));
const archived = entries(120);
archived.push({ type: "message", id: "sibling", parentId: "entry-60",
  message: { role: "assistant", content: [{ type: "text", text: "合成兄弟分支，仅在选择该分支后可见。" }] } });
archived.push({ type: "message", id: "tool", parentId: "entry-119", message: { role: "assistant", content: [
  { type: "toolCall", id: "fixture-call", name: "read", arguments: { path: "synthetic.txt", apiKey: "synthetic-hidden-key" } }] } });
archived.push({ type: "message", id: "tool-result", parentId: "tool", message: { role: "toolResult", toolCallId: "fixture-call", toolName: "read", content: [{ type: "text", text: "合成工具结果，不执行真实工具。" }], isError: false } });
archived.push({ type: "message", id: "markdown", parentId: "tool-result", message: { role: "assistant", content: [{ type: "text", text: markdown }] } });
const archiveFile = join(bucket, "2026-10-07_fixture.jsonl");
writeFileSync(archiveFile, [{ type: "title", title: "合成历史会话", v: 1 },
  { type: "session", version: 3, id: "ui-archive-fixture", cwd: workspace, timestamp: "2026-10-07T00:00:00Z" }, ...archived]
  .map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
let liveEntries = entries(90);
let idle = true;
let controlCalls = 0;
const handlers = new Map<string, ((event: { type: string; message?: PiMessage }, ctx: typeof context) => unknown)[]>();
const context = { hasUI: true, mode: "tui", cwd: workspace,
  sessionManager: { getSessionId: () => "ui-live-fixture", getSessionFile: () => undefined, getSessionName: () => "合成实时会话", getBranch: () => liveEntries },
  ui: { notify: () => {} }, isIdle: () => idle, abort: () => { controlCalls++; } };
bridgeExtension({ on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, sendUserMessage: () => { controlCalls++; } });
for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, context);
const bridge = new TerminalSessionBridge({ workspaceRoot: workspace, bridgeDir });
const history = new OmpHistoryIndex({ workspaceRoot: workspace, roots: [archiveRoot] });
await history.ready();
for (let i = 0; i < 100 && !(await bridge.list()).length; i++) await delay(10);
if (!(await bridge.list()).length) throw new Error("Synthetic terminal socket did not become ready");
const manager = new PiProcessManager({ piBin: "synthetic-no-execution", spawnFn: () => { throw new Error("Synthetic fixture forbids process execution"); } });
const relayLog: string[] = [];
const { server } = await startTestServer({ relayPort: 18789, piWorkspaceRoot: workspace },
  { logger: message => { relayLog.push(message); if (relayLog.length > 100) relayLog.shift(); } });
const client = new AgentClient({ url: "ws://127.0.0.1:18789/ws/agent", token: TEST_TOKEN, deviceId: "synthetic-ui-agent",
  handler: createPiAgentHandler({ manager, workspaceRoot: workspace, terminalBridge: bridge, history }) });
await client.connect();
const controller = createServer((request, response) => {
  if (request.url === "/append" && request.method === "POST") {
    const previous = liveEntries.at(-1)?.id ?? null;
    liveEntries.push({ type: "message", id: `append-${liveEntries.length}`, parentId: previous,
      message: { role: "assistant", content: [{ type: "text", text: `新到达合成消息 ${liveEntries.length}，不应抢走旧消息阅读位置。` }] } });
  } else if (request.url === "/reset" && request.method === "POST") {
    liveEntries = entries(90); idle = true; controlCalls = 0;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ ready: true, controlCalls, liveMessages: liveEntries.length, relayLog }));
});
await new Promise<void>((resolveListen, reject) => { controller.once("error", reject); controller.listen(18790, "127.0.0.1", resolveListen); });
console.log("SYNTHETIC_HISTORY_UI_READY");
let closing = false;
async function close(): Promise<void> {
  if (closing) return; closing = true;
  client.disconnect(); history.close(); bridge.close();
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, context);
  await manager.closeAll(); await server.stop();
  controller.close(); rmSync(dir, { recursive: true, force: true });
}
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
