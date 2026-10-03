// daemon 入口：配置 → 装配 → 监听 → 优雅退出。
//
// 装配关系（各卡交付物的接线）：
//   SessionWatcher --write--> ActivityTracker --change--> WS status 帧
//   TurnRunner --gate--> ActivityTracker（一行适配，见 reports/04-run.md）
//   TurnRunner --permissions--> ApprovalBridge --onEvent--> WS approval 帧 + 通知
//   DaemonServer 持有全部只读/驱动入口（HTTP + WS）
//
// 独立后端：不读 .env、不渲染终端二维码、不引导浏览器、不托管静态前端。
// token 只从进程环境读取，任何启动输出都不得包含 token。

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import process from "node:process";

import { InteractionManager, InteractionStore } from "./interactions/index.ts";

import { ConfigError, loadConfig } from "./config.ts";
import { ApprovalBridge, TurnRunner, createNotifier, type ActivityGate, type ApprovalEvent } from "./run/index.ts";
import { DaemonServer } from "./server.ts";
import { ActivityTracker } from "./watch/activity.ts";
import { SessionWatcher } from "./watch/watcher.ts";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

/** 启动时异步探测 claude CLI 版本；失败保持 "unknown"（health 端点用）。 */
function probeClaudeCliVersion(onResult: (version: string) => void): void {
  const bin = process.env.CLAUDE_BIN ?? "claude";
  execFile(bin, ["--version"], { timeout: 10_000 }, (error, stdout) => {
    if (error !== null) return;
    const version = stdout.trim();
    if (version !== "") onResult(version);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.interactionsDbPath !== ":memory:") {
    await mkdir(dirname(config.interactionsDbPath), { recursive: true });
  }
  const store = new InteractionStore(config.interactionsDbPath);
  const manager = new InteractionManager(store, { defaultTtlMs: config.permissionTimeoutMs });

  const watcher = new SessionWatcher({ projectsDir: config.projectsDir });
  const tracker = new ActivityTracker({ cooldownMs: config.cooldownMs });
  const gate: ActivityGate = {
    isIdle: (id) => tracker.getStatus(id) === "idle",
    beginRun: (id) => tracker.beginRun(id),
    endRun: (id) => tracker.endRun(id),
  };

  // server 在 bridge 之后创建；审批事件只会在 HTTP/WS 流量之后产生，届时 server 已就位。
  let server: DaemonServer;
  const approvals = new ApprovalBridge({
    manager,
    onEvent: (event: ApprovalEvent) => server.handleApprovalEvent(event),
  });
  const runner = new TurnRunner({
    gate,
    permissions: approvals,
    permissionTimeoutMs: config.permissionTimeoutMs,
  });
  const notifier = createNotifier({
    ...(config.barkUrl === undefined ? {} : { barkUrl: config.barkUrl }),
    ...(config.ntfyUrl === undefined ? {} : { ntfyUrl: config.ntfyUrl }),
  });

  let claudeCliVersion = "unknown";
  probeClaudeCliVersion((version) => {
    claudeCliVersion = version;
  });

  server = new DaemonServer({
    config,
    watcher,
    tracker,
    runner,
    approvals,
    notifier,
    version: pkg.version,
    claudeCliVersion: () => claudeCliVersion,
  });

  await server.listen();
  const { host, port } = server.address();
  console.log(`${pkg.name} ${pkg.version} listening on http://${host}:${port} (projects: ${config.projectsDir})`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      console.error("forced exit");
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`${signal} received, shutting down…`);
    void (async () => {
      try {
        await server.close(); // 停新连接、关 WS、abort 活跃 run 并等 settle
      } catch (error) {
        console.error("server close failed:", error);
      }
      watcher.close();
      tracker.dispose();
      manager.close();
      try {
        store.close();
      } catch (error) {
        console.error("store close failed:", error);
      }
      process.exit(0);
    })();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`config error: ${error.message}`);
  } else {
    console.error("daemon failed to start:", error);
  }
  process.exit(1);
});
