import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { TerminalBridgeError } from "./bridge-client.ts";

const run = promisify(execFile);

export async function sessionOwnerPids(target: { file: string; id: string }): Promise<number[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(target.id)) {
    throw new TerminalBridgeError("invalid_frame", "历史 ID 无法安全检查进程占用，请在 Mac 上恢复");
  }
  const bases = [join(homedir(), process.env.PI_CONFIG_DIR || ".omp")];
  if (process.env.XDG_STATE_HOME && isAbsolute(process.env.XDG_STATE_HOME)) bases.push(join(process.env.XDG_STATE_HOME, "omp"));
  const paths = [target.file];
  for (const base of bases) {
    const lock = join(base, "run", "session-owners", `${target.id}.lock`);
    try {
      const info = await lstat(lock);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022)) {
        throw new TerminalBridgeError("invalid_frame", "会话进程锁权限不安全");
      }
      paths.push(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const owners = new Set<number>();
  let fileOwners = "";
  try {
    const result = await run("/usr/sbin/lsof", ["-w", "-t", "--", ...paths], { timeout: 2_000, maxBuffer: 64 * 1024 });
    fileOwners = result.stdout;
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    // lsof exits 1 when any requested file has no owner, even when another file matched.
    if (failure.code !== 1 || failure.stderr?.trim()) {
      throw new TerminalBridgeError("session_busy", "无法确认历史会话的进程占用，请稍后重试；未启动第二个进程", "owner_probe_failed");
    }
    fileOwners = failure.stdout ?? "";
  }
  for (const line of fileOwners.split("\n").filter(line => line.trim())) {
    if (!/^[1-9]\d*$/.test(line.trim()) || !Number.isSafeInteger(Number(line))) throw new TerminalBridgeError("session_busy", "进程占用证据无效，未启动第二个进程", "owner_probe_failed");
    const pid = Number(line);
    if (pid !== process.pid) owners.add(pid);
  }
  // OMP claims its lease only on the first write; idle restores still publish a TTY breadcrumb.
  const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
  const agents = [dirname(dirname(dirname(target.file))),
    join(homedir(), process.env.PI_CONFIG_DIR || ".omp", ...(profile && profile !== "default" ? ["profiles", profile] : []), "agent")];
  if (process.env.PI_CODING_AGENT_DIR) agents.push(resolve(process.env.PI_CODING_AGENT_DIR));
  const breadcrumbDirs = agents.map(agent => join(agent, "terminal-sessions"));
  if (process.env.XDG_STATE_HOME && isAbsolute(process.env.XDG_STATE_HOME)) {
    breadcrumbDirs.push(join(process.env.XDG_STATE_HOME, "omp", ...(profile && profile !== "default" ? ["profiles", profile] : []), "terminal-sessions"));
  }
  try {
    const { stdout } = await run("/usr/sbin/lsof", ["-w", "-a", "-c", "omp", "-d", "0", "-Fpn"], { timeout: 2_000, maxBuffer: 256 * 1024 });
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (!pid || !line.startsWith("n/dev/")) continue;
      const tty = line.slice("n/dev/".length).replaceAll("/", "-");
      if (!/^[A-Za-z0-9._-]+$/.test(tty)) continue;
      for (const dir of breadcrumbDirs) {
        const breadcrumb = join(dir, tty);
        try {
          const info = await lstat(breadcrumb);
          if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 64 * 1024) continue;
          const file = (await readFile(breadcrumb, "utf8")).split("\n")[1];
          if (file && await realpath(file).catch(() => null) === target.file) owners.add(pid);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    if (failure.code !== 1 || failure.stdout?.trim() || failure.stderr?.trim()) {
      throw new TerminalBridgeError("session_busy", "无法检查历史恢复进程，请稍后重试；未启动第二个进程", "owner_probe_failed");
    }
  }
  return [...owners];
}
