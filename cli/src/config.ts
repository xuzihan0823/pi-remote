import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";

export type Service = "pi" | "claude" | "all";
export interface CliConfig {
  version: 1;
  service: Service;
  pi: { mode: "cloudflare" | "relay"; port: number; workspace: string; deviceId: string; relayUrl: string; token: string };
  claude: { port: number; executable: string; projectsDir: string; dataDir: string; token: string };
}

export function configPath(): string {
  const base = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Pi Remote", "CLI")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-remote");
  return join(base, "config.json");
}

export function defaultConfig(): CliConfig {
  const dataDir = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Pi Remote", "Claude")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "share"), "pi-remote", "claude");
  return {
    version: 1, service: "all",
    pi: { mode: "cloudflare", port: 8789, workspace: join(homedir(), "Desktop"), deviceId: "pi-mac-agent", relayUrl: "", token: randomBytes(32).toString("hex") },
    claude: { port: 8788, executable: "claude", projectsDir: join(homedir(), ".claude", "projects"), dataDir, token: randomBytes(32).toString("hex") },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} 无效`);
  return value;
}
function path(value: unknown, name: string): string {
  const result = text(value, name);
  if (!isAbsolute(result) || normalize(result) === "/") throw new Error(`${name} 必须是非根目录的绝对路径`);
  return normalize(result);
}
function port(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error("端口必须在 1–65535 之间");
  return value;
}
function token(value: unknown): string {
  const result = text(value, "连接凭据");
  if (result.length < 32 || /\s/u.test(result)) throw new Error("连接凭据至少 32 个字符，且不能包含空白");
  return result;
}
export function relayURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Relay 地址无效"); }
  if (!(url.protocol === "wss:" || (url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/ws/agent") {
    throw new Error("Relay 地址应为 wss://服务器/ws/agent，不能包含凭据、查询参数或片段（本机可用 ws）");
  }
  return url;
}
export function validateConfig(value: unknown): CliConfig {
  const raw = record(value), pi = record(raw.pi), claude = record(raw.claude);
  if (raw.version !== 1 || !["pi", "claude", "all"].includes(String(raw.service))) throw new Error("配置版本或服务类型无效");
  if (pi.mode !== "cloudflare" && pi.mode !== "relay") throw new Error("Pi 连接方式无效");
  const deviceId = text(pi.deviceId, "设备 ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) throw new Error("设备 ID 格式无效");
  const relayUrl = text(pi.relayUrl, "Relay 地址");
  if (pi.mode === "relay") relayURL(relayUrl);
  const executable = text(claude.executable, "Claude 命令");
  if (!executable.trim()) throw new Error("Claude 命令不能为空");
  const result: CliConfig = {
    version: 1, service: raw.service as Service,
    pi: { mode: pi.mode, port: port(pi.port), workspace: path(pi.workspace, "Pi 工作区"), deviceId, relayUrl, token: token(pi.token) },
    claude: { port: port(claude.port), executable, projectsDir: path(claude.projectsDir, "Claude 会话目录"), dataDir: path(claude.dataDir, "Claude 数据目录"), token: token(claude.token) },
  };
  if (result.service === "all" && result.pi.mode === "cloudflare" && result.pi.port === result.claude.port) throw new Error("Pi 和 Claude 不能使用同一端口");
  return result;
}
async function safeDirectory(directory: string): Promise<void> {
  const parent = dirname(directory);
  if (parent !== directory) await safeDirectory(parent);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("配置路径不能经过符号链接");
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid && info.uid !== 0) throw new Error("配置目录不属于当前用户或系统");
  if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) throw new Error("配置目录不能允许其他用户写入");
}
async function safeExisting(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    const parent = await lstat(dirname(file));
    if (parent.isSymbolicLink()) throw new Error("配置目录不能是符号链接");
    await safeDirectory(await realpath(dirname(file)));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("配置必须是仅当前用户可读写的普通文件（权限 600）");
    if (process.getuid && info.uid !== process.getuid()) throw new Error("配置文件不属于当前用户");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function loadConfig(file: string): Promise<CliConfig | null> {
  await safeExisting(file);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("配置文件权限或大小无效");
    let parsed: unknown;
    try { parsed = JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error("配置文件不是有效 JSON，请检查文件格式"); }
    return validateConfig(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close(); }
}
export async function saveConfig(file: string, config: CliConfig): Promise<void> {
  const validated = validateConfig(config);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("配置目录必须是真实目录");
  await safeDirectory(await realpath(dirname(file)));
  await safeExisting(file);
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await safeExisting(file);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
