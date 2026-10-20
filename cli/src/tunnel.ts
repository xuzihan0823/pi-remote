import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessGroup } from "./processes.ts";

export function tunnelURL(line: string): string | undefined {
  for (const match of line.matchAll(/https:\/\/[^\s|]+/g)) {
    const candidate = match[0].replace(/[.,;\)\]\}'\"><]+$/, "");
    let url: URL;
    try { url = new URL(candidate); } catch { continue; }
    if (/^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+trycloudflare\.com(?::443)?\/?$/.test(candidate)
      && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash) return url.origin;
  }
  return undefined;
}

export async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, signal: AbortSignal, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await probe();
    signal.throwIfAborted();
    if (result !== undefined) return result;
    await delay(300, undefined, { signal });
  }
  throw new Error(`${label}超时，请检查网络、端口与服务状态`);
}

export async function startTunnel(group: ProcessGroup, binary: string, port: number, tag: string, log: (line: string) => void): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-tunnel-"));
  const file = join(directory, "config.yml");
  await writeFile(file, "", { mode: 0o600 });
  let discovered: string | undefined;
  const cleanup = async (): Promise<void> => { await rm(directory, { recursive: true, force: true }); };
  try {
    group.start({ command: binary, args: ["--no-autoupdate", "tunnel", "--config", file, "--url", `http://127.0.0.1:${port}`], cwd: directory, env: process.env, tag }, (line) => {
      discovered ??= tunnelURL(line);
      log(line);
    });
    const url = await waitFor("获取 Cloudflare 公网地址", async () => discovered, group.signal, 60_000);
    return { url, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
