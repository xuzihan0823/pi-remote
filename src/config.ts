import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface Config {
  relayHost: string;
  relayPort: number;
  relayToken: string;
  relayUrl: string;
  agentToken: string;
  agentDeviceId: string;
  piBin: string;
  piWorkspaceRoot: string;
  maxSessions: number;
}

export const DEFAULT_PI_BIN = "pi";
export const DEFAULT_RELAY_HOST = "127.0.0.1";
export const DEFAULT_RELAY_PORT = 8789;
export const MIN_RELAY_TOKEN_LENGTH = 32;
export const DEFAULT_MAX_SESSIONS = 16;
export const MAX_MAX_SESSIONS = 128;
export const DEFAULT_AGENT_DEVICE_ID = "pi-mac-agent";
export const MAX_AGENT_DEVICE_ID_LENGTH = 128;
const AGENT_DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class ConfigError extends Error {
  readonly code = "invalid_config";

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultWorkspaceRoot(): string {
  return join(homedir(), "Desktop");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const relayHost = (env.RELAY_HOST ?? DEFAULT_RELAY_HOST).trim();
  if (relayHost.length === 0) {
    throw new ConfigError("RELAY_HOST must not be empty");
  }
  if (/[\s/]/.test(relayHost) || relayHost.includes("://")) {
    throw new ConfigError(`RELAY_HOST must be a bare host or IP without scheme or path, got ${JSON.stringify(relayHost)}`);
  }
  const colonCount = relayHost.split(":").length - 1;
  if (colonCount === 1 && !relayHost.startsWith("[")) {
    throw new ConfigError(`RELAY_HOST must not include a port, got ${JSON.stringify(relayHost)}`);
  }

  const relayPort = parseInteger(env.RELAY_PORT, DEFAULT_RELAY_PORT, "RELAY_PORT", 1, 65535);

  const rawToken = env.RELAY_TOKEN;
  if (rawToken === undefined || rawToken.trim().length === 0) {
    throw new ConfigError(`RELAY_TOKEN is required and must be at least ${MIN_RELAY_TOKEN_LENGTH} characters`);
  }
  const relayToken = rawToken.trim();
  if (relayToken.length < MIN_RELAY_TOKEN_LENGTH) {
    throw new ConfigError(`RELAY_TOKEN must be at least ${MIN_RELAY_TOKEN_LENGTH} characters`);
  }

  const relayUrl = parseRelayUrl(env.RELAY_URL, relayHost, relayPort);
  const agentToken = parseToken(env.AGENT_TOKEN, "AGENT_TOKEN") ?? relayToken;
  const agentDeviceId = parseAgentDeviceId(env.AGENT_DEVICE_ID);

  const piBin = (env.PI_BIN ?? DEFAULT_PI_BIN).trim();
  if (piBin.length === 0) {
    throw new ConfigError("PI_BIN must not be empty");
  }

  const rawWorkspaceRoot = (env.PI_WORKSPACE_ROOT ?? "").trim();
  const piWorkspaceRoot = rawWorkspaceRoot.length > 0 ? rawWorkspaceRoot : defaultWorkspaceRoot();
  if (!isAbsolute(piWorkspaceRoot)) {
    throw new ConfigError(`PI_WORKSPACE_ROOT must be an absolute path, got ${JSON.stringify(piWorkspaceRoot)}`);
  }
  const resolvedWorkspaceRoot = resolve(piWorkspaceRoot);
  if (resolvedWorkspaceRoot === "/") {
    throw new ConfigError("PI_WORKSPACE_ROOT must not be the filesystem root");
  }

  const maxSessions = parseInteger(env.MAX_SESSIONS, DEFAULT_MAX_SESSIONS, "MAX_SESSIONS", 1, MAX_MAX_SESSIONS);

  return {
    relayHost,
    relayPort,
    relayToken,
    relayUrl,
    agentToken,
    agentDeviceId,
    piBin,
    piWorkspaceRoot: resolvedWorkspaceRoot,
    maxSessions,
  };
}

/**
 * Log-safe one-line summary. It must never include a token, and RELAY_URL is validated to
 * reject embedded tokens, so the result is safe to print.
 */
export function describeConfig(config: Config): string {
  return [
    `relayUrl=${config.relayUrl}`,
    `agentDeviceId=${config.agentDeviceId}`,
    `piBin=${config.piBin}`,
    `workspaceRoot=${config.piWorkspaceRoot}`,
    `maxSessions=${config.maxSessions}`,
  ].join(" ");
}

function parseRelayUrl(raw: string | undefined, host: string, port: number): string {
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    return `ws://${host}:${port}/ws/agent`;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`RELAY_URL must be a valid ws:// or wss:// URL, got ${JSON.stringify(text)}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ConfigError(`RELAY_URL must use ws:// or wss://, got ${JSON.stringify(url.protocol)}`);
  }
  if (url.hostname.length === 0) {
    throw new ConfigError("RELAY_URL must include a host");
  }
  if (url.searchParams.has("token")) {
    throw new ConfigError("RELAY_URL must not embed a token; use AGENT_TOKEN or RELAY_TOKEN instead");
  }
  return url.toString();
}

function parseToken(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const token = raw.trim();
  if (token.length < MIN_RELAY_TOKEN_LENGTH) {
    throw new ConfigError(`${name} must be at least ${MIN_RELAY_TOKEN_LENGTH} characters`);
  }
  return token;
}

function parseAgentDeviceId(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (text.length === 0) return DEFAULT_AGENT_DEVICE_ID;
  if (text.length > MAX_AGENT_DEVICE_ID_LENGTH) {
    throw new ConfigError(`AGENT_DEVICE_ID must be at most ${MAX_AGENT_DEVICE_ID_LENGTH} characters`);
  }
  if (!AGENT_DEVICE_ID_PATTERN.test(text)) {
    throw new ConfigError(
      `AGENT_DEVICE_ID must start with a letter or digit and contain only letters, digits, ".", "_", ":" or "-", got ${JSON.stringify(text)}`,
    );
  }
  return text;
}

function parseInteger(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  const text = (raw ?? String(fallback)).trim();
  if (!/^\d+$/.test(text)) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  const value = Number(text);
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}
