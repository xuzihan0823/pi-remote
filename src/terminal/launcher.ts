import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalBridgeError, type TerminalSessionBridge, type TerminalSessionMeta } from "./bridge-client.ts";

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
  bridge: Pick<TerminalSessionBridge, "list" | "bridgeDir">;
  maxSessions?: number;
  managedSessionCount?: () => number;
  spawnFn?: TerminalOpenSpawn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Only opens a new TUI. It never resumes a session or takes ownership of existing terminals. */
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

  async start(requestedCwd?: unknown): Promise<TerminalSessionMeta> {
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
    try {
      const cwd = await bounded(resolveTerminalCwd(this.#options.workspaceRoot, requestedCwd), controller.signal);
      const piBin = await bounded(resolveTerminalExecutable(this.#options.piBin), controller.signal);
      await bounded(access(EXTENSION_PATH, constants.R_OK), controller.signal);
      const sessions = await bounded(this.#options.bridge.list(), controller.signal);
      if (sessions.length + (this.#options.managedSessionCount?.() ?? 0) >= (this.#options.maxSessions ?? 16)) {
        throw new TerminalBridgeError("session_busy", "maximum number of live sessions reached");
      }
      const previousIds = new Set(sessions.map((session) => session.sessionId));
      const launchId = randomUUID();
      // Keep allocation outside the race: cancellation must not leave a directory allocated later.
      launchDir = await mkdtemp(join(tmpdir(), "pi-remote-launch-"));
      controller.signal.throwIfAborted();
      await chmod(launchDir, 0o700);
      const commandPath = join(launchDir, `${randomUUID()}.command`);
      await writeFile(commandPath, terminalCommand(commandPath, launchDir, cwd, piBin, this.#options.bridge.bridgeDir, launchId), { mode: 0o700, flag: "wx" });
      await chmod(commandPath, 0o700);
      controller.signal.throwIfAborted();
      await this.#open(commandPath, controller.signal);
      while (true) {
        const discovered = await bounded(this.#options.bridge.list(), controller.signal);
        const matches = discovered.filter((session) => session.launchId === launchId && !previousIds.has(session.sessionId));
        // A stale or unrelated terminal must never satisfy this launch, even if its cwd matches.
        if (matches.length > 1) throw new TerminalBridgeError("internal_error", "multiple terminal bridges claimed the same launch");
        const session = matches[0];
        if (session) {
          if (!session.sessionId.startsWith("terminal:") || await bounded(realpath(session.cwd), controller.signal) !== cwd) {
            throw new TerminalBridgeError("internal_error", "terminal bridge returned an unexpected launch session");
          }
          controller.signal.throwIfAborted();
          return session;
        }
        const pause = deferred<void>();
        const pauseTimer = setTimeout(pause.resolve, this.#options.pollIntervalMs ?? 100);
        try { await bounded(pause.promise, controller.signal); }
        finally { clearTimeout(pauseTimer); }
      }
    } finally {
      clearTimeout(timer);
      try { if (launchDir) await rm(launchDir, { recursive: true, force: true }); }
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

export async function resolveTerminalCwd(workspaceRoot: string, requested: unknown): Promise<string> {
  if (requested !== undefined && requested !== null && (typeof requested !== "string" || requested.trim().length === 0 || requested.includes("\0"))) {
    throw new TerminalBridgeError("invalid_frame", "params.cwd must be a non-empty directory path");
  }
  try {
    const root = await realpath(workspaceRoot);
    const cwd = await realpath(requested == null ? root : resolve(root, requested as string));
    const rel = relative(root, cwd);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(cwd)).isDirectory()) {
      throw new Error("outside workspace or not a directory");
    }
    return cwd;
  } catch {
    throw new TerminalBridgeError("invalid_frame", "params.cwd must be an existing directory inside the real workspace root");
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

function terminalCommand(commandPath: string, launchDir: string, cwd: string, piBin: string, bridgeDir: string, launchId: string): string {
  const username = userInfo().username;
  const environment = {
    HOME: homedir(), USER: username, LOGNAME: username,
    PATH: trustedPath(), TMPDIR: tmpdir(), TERM: "xterm-256color", LANG: "en_US.UTF-8",
    PI_REMOTE_BRIDGE_DIR: resolve(bridgeDir), [TERMINAL_LAUNCH_ID_ENV]: launchId,
  };
  const argv = Object.entries(environment).map(([key, value]) => shellquote(`${key}=${value}`));
  return ["#!/bin/sh", "set -eu", `/bin/rm -f -- ${shellquote(commandPath)}`, `/bin/rmdir -- ${shellquote(launchDir)}`, `cd -- ${shellquote(cwd)}`, `exec /usr/bin/env -i ${argv.join(" ")} "${TERMINAL_LAUNCH_PID_ENV}=$$" ${shellquote(piBin)} '-e' ${shellquote(EXTENSION_PATH)}`, ""].join("\n");
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
