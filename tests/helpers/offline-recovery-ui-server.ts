import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AgentClient } from "../../src/agent/agent-client.ts";
import { createPiAgentHandler } from "../../src/agent/pi-agent-handler.ts";
import { OmpHistoryIndex } from "../../src/history/history-index.ts";
import { PiProcessManager } from "../../src/pi/process-manager.ts";
import { TerminalSessionBridge } from "../../src/terminal/bridge-client.ts";
import { TerminalSessionLauncher } from "../../src/terminal/launcher.ts";
import { HistoryRecoveryCoordinator } from "../../src/terminal/history-recovery.ts";
import { sessionOwnerPids } from "../../src/terminal/session-owner.ts";
import { startTestServer, TEST_TOKEN } from "./relay-harness.ts";

const root = await realpath(process.argv[2]!);
const bucket = join(root, "sessions", "synthetic");
const files = (await readdir(bucket)).filter(name => name.endsWith(".jsonl"));
assert.equal(files.length, 1);
const file = join(bucket, files[0]!);
const original = await readFile(file, "utf8");
const header = JSON.parse(original.split("\n")[1]!);
const originalRows: Record<string, any>[] = original.split("\n").filter(Boolean).map(line => JSON.parse(line));
const workspaceRoot = await realpath(header.cwd as string);
const relayHost = process.argv[5] ?? "127.0.0.1";
assert.deepEqual(await sessionOwnerPids({ file, id: header.id }), [], "original OMP must actually be exited before the iOS test");
const bridgeDir = process.argv[3]!;
const bridge = new TerminalSessionBridge({ workspaceRoot, bridgeDir });
assert.deepEqual(await bridge.instances(), [], "no pre-started PTY/bridge is allowed");
const history = new OmpHistoryIndex({ workspaceRoot, roots: [join(root, "sessions")] });
await history.ready();
const manager = new PiProcessManager({ piBin: "/Users/mac/.local/bin/omp" });
let launchCount = 0;
const launcher = new TerminalSessionLauncher({ piBin: "/Users/mac/.local/bin/omp", workspaceRoot, bridge,
  spawnFn: (command, args, options) => { launchCount++; return spawn(command, args, options); } });
const recovery = new HistoryRecoveryCoordinator({ history, bridge, launcher, workspaceRoot, directory: join(root, process.argv[4] ?? "ui-operations") });
bridge.setControlGuard(meta => recovery.canControl(meta));
const { server } = await startTestServer({ relayHost, relayPort: 18849, piWorkspaceRoot: workspaceRoot });
let promptCount = 0;
let abortCount = 0;
let approvalCount = 0;
const handler = createPiAgentHandler({ manager, workspaceRoot, terminalBridge: bridge, terminalLauncher: launcher, history, recovery, runtime: "omp" });
const client = new AgentClient({ url: `ws://${relayHost}:18849/ws/agent`, token: TEST_TOKEN, deviceId: "real-offline-ui-agent", handler: async request => {
  if (request.payload.method === "session.prompt") promptCount++;
  if (request.payload.method === "session.abort") abortCount++;
  if (request.payload.method === "ui.response") approvalCount++;
  return handler(request);
} });
await client.connect();
const controller = createServer(async (request, response) => {
  try {
    if (request.url !== "/state") { response.writeHead(404); response.end(); return; }
    const instances = await bridge.instances();
    const body = await readFile(file, "utf8");
    const afterHeader = JSON.parse(body.split("\n")[1]!);
    const rows: Record<string, any>[] = body.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const originalEntriesPreserved = originalRows.slice(2).every(originalEntry => rows.some(entry => entry.id === originalEntry.id && JSON.stringify(entry) === JSON.stringify(originalEntry)));
    const noNewUserMessages = rows.filter(entry => entry.type === "message" && entry.message?.role === "user").length === originalRows.filter(entry => entry.type === "message" && entry.message?.role === "user").length;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ launchCount, promptCount, abortCount, approvalCount,
      originalUnchanged: original === body, samePersistedId: afterHeader.id === header.id,
      originalEntriesPreserved, noNewUserMessages,
      uniqueExactInstance: instances.length === 1 && instances[0]!.persistedSessionId === header.id && instances[0]!.persistedSessionFile === file,
      sessionId: instances[0]?.sessionId, instanceCount: instances.length,
      noHistoryCopies: (await readdir(bucket)).filter(name => name.endsWith(".jsonl")).length === 1,
      promptPersisted: body.includes("OFFLINE_RESUME_OK"), abortPromptPersisted: body.includes("OFFLINE_ABORT_CHECK"),
      activity: instances[0]?.activity,
    }));
  } catch { response.writeHead(500); response.end("fixture observation failed"); }
});
await new Promise<void>((resolve, reject) => { controller.once("error", reject); controller.listen(18850, relayHost, resolve); });
console.log("REAL_OFFLINE_HISTORY_UI_READY");
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  launcher.close(); recovery.close(); bridge.close(); history.close();
  await client.disconnect(); await manager.closeAll();
  await new Promise<void>(resolve => controller.close(() => resolve()));
  await server.stop();
}
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
