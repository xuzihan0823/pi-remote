import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayEvent, UiDialogResponse } from "../protocol/types.ts";
import { TerminalBridgeError, type TerminalSessionBridge, type TerminalSessionMeta } from "../terminal/bridge-client.ts";
import { resolveTerminalExecutable, type TerminalResumeTarget } from "../terminal/launcher.ts";
import { publicModel, publicModels, type ModelSelection, type RemoteModel } from "../terminal/extension.ts";
import { sessionOwnerPids } from "../terminal/session-owner.ts";
import { backgroundEnvironment } from "./environment.ts";

export const isBackgroundSessionId = (id: string): boolean => id.startsWith("managed:");
const WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));
export const CONTROLLED_RUNTIME = fileURLToPath(new URL("../../runtime/omp/run.ts", import.meta.url));
interface HostOptions {
  workspaceRoot: string; terminalBridge: TerminalSessionBridge; directory?: string; bun?: string; maxSessions?: number;
  managedSessionCount?: () => number; emit?: (sessionId: string, event: GatewayEvent) => void;
  runtime?: string; runtimeArgs?: string[]; env?: NodeJS.ProcessEnv;
}

export class BackgroundHost {
  readonly directory: string;
  readonly #options: HostOptions;
  readonly #subscriptions = new Map<string, Socket>();
  #guard: ((meta: TerminalSessionMeta) => Promise<boolean>) | undefined;
  #closed = false;

