import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { terminalEnvironment } from "../terminal/launcher.ts";

const execute = promisify(execFile);

export function systemHttpsProxy(output: string): string | undefined {
  const value = (key: string) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim();
  const scheme = value("HTTPSEnable") === "1" ? "HTTPS" : value("HTTPEnable") === "1" ? "HTTP" : undefined;
  if (!scheme) return undefined;
  const host = value(`${scheme}Proxy`);
  const port = Number(value(`${scheme}Port`));
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  try {
    return new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`).origin;
  } catch { return undefined; }
}

export async function backgroundEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readProxy = async () => (await execute("/usr/sbin/scutil", ["--proxy"], { timeout: 2_000, maxBuffer: 64 * 1024 })).stdout,
): Promise<Record<string, string>> {
  const env = terminalEnvironment();
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (/^PI_PROXY(?:_[A-Z0-9_]+)?$/.test(key) ||
      /^(?:https?_proxy|all_proxy|no_proxy)$/i.test(key) || key === "NODE_EXTRA_CA_CERTS" || key === "PI_REMOTE_SUPERVISOR_PID")) {
      env[key] = value;
    }
  }
  const explicit = source.HTTPS_PROXY ?? source.https_proxy ?? source.HTTP_PROXY ?? source.http_proxy ?? source.ALL_PROXY ?? source.all_proxy;
  if (env.PI_PROXY === undefined && explicit !== undefined) env.PI_PROXY = explicit;
  if (env.PI_PROXY === undefined && platform === "darwin") {
    const proxy = await readProxy().then(systemHttpsProxy).catch(() => undefined);
    if (proxy) env.PI_PROXY = proxy;
  }
  return env;
}
