// daemon 配置：环境变量 → 结构化配置。
//
// 缺 BRIDGE_TOKEN 抛 ConfigError 由入口拒绝启动；数值变量非法同样拒启
// （静默回退默认值会掩盖配置错误，宁可启动失败）。
//
// 安全：token 直接读原始 env（不经 trim），30+ 空白或短 token 一律拒启，
// 且任何错误信息都不得回显 token 内容。

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

export class ConfigError extends Error {}

export interface DaemonConfig {
  token: string;
  host: string;
  port: number;
  projectsDir: string;
  /** 手机端上传文件的落盘目录（daemon 按 sessionId 分子目录）。 */
  uploadsDir: string;
  cooldownMs: number;
  interactionsDbPath: string;
  permissionTimeoutMs: number;
  /** 配对二维码额外候选地址（如 Cloudflare 隧道），排在自动枚举的局域网地址之前。 */
  publicBases: string[];
  /**
   * 进程实例标识（health 端点用）。BRIDGE_INSTANCE_ID 或随机 UUID。
   * 可选仅为兼容既有测试 fixture；loadConfig 永远返回具体值。
   */
  instanceId?: string;
  barkUrl?: string;
  ntfyUrl?: string;
}

const MIN_TOKEN_LENGTH = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got: ${raw}`);
  }
  return value;
}

/**
 * token 读原始 env：trim 会把 " abc " 之类的空白配置洗成看似合法的值，
 * 掩盖配置错误。这里按原样校验：非空、长度 >=32、不含任何空白字符。
 * 错误信息不回显 token 内容。
 */
function readToken(env: NodeJS.ProcessEnv): string {
  const raw = env.BRIDGE_TOKEN;
  if (raw === undefined || raw === "") {
    throw new ConfigError("BRIDGE_TOKEN is required (>=32 chars); refusing to start");
  }
  if (/\s/.test(raw)) {
    throw new ConfigError("BRIDGE_TOKEN must not contain whitespace; refusing to start");
  }
  if (raw.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`BRIDGE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters; refusing to start`);
  }
  return raw;
}

/** BRIDGE_INSTANCE_ID 必须是严格 UUID；缺省时随机生成。 */
function readInstanceId(env: NodeJS.ProcessEnv): string {
  const raw = readString(env, "BRIDGE_INSTANCE_ID");
  if (raw === undefined) return randomUUID();
  if (!UUID_RE.test(raw)) {
    throw new ConfigError("BRIDGE_INSTANCE_ID must be a UUID; refusing to start");
  }
  return raw;
}

/** state 根：macOS 用 Application Support；其他平台遵循 XDG（缺省 ~/.local/share）。 */
export function stateRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Pi Remote", "Claude");
  }
  const xdgState = readString(env, "XDG_STATE_HOME");
  const base = xdgState !== undefined && isAbsolute(xdgState) ? xdgState : join(homedir(), ".local", "share");
  return join(base, "pi-remote", "claude");
}

/**
 * 路径型 env：NUL 拒启；相对路径锚定 state 根（而非 cwd），保证不同工作目录下
 * 解析到同一位置。:memory: 由调用方自行放行。
 */
function readPath(env: NodeJS.ProcessEnv, key: string, baseDir: string): string | undefined {
  const raw = readString(env, key);
  if (raw === undefined) return undefined;
  if (raw.includes("\0")) throw new ConfigError(`${key} must not contain NUL bytes`);
  return resolve(isAbsolute(raw) ? raw : join(baseDir, raw));
}

/**
 * BRIDGE_PUBLIC_BASES：逗号分隔的候选地址。仅保留 http/https 且无 userinfo 的 URL
 * （userinfo 会把凭据写进二维码/日志），去掉末尾斜杠。
 */
function readPublicBases(env: NodeJS.ProcessEnv): string[] {
  const raw = readString(env, "BRIDGE_PUBLIC_BASES") ?? "";
  const bases: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.username !== "" || parsed.password !== "") continue;
    bases.push(trimmed.replace(/\/+$/, ""));
  }
  return [...new Set(bases)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const token = readToken(env);
  const port = readInt(env, "BRIDGE_PORT", 8788);
  if (port > 65535) throw new ConfigError(`BRIDGE_PORT out of range: ${port}`);

  const base = stateRoot(env);
  const rawDb = readString(env, "INTERACTIONS_DB_PATH");
  const dbPath = rawDb === ":memory:" ? ":memory:" : (readPath(env, "INTERACTIONS_DB_PATH", base) ?? join(base, "interactions.sqlite"));
  const barkUrl = readString(env, "BARK_URL");
  const ntfyUrl = readString(env, "NTFY_URL");
  return {
    token,
    host: readString(env, "BRIDGE_HOST") ?? "127.0.0.1",
    port,
    projectsDir: readPath(env, "CLAUDE_PROJECTS_DIR", base) ?? join(homedir(), ".claude", "projects"),
    uploadsDir: readPath(env, "UPLOADS_DIR", base) ?? join(base, "uploads"),
    cooldownMs: readInt(env, "ACTIVITY_COOLDOWN_MS", 120_000),
    interactionsDbPath: dbPath,
    permissionTimeoutMs: readInt(env, "PERMISSION_TIMEOUT_MS", 300_000),
    publicBases: readPublicBases(env),
    instanceId: readInstanceId(env),
    ...(barkUrl === undefined ? {} : { barkUrl }),
    ...(ntfyUrl === undefined ? {} : { ntfyUrl }),
  };
}