  constructor(options: HostOptions) {
    this.#options = options;
    const scope = createHash("sha256").update(resolve(options.workspaceRoot)).digest("hex").slice(0, 16);
    const uid = process.getuid?.() ?? "user";
    this.directory = options.directory ?? join(process.platform === "darwin" ? "/tmp" : tmpdir(), `pi-rbg-${uid}-${scope}`);
  }
  setControlGuard(guard: (meta: TerminalSessionMeta) => Promise<boolean>): void { this.#guard = guard; }
  async #privateDirectory(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new TerminalBridgeError("internal_error", "后台宿主目录不安全，未启动进程");
  }
  async #discover(): Promise<{ meta: TerminalSessionMeta; path: string }[]> {
    if (this.#closed) return [];
    await this.#privateDirectory();
    const names = (await readdir(this.directory)).filter(name => /^w-[0-9a-f-]{36}\.sock$/.test(name)).slice(0, 128);
    const result = await Promise.all(names.map(async name => {
      const path = join(this.directory, name);
      try {
        const info = await lstat(path);
        if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return [];
        const values = await this.#call(path, { op: "list" }, 2_000) as TerminalSessionMeta[];
        return values.filter(meta => isBackgroundSessionId(meta.sessionId) && meta.runtime === "omp" && meta.processId && meta.instanceId && meta.persistedSessionFile).map(meta => ({ meta, path }));
      } catch { return []; }
    }));
    return result.flat();
  }
  async instances(): Promise<TerminalSessionMeta[]> { return (await this.#discover()).map(entry => entry.meta); }
  async list(): Promise<TerminalSessionMeta[]> {
    const values = await this.instances();
    const result: TerminalSessionMeta[] = [];
    for (const meta of values) {
      const unique = values.filter(value => value.sessionId === meta.sessionId).length === 1;
      result.push({ ...meta, canControl: unique && (!this.#guard || await this.#guard(meta)) });
      this.#subscribe(meta);
    }
    return result;
  }
  async #resolve(id: string) {
    const values = (await this.#discover()).filter(entry => entry.meta.sessionId === id);
    if (values.length !== 1) throw new TerminalBridgeError(values.length ? "session_busy" : "unknown_session", "后台实例已退出或发生冲突，请刷新会话列表");
    return values[0]!;
  }
  async get(id: string): Promise<TerminalSessionMeta> { return (await this.#resolve(id)).meta; }
  async #request(id: string, op: string, params: Record<string, unknown> = {}, control = false): Promise<Record<string, unknown>> {
    const { meta, path } = await this.#resolve(id);
    if (control && this.#guard && !await this.#guard(meta)) throw new TerminalBridgeError("session_busy", "会话尚未通过原文件验证，已禁止控制");
    this.#subscribe(meta);
    return await this.#call(path, { ...params, op, sessionId: id, instanceId: meta.instanceId }, 65_000) as Record<string, unknown>;
  }
  async view(id: string, params: Record<string, unknown>): Promise<Record<string, unknown>> { return this.#request(id, "snapshot", params); }
  async prompt(id: string, message: string): Promise<void> { await this.#request(id, "prompt", { message }, true); }
  async abort(id: string): Promise<void> { await this.#request(id, "abort", {}, true); }
  async respondToUi(id: string, requestId: string, response: UiDialogResponse): Promise<void> { await this.#request(id, "ui_response", { requestId, response }, true); }
  async models(id: string) {
    const result = await this.#request(id, "models");
    return { sessionId: id, models: publicModels(result.models), model: publicModel(result.model) };
  }
  async getModel(id: string) {
    const result = await this.#request(id, "get_model");
    return { sessionId: id, model: publicModel(result.model) };
  }
  async setModel(id: string, model: ModelSelection): Promise<{ sessionId: string; model: RemoteModel }> {
    const result = await this.#request(id, "set_model", { model }, true);
    const confirmed = publicModel(result.model);
    if (!confirmed || confirmed.provider !== model.provider || confirmed.modelId !== model.modelId) throw new TerminalBridgeError("internal_error", "后台实例未确认模型，未发送消息");
    return { sessionId: id, model: confirmed };
  }

  async resume(target: TerminalResumeTarget): Promise<TerminalSessionMeta> {
    if (this.#closed) throw new TerminalBridgeError("internal_error", "后台恢复已关闭");
    await target.verify();
    const all = [...await this.#options.terminalBridge.instances(), ...await this.instances()];
    const candidates = all.filter(meta => meta.persistedSessionId === target.id || meta.sessionId === `terminal:${target.id}`);
    if (candidates.length > 1) throw new TerminalBridgeError("session_busy", "同一历史存在多个运行实例，未启动新进程");
    if (candidates.length === 1) {
      const meta = candidates[0]!;
      if (meta.runtime !== "omp" || !meta.persistedSessionFile || await realpath(meta.persistedSessionFile) !== target.file || await realpath(meta.cwd) !== target.cwd) throw new TerminalBridgeError("session_busy", "原运行实例身份不匹配");
      return meta;
    }
    if ((await sessionOwnerPids(target)).length) throw new TerminalBridgeError("session_busy", "原历史仍由未桥接进程占用，未启动新实例");
    if (all.length + (this.#options.managedSessionCount?.() ?? 0) >= (this.#options.maxSessions ?? 16)) throw new TerminalBridgeError("session_busy", "运行会话数达到上限");
    await this.#privateDirectory();
    const bun = await resolveTerminalExecutable(this.#options.bun ?? "bun");
    const runtime = this.#options.runtime ?? CONTROLLED_RUNTIME;
    await access(runtime, constants.R_OK);
    const instanceId = randomUUID();
    const socketPath = join(this.directory, `w-${instanceId}.sock`);
    const configPath = join(this.directory, `w-${instanceId}.json`);
    const statusPath = target.launch?.statusPath ?? join(this.directory, `w-${instanceId}.status`);
    const config = { file: target.file, id: target.id, cwd: target.cwd, launchId: target.launch?.id ?? randomUUID(), instanceId, socketPath, statusPath, bun, runtime, ...(this.#options.runtimeArgs ? { args: this.#options.runtimeArgs } : {}) };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    await target.verify();
    await target.launch?.phase("opening", configPath);
    const log = await open(join(this.directory, `w-${instanceId}.log`), "ax", 0o600);
    const env = this.#options.env ?? await backgroundEnvironment();
    const child = spawn(process.execPath, [WORKER, configPath], { cwd: target.cwd, env, detached: true, stdio: ["ignore", log.fd, log.fd] });
    const spawned = Promise.withResolvers<void>();
    child.once("spawn", spawned.resolve);
    child.once("error", spawned.reject);
    await spawned.promise;
    await log.close();
    child.unref();
    await target.launch?.phase("waiting_bridge");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (this.#closed) throw new TerminalBridgeError("timeout", "启动已交给后台宿主，请重连后查询同一操作");
      const matches = (await this.instances()).filter(meta => meta.instanceId === instanceId);
      if (matches.length === 1) { await target.launch?.phase("verifying"); this.#subscribe(matches[0]!); return matches[0]!; }
      const status = await readFile(statusPath, "utf8").catch(() => "");
      if (/^exited \d+ \d+\s*$/.test(status)) throw new TerminalBridgeError("internal_error", "OMP 在后台就绪前退出", "omp_exited");
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 100);
      await tick.promise;
    }
    throw new TerminalBridgeError("timeout", "后台启动结果未知，请查询同一恢复操作，不会再次启动");
  }

  #subscribe(meta: TerminalSessionMeta): void {
    if (this.#subscriptions.has(meta.sessionId) || this.#closed) return;
    const socket = createConnection(join(this.directory, `w-${meta.instanceId}.sock`));
    this.#subscriptions.set(meta.sessionId, socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("connect", () => socket.write(JSON.stringify({ op: "subscribe", sessionId: meta.sessionId, instanceId: meta.instanceId }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
      while (buffer.includes("\n")) {
        const boundary = buffer.indexOf("\n");
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        try {
          const response = JSON.parse(line) as { event?: GatewayEvent };
          if (response.event?.sessionId === meta.sessionId) this.#options.emit?.(meta.sessionId, response.event);
        } catch { socket.destroy(); return; }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => { if (this.#subscriptions.get(meta.sessionId) === socket) this.#subscriptions.delete(meta.sessionId); });
  }

  #call(path: string, message: Record<string, unknown>, timeout: number): Promise<unknown> {
    const result = Promise.withResolvers<unknown>();
    const socket = createConnection(path);
    const id = randomUUID();
    let buffer = "";
    const timer = setTimeout(() => result.reject(new TerminalBridgeError("timeout", "后台请求应答未知，请读取状态后确认")), timeout);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ ...message, id }) + "\n"));
    socket.on("error", result.reject);
    socket.on("end", () => result.reject(new TerminalBridgeError("unknown_session", "后台连接已关闭")));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { result.reject(new TerminalBridgeError("internal_error", "后台响应超过预算")); return; }
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      try {
        const frame = JSON.parse(buffer.slice(0, boundary));
        if (frame.id !== id) throw new Error("background_response_mismatch");
        if (frame.ok) result.resolve(frame.data);
        else result.reject(new TerminalBridgeError(frame.error?.code ?? "internal_error", frame.error?.message ?? "后台请求失败"));
      } catch (error) { result.reject(error); }
    });
    return result.promise.finally(() => { clearTimeout(timer); socket.destroy(); });
  }

  async shutdownAll(): Promise<void> {
    const instances = await this.#discover();
    await Promise.all(instances.map(({ meta, path }) => this.#call(path, { op: "shutdown", sessionId: meta.sessionId, instanceId: meta.instanceId }, 5_000)));
  }

  close(): void {
    this.#closed = true;
    for (const socket of this.#subscriptions.values()) socket.destroy();
    this.#subscriptions.clear();
  }
}
