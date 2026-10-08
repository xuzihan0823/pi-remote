import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalBridgeError, type TerminalSessionBridge, type TerminalSessionMeta } from "./bridge-client.ts";
import { resolveProjectDirectory } from "../projects.ts";
import { sessionOwnerPids } from "./session-owner.ts";

export const TERMINAL_APP = "/System/Applications/Utilities/Terminal.app";
export const TERMINAL_LAUNCH_ID_ENV = "PI_REMOTE_LAUNCH_ID";
export const TERMINAL_LAUNCH_PID_ENV = "PI_REMOTE_LAUNCH_PID";
// Resolve relative to the running source, including the copy bundled by the macOS app.
const EXTENSION_PATH = fileURLToPath(new URL("./extension.ts", import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;

export interface TerminalOpenProcess {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): boolean;
}
export type TerminalOpenSpawn = (command: string, args: string[], options: SpawnOptions) => TerminalOpenProcess;

export interface TerminalSessionLauncherOptions {
  piBin: string;
  workspaceRoot: string;
  bridge: Pick<TerminalSessionBridge, "list" | "bridgeDir"> & Partial<Pick<TerminalSessionBridge, "instances">>;
  maxSessions?: number;
  managedSessionCount?: () => number;
  spawnFn?: TerminalOpenSpawn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  pollIntervalMs?: number;
  ownerPids?: typeof sessionOwnerPids;
}

export interface TerminalResumeTarget {
  file: string;
  id: string;
  cwd: string;
  verify: () => Promise<void>;
  launch?: {
    id: string;
    statusPath: string;
    phase: (phase: "opening" | "waiting_bridge" | "verifying", commandPath?: string) => Promise<void>;
  };
}

/** Opens a user terminal, reusing an existing bridge when restoring its history. */
export class TerminalSessionLauncher {
  readonly #options: TerminalSessionLauncherOptions;
  #pending: AbortController | null = null;
  #closed = false;

  constructor(options: TerminalSessionLauncherOptions) {
    this.#options = options;
  }

  close(): void {
    this.#closed = true;
    this.#pending?.abort(new TerminalBridgeError("internal_error", "terminal launcher is closed"));
  }

  start(requestedCwd?: unknown): Promise<TerminalSessionMeta> {
    return this.#launch(requestedCwd);
  }

  resume(target: TerminalResumeTarget): Promise<TerminalSessionMeta> {
    return this.#launch(target.cwd, target);
  }

  async #launch(requestedCwd?: unknown, resume?: TerminalResumeTarget): Promise<TerminalSessionMeta> {
    if (this.#closed) throw new TerminalBridgeError("internal_error", "terminal launcher is closed");
    if (this.#pending) throw new TerminalBridgeError("session_busy", "a terminal launch is already in progress");
    if ((this.#options.platform ?? process.platform) !== "darwin") {
      throw new TerminalBridgeError("not_implemented", "terminal session creation requires macOS");
    }
    const controller = new AbortController();
    this.#pending = controller;
    const timeoutMs = Math.min(25_000, Math.max(1, this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const timer = setTimeout(() => controller.abort(new TerminalBridgeError("timeout", "terminal bridge did not become ready before the launch deadline")), timeoutMs);
    let launchDir: string | undefined;
    let dispatched = false;
    try {
      const cwd = resume
        ? await bounded(realpath(resume.cwd), controller.signal)
        : await bounded(resolveTerminalCwd(this.#options.workspaceRoot, requestedCwd), controller.signal);
      if (resume && !(await bounded(stat(cwd), controller.signal)).isDirectory()) {
        throw new TerminalBridgeError("invalid_frame", "历史工作目录不存在或不是目录");
      }
      const sessions = await bounded(this.#options.bridge.instances?.() ?? this.#options.bridge.list(), controller.signal);
      if (resume) {
        const matches = sessions.filter(session => session.persistedSessionId === resume.id || session.sessionId === `terminal:${resume.id}`);
        if (matches.length > 1) throw new TerminalBridgeError("session_busy", "同一历史对应多个活跃终端，请在 Mac 上确认");
        const existing = matches[0];
        if (existing) {
          if (await bounded(realpath(existing.cwd), controller.signal) !== cwd ||
            (existing.runtime !== undefined && existing.runtime !== "omp") ||
            (existing.persistedSessionFile !== undefined && await bounded(realpath(existing.persistedSessionFile), controller.signal) !== resume.file)) {
            throw new TerminalBridgeError("session_busy", "活跃会话身份不一致，未启动第二个进程");
          }
          return existing;
        }
      }
      if (resume) {
        await bounded(resume.verify(), controller.signal);
        const owners = await bounded((this.#options.ownerPids ?? sessionOwnerPids)(resume), controller.signal);
        if (owners.length) throw new TerminalBridgeError("session_busy", "此历史仍在 Mac 进程中打开，请在原 OMP 终端空闲时执行 /reload，再从手机继续");
      }
      const piBin = await bounded(resolveTerminalExecutable(this.#options.piBin), controller.signal);
      await bounded(access(EXTENSION_PATH, constants.R_OK).catch(() => { throw new TerminalBridgeError("internal_error", "bridge extension unavailable"); }), controller.signal);
      if (sessions.length + (this.#options.managedSessionCount?.() ?? 0) >= (this.#options.maxSessions ?? 16)) {
        throw new TerminalBridgeError("session_busy", "maximum number of live sessions reached");
      }
      const previousIds = new Set(sessions.map((session) => session.sessionId));
      const launchId = resume?.launch?.id ?? randomUUID();
      // Keep allocation outside the race: cancellation must not leave a directory allocated later.
      launchDir = await mkdtemp(join(tmpdir(), "pi-remote-launch-"));
      controller.signal.throwIfAborted();
      await chmod(launchDir, 0o700);
      const commandPath = join(launchDir, `${randomUUID()}.command`);
      await writeFile(commandPath, terminalCommand(commandPath, launchDir, cwd, piBin, this.#options.bridge.bridgeDir, launchId, resume?.file, resume?.launch?.statusPath), { mode: 0o700, flag: "wx" });
      await chmod(commandPath, 0o700);
      controller.signal.throwIfAborted();
      if (resume) {
        await bounded(resume.verify(), controller.signal);
        if ((await bounded((this.#options.ownerPids ?? sessionOwnerPids)(resume), controller.signal)).length) {
          throw new TerminalBridgeError("session_busy", "历史会话刚被其他进程打开，未启动第二个终端");
        }
      }
      await resume?.launch?.phase("opening", commandPath);
      dispatched = true;
      await this.#open(commandPath, controller.signal);
      await resume?.launch?.phase("waiting_bridge");
      while (true) {
        const discovered = await bounded(this.#options.bridge.instances?.() ?? this.#options.bridge.list(), controller.signal);
        const matches = discovered.filter((session) => session.launchId === launchId && !previousIds.has(session.sessionId));
        // A stale or unrelated terminal must never satisfy this launch, even if its cwd matches.
        if (matches.length > 1) throw new TerminalBridgeError("internal_error", "multiple terminal bridges claimed the same launch");
        const session = matches[0];
        if (session) {
          await resume?.launch?.phase("verifying");
          if (!session.sessionId.startsWith("terminal:") || await bounded(realpath(session.cwd), controller.signal) !== cwd) {
            throw new TerminalBridgeError("internal_error", "terminal bridge returned an unexpected launch session");
          }
          if (resume && (session.runtime !== "omp" || session.persistedSessionId !== resume.id ||
            !session.persistedSessionFile || await bounded(realpath(session.persistedSessionFile), controller.signal) !== resume.file)) {
            throw new TerminalBridgeError("session_busy", "历史被其他终端占用或恢复身份变化，未接手新的副本");
          }
          if (resume) {
            await bounded(resume.verify(), controller.signal);
            const sameHistory = discovered.filter(candidate => candidate.persistedSessionId === resume.id || candidate.sessionId === `terminal:${resume.id}`);
            if (sameHistory.length !== 1) throw new TerminalBridgeError("session_busy", "同一历史出现多个桥接实例，已禁止控制");
            const owners = await bounded((this.#options.ownerPids ?? sessionOwnerPids)(resume), controller.signal);
            if (owners.some(pid => pid !== session.processId)) throw new TerminalBridgeError("session_busy", "历史仍被其他进程占用，未接手第二个写入进程");
          }
          controller.signal.throwIfAborted();
          return session;
        }
        if (resume?.launch) {
          const status = await readFile(resume.launch.statusPath, "utf8").catch(() => "");
          if (/^exited \d+ \d+\s*$/.test(status)) throw new TerminalBridgeError("internal_error", "OMP 在桥接就绪前退出，请检查 Mac 终端中的启动错误");
        }
        const pause = deferred<void>();
        const pauseTimer = setTimeout(pause.resolve, this.#options.pollIntervalMs ?? 100);
        try { await bounded(pause.promise, controller.signal); }
        finally { clearTimeout(pauseTimer); }
      }
    } finally {
      clearTimeout(timer);
      try { if (launchDir && !(resume?.launch && dispatched)) await rm(launchDir, { recursive: true, force: true }); }
      finally { this.#pending = null; }
    }
  }

  #open(commandPath: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const { promise, resolve: done, reject } = deferred<void>();
    // open gets no gateway environment, and the command starts the TUI via env -i as well.
    const child = (this.#options.spawnFn ?? spawn)("/usr/bin/open", ["-a", TERMINAL_APP, commandPath], { env: {}, stdio: "ignore" });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else done();
    };
    const cancel = (): void => {
      // This is only our short-lived open helper, never the Terminal app or a TUI process.
      child.kill();
      finish(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
    child.on("error", () => finish(new TerminalBridgeError("internal_error", "failed to open the Terminal application")));
    child.on("exit", (code: number | null) => finish(code === 0 ? undefined : new TerminalBridgeError("internal_error", "Terminal application launch failed")));
    if (signal.aborted) cancel();
    return promise;
  }
}

export async function resolveTerminalCwd(defaultDirectory: string, requested: unknown): Promise<string> {
  try {
    return await resolveProjectDirectory(defaultDirectory, requested);
  } catch (error) {
    throw new TerminalBridgeError("invalid_frame", error instanceof Error ? error.message : "项目目录不可用");
  }
}

function trustedPath(): string {
  return [...new Set([dirname(process.execPath), join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}

export async function resolveTerminalExecutable(configured: string): Promise<string> {
  const candidates = isAbsolute(configured) ? [configured] : /^[A-Za-z0-9._-]+$/.test(configured) ? trustedPath().split(":").map((dir) => join(dir, configured)) : [];
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch { /* try the next trusted directory */ }
  }
  throw new TerminalBridgeError("internal_error", "configured PI_BIN is not a real executable on the trusted local PATH");
}

function shellquote(value: string): string {
  if (value.includes("\0")) throw new TerminalBridgeError("internal_error", "launch configuration contains a null byte");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function terminalEnvironment(): Record<string, string> {
  const username = userInfo().username;
  const environment: Record<string, string> = {
    HOME: homedir(), USER: username, LOGNAME: username,
    PATH: trustedPath(), TMPDIR: tmpdir(), TERM: "xterm-256color", LANG: "en_US.UTF-8",
  };
  for (const key of ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]!;
  }
  return environment;
}

function terminalCommand(commandPath: string, launchDir: string, cwd: string, piBin: string, bridgeDir: string, launchId: string, sessionFile?: string, statusPath?: string): string {
  const environment = {
    ...terminalEnvironment(), PI_REMOTE_BRIDGE_DIR: resolve(bridgeDir), [TERMINAL_LAUNCH_ID_ENV]: launchId,
    ...(statusPath ? { PI_REMOTE_LAUNCH_STATUS_PATH: statusPath } : {}),
  };
  const argv = Object.entries(environment).map(([key, value]) => shellquote(`${key}=${value}`));
  const sessionArgs = sessionFile ? ` '--session' ${shellquote(sessionFile)}` : "";
  const command = `/usr/bin/env -i ${argv.join(" ")} /bin/sh -c 'export ${TERMINAL_LAUNCH_PID_ENV}=$$; exec "$@"' sh ${shellquote(piBin)} '-e' ${shellquote(EXTENSION_PATH)}${sessionArgs}`;
  const cleanup = [`/bin/rm -f -- ${shellquote(commandPath)}`, `/bin/rmdir -- ${shellquote(launchDir)}`, `cd -- ${shellquote(cwd)}`];
  if (!statusPath) return ["#!/bin/sh", "set -eu", "umask 077", ...cleanup, `exec ${command}`, ""].join("\n");
  const status = shellquote(statusPath);
  const exitStatus = `result=$?; trap - 0; printf 'exited %s %s\\n' "$$" "$result" > ${status}.tmp; /bin/mv -f ${status}.tmp ${status}; exit "$result"`;
  return ["#!/bin/sh", "set -eu", "umask 077", `trap ${shellquote(exitStatus)} 0`,
    `printf 'waiting_omp %s\\n' "$$" > ${status}.tmp; /bin/mv -f ${status}.tmp ${status}`,
    ...cleanup, command, ""].join("\n");
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve: done, reject } = deferred<T>();
  const cancel = (): void => reject(signal.reason);
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", cancel, { once: true });
  operation.then(done, reject).finally(() => signal.removeEventListener("abort", cancel));
  return promise;
}

// The project's ES2023 type library predates Promise.withResolvers (Node itself supports it).
function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
