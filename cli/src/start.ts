import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopMcpClient } from "../../src/desktop/mcp-client.ts";
import { type CliConfig, validateConfig } from "./config.ts";
import { ProcessGroup, redact } from "./processes.ts";
import { claudePayload, health, piPayload, showPairing, verifyClaude, verifyPi } from "./pairing.ts";
import { startTunnel, waitFor } from "./tunnel.ts";

export async function executable(command: string): Promise<string> {
  const candidates = command.includes("/") ? [resolve(command)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw new Error(`找不到可执行命令 ${command}，请先安装或修改配置`);
}
export async function availablePort(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`端口 ${port} 已被占用或不可用，请关闭原服务或修改配置`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolvePromise()));
  });
}
function baseFromAgent(agent: string): string {
  const url = new URL(agent); url.protocol = url.protocol === "wss:" ? "https:" : "http:"; url.pathname = "/"; return url.origin;
}
function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PI_|RELAY_|AGENT_|BRIDGE_)/.test(key)
    && !["INTERACTIONS_DB_PATH", "UPLOADS_DIR", "CLAUDE_PROJECTS_DIR", "CLAUDE_BIN", "NODE_OPTIONS", "NODE_PATH"].includes(key)));
}

export async function start(configuration: CliConfig): Promise<void> {
  if (process.platform === "win32") throw new Error("第一版 CLI 支持 macOS 和 Linux；Windows 请通过 WSL 运行");
  const config = validateConfig(configuration);
  const pi = config.service !== "claude", claude = config.service !== "pi";
  const group = new ProcessGroup();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const cancel = (): void => group.cancel();
  for (const signal of signals) process.on(signal, cancel);
  const secrets = [config.pi.token, config.claude.token];
  const log = (tag: string) => (line: string): void => console.log(`[${tag}] ${redact(line, secrets)}`);
  const cleanup: (() => Promise<void>)[] = [];
  const runtime = (name: string): string => fileURLToPath(new URL(`./services/${name}.js`, import.meta.url));
  const environment = cleanEnvironment();
  try {
    const tunnelBinary = claude || (pi && config.pi.mode === "cloudflare")
      ? await executable(process.env.PI_REMOTE_CLOUDFLARED || "cloudflared") : "";
    const claudeBinary = claude ? await executable(config.claude.executable) : "";
    if (pi && config.pi.mode === "cloudflare") await availablePort(config.pi.port);
    if (claude) await availablePort(config.claude.port);
    if (pi) {
      if (!(await stat(config.pi.workspace)).isDirectory()) throw new Error("Pi 工作区不是目录");
      const desktop = new DesktopMcpClient({ timeoutMs: 5000 });
      try { await desktop.call("pi_project_list"); } finally { await desktop.close(); }
      group.signal.throwIfAborted();
    }
    if (claude) {
      await mkdir(config.claude.dataDir, { recursive: true, mode: 0o700 });
      await mkdir(config.claude.projectsDir, { recursive: true, mode: 0o700 });
    }
    const ready: { label: string; base: string; payload: string }[] = [];
    if (pi) {
      const localBase = `http://127.0.0.1:${config.pi.port}`;
      const agentURL = config.pi.mode === "relay" ? config.pi.relayUrl : `ws://127.0.0.1:${config.pi.port}/ws/agent`;
      const env = { ...environment, RELAY_HOST: "127.0.0.1", RELAY_PORT: String(config.pi.port), RELAY_TOKEN: config.pi.token, AGENT_TOKEN: config.pi.token, RELAY_URL: agentURL, AGENT_DEVICE_ID: config.pi.deviceId, PI_WORKSPACE_ROOT: config.pi.workspace };
      if (config.pi.mode === "cloudflare") {
        group.start({ command: process.execPath, args: [runtime("relay")], cwd: config.pi.workspace, env, tag: "pi-relay" }, log("pi-relay"));
        await waitFor("等待本机 Relay", async () => (await health(localBase, config.pi.token, group.signal))?.status === "ok" ? true : undefined, group.signal);
      }
      if (config.pi.mode === "relay") {
        const status = await waitFor("连接已有 Relay", () => health(baseFromAgent(agentURL), config.pi.token, group.signal, "/api/status"), group.signal);
        if (status.agentConnected === true) throw new Error("已有 Relay 正连接其他 Agent，请先停止原 Agent");
      }
      group.start({ command: process.execPath, args: [runtime("agent")], cwd: config.pi.workspace, env, tag: "pi-agent" }, log("pi-agent"));
      let base = baseFromAgent(agentURL), pairingAgentURL = agentURL;
      await verifyPi(base, config.pi.token, config.pi.deviceId, group.signal);
      if (config.pi.mode === "cloudflare") {
        const tunnel = await startTunnel(group, tunnelBinary, config.pi.port, "pi-tunnel", log("pi-tunnel"));
        cleanup.push(tunnel.cleanup); base = tunnel.url;
        await verifyPi(base, config.pi.token, config.pi.deviceId, group.signal);
        pairingAgentURL = `${base.replace(/^https:/, "wss:")}/ws/agent`;
      }
      ready.push({ label: "Pi Remote", base, payload: piPayload(pairingAgentURL, config.pi.token) });
    }
    if (claude) {
      const instanceId = randomUUID(), localBase = `http://127.0.0.1:${config.claude.port}`;
      group.start({ command: process.execPath, args: [runtime("claude/src/index")], cwd: config.claude.dataDir, env: {
        ...environment, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(config.claude.port), BRIDGE_TOKEN: config.claude.token, BRIDGE_INSTANCE_ID: instanceId,
        CLAUDE_BIN: claudeBinary, CLAUDE_PROJECTS_DIR: config.claude.projectsDir, INTERACTIONS_DB_PATH: join(config.claude.dataDir, "interactions.sqlite"), UPLOADS_DIR: join(config.claude.dataDir, "uploads"),
      }, tag: "claude", killGraceMs: 8000 }, log("claude"));
      await verifyClaude(localBase, config.claude.token, instanceId, group.signal);
      const tunnel = await startTunnel(group, tunnelBinary, config.claude.port, "claude-tunnel", log("claude-tunnel"));
      cleanup.push(tunnel.cleanup);
      await verifyClaude(tunnel.url, config.claude.token, instanceId, group.signal);
      ready.push({ label: "Claude Remote", base: tunnel.url, payload: claudePayload(tunnel.url, config.claude.token) });
    }
    group.signal.throwIfAborted();
    for (const item of ready) await showPairing(item.label, item.base, item.payload);
    console.log("服务运行中，按 Ctrl+C 退出。Quick Tunnel 重启后地址会改变，需要重新扫码。");
    await new Promise<void>((resolvePromise) => {
      if (group.signal.aborted) resolvePromise();
      else group.signal.addEventListener("abort", () => resolvePromise(), { once: true });
    });
    if (group.failure) throw group.failure;
  } catch (error) {
    if (group.failure) throw group.failure;
    if (!group.signal.aborted) throw error;
  } finally {
    await group.stop();
    await Promise.all(cleanup.map((fn) => fn()));
    for (const signal of signals) process.removeListener(signal, cancel);
  }
}
