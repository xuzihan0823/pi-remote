import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultConfig, saveConfig, validateConfig, type CliConfig, type Service } from "./config.ts";

export async function configure(file: string, existing: CliConfig | null, service?: Service): Promise<CliConfig> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("首次配置需要交互终端，请在终端运行 pi-remote configure");
  const config = structuredClone(existing ?? defaultConfig());
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error("配置已取消"));
  rl.on("SIGINT", cancel);
  rl.on("close", cancel);
  const ask = async (label: string, fallback: string): Promise<string> => (await rl.question(`${label} [${fallback}]：`, { signal: controller.signal })).trim() || fallback;
  const askPath = async (label: string, fallback: string): Promise<string> => {
    const value = await ask(label, fallback);
    return resolve(value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value);
  };
  const secret = async (label: string): Promise<string> => {
    process.stdout.write(`${label}（输入不显示，留空保留）：`);
    muted = true;
    try { return (await rl.question("", { signal: controller.signal })).trim(); } finally { muted = false; process.stdout.write("\n"); }
  };
  try {
    config.service = service ?? await ask("启动服务 pi / claude / all", config.service) as Service;
    if (config.service === "pi" || config.service === "all") {
      config.pi.mode = await ask("Pi 连接方式 cloudflare / relay", config.pi.mode) as CliConfig["pi"]["mode"];
      config.pi.workspace = await askPath("Pi 默认工作区", config.pi.workspace);
      config.pi.deviceId = await ask("Pi 设备 ID", config.pi.deviceId);
      if (config.pi.mode === "relay") {
        config.pi.relayUrl = await ask("已有 Relay 地址（wss://服务器/ws/agent）", config.pi.relayUrl);
        const value = await secret("Relay 连接凭据");
        if (!value && (existing?.pi.mode !== "relay" || existing.pi.relayUrl !== config.pi.relayUrl)) throw new Error("首次连接或更换 Relay 时必须输入其凭据");
        if (value) config.pi.token = value;
      } else {
        if (existing?.pi.mode === "relay") config.pi.token = randomBytes(32).toString("hex");
        config.pi.port = Number(await ask("Pi 本机端口", String(config.pi.port)));
      }
    }
    if (config.service === "claude" || config.service === "all") {
      config.claude.executable = await ask("Claude CLI 命令或绝对路径", config.claude.executable);
      config.claude.port = Number(await ask("Claude 本机端口", String(config.claude.port)));
      config.claude.projectsDir = await askPath("Claude 会话目录", config.claude.projectsDir);
      config.claude.dataDir = await askPath("Claude Remote 数据目录", config.claude.dataDir);
    }
    controller.signal.throwIfAborted();
    validateConfig(config);
    await saveConfig(file, config);
    console.log(`配置已保存：${file}`);
    return config;
  } finally { rl.close(); }
}
