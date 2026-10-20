import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { configPath, loadConfig, type Service } from "./config.ts";
import { configure } from "./configure.ts";
import { start } from "./start.ts";
import { redact } from "./processes.ts";

const help = `Pi Remote CLI 0.1.0

用法：
  pi-remote start [--service pi|claude|all] [--config 文件]
  pi-remote configure [--service pi|claude|all] [--config 文件]
  pi-remote --help
  pi-remote --version

首次启动会交互配置；后续复用配置。服务在前台运行，Ctrl+C 统一退出。
公网访问使用 Cloudflare Quick Tunnel（需安装 cloudflared）。
Pi 仍需运行启用了本机 MCP 的 Pi Desktop；Claude 需安装并登录 Claude CLI。
Quick Tunnel 每次重启地址会改变，需要重新扫码。
`;

let secrets: string[] = [];
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    config: { type: "string" }, service: { type: "string" },
  }, allowPositionals: true });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log("0.1.0"); return; }
  const command = positionals[0];
  if (positionals.length > 1 || !command || !["start", "configure"].includes(command)) throw new Error(help);
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("需要 Node.js 24 或更高版本");
  if (values.service && !["pi", "claude", "all"].includes(values.service)) throw new Error("--service 必须是 pi、claude 或 all");
  const service = values.service as Service | undefined;
  const file = values.config ? resolve(values.config) : configPath();
  let config = await loadConfig(file);
  if (config) secrets = [config.pi.token, config.claude.token];
  if (command === "configure" || !config) config = await configure(file, config, service);
  secrets = [config.pi.token, config.claude.token];
  if (command === "start") await start(service ? { ...config, service } : config);
}
main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error), secrets));
  process.exitCode = 1;
});
