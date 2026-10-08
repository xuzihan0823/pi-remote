import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OmpHistoryIndex } from "../history/history-index.ts";
import { TerminalBridgeError, type TerminalSessionBridge, type TerminalSessionMeta } from "./bridge-client.ts";
import type { TerminalResumeTarget, TerminalSessionLauncher } from "./launcher.ts";
import { sessionOwnerPids } from "./session-owner.ts";
import { HistoryReadError } from "../history/omp-reader.ts";
import { readModelSelection, type ModelSelection, type RemoteModel } from "./extension.ts";
import type { RelayErrorCode } from "../protocol/relay-types.ts";

interface RecoveryModelSelection {
  requested: ModelSelection;
  state: "pending" | "applying" | "applied" | "failed" | "unknown";
  applied: boolean;
  model: RemoteModel | null;
  error?: { code: RelayErrorCode; message: string };
}

export type RecoveryPhase = "validating" | "opening" | "waiting_bridge" | "verifying" | "ready" | "blocked" | "failed" | "outcome_unknown" | "reconciling";
interface RecoveryRecord {
  version: 1;
  operationId: string;
  requestIds: string[];
  target: { file: string; id: string; cwd: string };
  phase: RecoveryPhase;
  launchId: string;
  commandPath?: string;
  fileIdentity?: string;
  wrapperPid?: number;
  wrapperIdentity?: string;
  exitCode?: number;
  instanceId?: string;
  processId?: number;
  processIdentity?: string;
  errorCode?: string;
  updatedAt: number;
  createdAt: number;
  modelSelection?: RecoveryModelSelection;
}
export interface RecoveryOptions {
  history: OmpHistoryIndex;
  bridge: Pick<TerminalSessionBridge, "instances" | "get"> & Partial<Pick<TerminalSessionBridge, "setModel">>;
  launcher: Pick<TerminalSessionLauncher, "resume">;
  directory?: string;
  workspaceRoot: string;
  ownerPids?: typeof sessionOwnerPids;
  processIdentity?: typeof processIdentity;
}

async function readRecoveryStatus(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 64 * 1024) return "";
    return await handle.readFile("utf8");
  } catch { return ""; }
  finally { await handle?.close(); }
}
const run = promisify(execFile);

export async function processIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "lstart="], { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, timeout: 2_000, maxBuffer: 1024 });
    return stdout.trim() || null;
  } catch { return null; }
}

export class HistoryRecoveryCoordinator {
  readonly directory: string;
  readonly #options: RecoveryOptions;
  readonly #records = new Map<string, RecoveryRecord>();
  readonly #operations = new Map<string, RecoveryRecord>();
  readonly #jobs = new Map<string, Promise<void>>();
  readonly #requests = new Map<string, { alias: string; model?: ModelSelection; response: Promise<Record<string, unknown>> }>();
  readonly #queries = new Map<string, Promise<Record<string, unknown>>>();
  readonly #saves = new Map<string, Promise<void>>();
  readonly #modelJobs = new Map<string, Promise<void>>();
  readonly #loaded: Promise<void>;
  #closed = false;

  constructor(options: RecoveryOptions) {
    this.#options = options;
    this.directory = options.directory ?? join(homedir(), ".omp", "agent", "pi-remote-recovery", createHash("sha256").update(options.workspaceRoot).digest("hex").slice(0, 24));
    this.#loaded = this.#load();
    void this.#loaded.catch(() => {});
  }

  async #load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) throw new Error("Unsafe recovery directory");
    for (const name of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const handle = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 64 * 1024) throw new Error("Unsafe recovery record");
        const record = JSON.parse(await handle.readFile("utf8")) as RecoveryRecord;
        if (record.version !== 1 || `${record.operationId}.json` !== name || !Number.isSafeInteger(record.createdAt) || typeof record.target?.file !== "string" || typeof record.target.id !== "string" || typeof record.target.cwd !== "string") throw new Error("Invalid recovery record");
        if (!Array.isArray(record.requestIds) || record.requestIds.length > 256 || !record.requestIds.every(id => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))) throw new Error("Invalid recovery request IDs");
        if (!/^[0-9a-f-]{36}$/.test(record.launchId) || !["validating", "opening", "waiting_bridge", "verifying", "ready", "blocked", "failed", "outcome_unknown", "reconciling"].includes(record.phase) || !Number.isSafeInteger(record.updatedAt) || !/^\d+:\d+$/.test(record.fileIdentity ?? "")) throw new Error("Invalid recovery identity");
        if (record.modelSelection) {
          const model = record.modelSelection;
          if (!readModelSelection(model.requested) || !["pending", "applying", "applied", "failed", "unknown"].includes(model.state) || typeof model.applied !== "boolean") throw new Error("Invalid recovery model selection");
          if (model.state === "applied" ? !model.applied || !model.model || model.model.provider !== model.requested.provider || model.model.modelId !== model.requested.modelId : model.applied || model.model !== null) throw new Error("Invalid recovery model result");
          if (model.state === "applying") {
            model.state = "unknown";
            model.applied = false;
            model.model = null;
            model.error = { code: "internal_error", message: "模型切换结果尚未确认，请读取当前模型；不会自动重复切换。" };
          }
        }
        this.#operations.set(record.operationId, record);
        const previous = this.#records.get(record.target.file);
        if (record.phase === "ready" || ["validating", "opening", "waiting_bridge", "verifying"].includes(record.phase)) record.phase = "reconciling";
        if (!previous || previous.createdAt <= record.createdAt) this.#records.set(record.target.file, record);
      } finally { await handle.close(); }
    }
  }

  async #save(record: RecoveryRecord): Promise<void> {
    const previous = this.#saves.get(record.operationId) ?? Promise.resolve();
    const saving = previous.catch(() => {}).then(async () => {
      record.updatedAt = Date.now();
      const path = join(this.directory, `${record.operationId}.json`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
    });
    this.#saves.set(record.operationId, saving);
    try { await saving; }
    finally { if (this.#saves.get(record.operationId) === saving) this.#saves.delete(record.operationId); }
  }

  async start(alias: string, requestedId?: unknown, retry = false, model?: ModelSelection): Promise<Record<string, unknown>> {
    await this.#loaded;
    if (this.#closed) throw new TerminalBridgeError("internal_error", "恢复服务已关闭");
    if (requestedId !== undefined && (typeof requestedId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestedId))) throw new TerminalBridgeError("invalid_frame", "恢复操作 ID 无效");
    const id = typeof requestedId === "string" ? requestedId.toLowerCase() : randomUUID();
    const pending = this.#requests.get(id);
    if (pending) {
      if (pending.alias !== alias) throw new TerminalBridgeError("invalid_frame", "操作 ID 已绑定其他历史引用");
      this.#assertModel(pending.model, model);
      return pending.response;
    }
    let resolve!: (data: Record<string, unknown>) => void;
    let reject!: (error: unknown) => void;
    const response = new Promise<Record<string, unknown>>((done, fail) => { resolve = done; reject = fail; });
    this.#requests.set(id, { alias, model, response });
    void this.#options.history.resume(alias, async target => {
      const fileInfo = await lstat(target.file);
      const known = this.#operations.get(id) ?? [...this.#operations.values()].find(record => record.requestIds.includes(id));
      if (known) {
        if (known.target.file !== target.file) throw new TerminalBridgeError("invalid_frame", "操作 ID 已绑定其他历史");
        this.#assertModel(known.modelSelection?.requested, model);
        resolve(await this.query(id));
        return;
      }
      const existing = this.#records.get(target.file);
      if (existing) {
        const data = await this.query(existing.operationId);
        if (!retry || data.canRetry !== true) {
          this.#assertModel(existing.modelSelection?.requested, model);
          if (!existing.requestIds.includes(id)) {
            if (existing.requestIds.length >= 256) throw new TerminalBridgeError("session_busy", "恢复操作查询请求过多，请查询现有操作");
            existing.requestIds.push(id);
            await this.#save(existing);
          }
          resolve(data);
          return;
        }
        if (this.#records.get(target.file) !== existing) {
          const replacement = this.#records.get(target.file)!;
          this.#assertModel(replacement.modelSelection?.requested, model);
          if (!replacement.requestIds.includes(id) && replacement.requestIds.length < 256) { replacement.requestIds.push(id); await this.#save(replacement); }
          resolve(await this.query(replacement.operationId));
          return;
        }
      }
      const record: RecoveryRecord = { version: 1, operationId: id, requestIds: [id], target: { file: target.file, id: target.id, cwd: target.cwd }, phase: "validating", launchId: randomUUID(), createdAt: Math.max(Date.now(), (existing?.createdAt ?? 0) + 1), updatedAt: Date.now() };
      if (model) record.modelSelection = { requested: { ...model }, state: "pending", applied: false, model: null };
      record.fileIdentity = `${fileInfo.dev}:${fileInfo.ino}`;
      this.#records.set(target.file, record);
      this.#operations.set(id, record);
      const saved = this.#save(record);
      const job = saved.then(() => this.#recover(record, target));
      void job.catch(() => {});
      this.#jobs.set(record.operationId, job);
      try {
        await saved;
        resolve(this.#public(record));
        await job;
      } finally { this.#jobs.delete(record.operationId); }
    }).catch(reject).finally(() => this.#requests.delete(id));
    return response;
  }

  async #recover(record: RecoveryRecord, target: TerminalResumeTarget): Promise<void> {
    try {
      const meta = await this.#options.launcher.resume({ ...target, launch: {
        id: record.launchId, statusPath: join(this.directory, `${record.operationId}.status`),
        phase: async (phase, commandPath) => {
          record.phase = phase;
          if (commandPath) record.commandPath = commandPath;
          await this.#save(record);
        },
      } });
      await this.#verify(record, target, meta);
      await this.#applyModel(record, meta);
    } catch (error) {
      record.errorCode = error instanceof TerminalBridgeError ? error.reason ?? error.code : "validation_failed";
      if (error instanceof TerminalBridgeError && error.message.startsWith("configured PI_BIN")) record.errorCode = "binary_unavailable";
      if (error instanceof TerminalBridgeError && error.message === "bridge extension unavailable") record.errorCode = "extension_unavailable";
      if (error instanceof HistoryReadError) record.errorCode = "history_changed";
      record.phase = error instanceof TerminalBridgeError && error.code === "session_busy" ? "blocked" : record.commandPath ? "outcome_unknown" : "failed";
      const status = await readRecoveryStatus(join(this.directory, `${record.operationId}.status`));
      if (/^exited \d+ \d+\s*$/.test(status)) { record.phase = "failed"; record.errorCode = "omp_exited"; }
      await this.#save(record);
    }
  }

  async #verify(record: RecoveryRecord, target: TerminalResumeTarget, candidate: TerminalSessionMeta): Promise<TerminalSessionMeta> {
    await target.verify();
    const fileInfo = await lstat(target.file);
    if (record.fileIdentity !== `${fileInfo.dev}:${fileInfo.ino}`) throw new TerminalBridgeError("session_busy", "原历史文件已被替换");
    const matches = (await this.#options.bridge.instances()).filter(meta => meta.persistedSessionId === target.id || meta.sessionId === `terminal:${target.id}` || meta.launchId === record.launchId);
    if (matches.length !== 1 || matches[0]!.instanceId !== candidate.instanceId) throw new TerminalBridgeError("session_busy", "历史存在多个或变化中的终端实例");
    const meta = await this.#options.bridge.get(candidate.sessionId);
    if (meta.runtime !== "omp" || meta.persistedSessionId !== target.id || !meta.persistedSessionFile || await realpath(meta.persistedSessionFile) !== target.file || await realpath(meta.cwd) !== target.cwd || !meta.instanceId || !meta.processId || meta.instanceId !== candidate.instanceId || (record.commandPath && meta.launchId !== record.launchId)) throw new TerminalBridgeError("session_busy", "终端恢复身份不匹配");
    const identity = await (this.#options.processIdentity ?? processIdentity)(meta.processId);
    if (!identity || (record.instanceId && (record.instanceId !== meta.instanceId || record.processId !== meta.processId || record.processIdentity !== identity))) throw new TerminalBridgeError("session_busy", "原运行实例已变化");
    const owners = await (this.#options.ownerPids ?? sessionOwnerPids)(target);
    if (owners.some(pid => pid !== meta.processId)) throw new TerminalBridgeError("session_busy", "历史仍被其他进程占用");
    record.instanceId = meta.instanceId;
    record.processId = meta.processId;
    record.processIdentity = identity;
    record.phase = "ready";
    delete record.errorCode;
    await this.#save(record);
    return meta;
  }

  #assertModel(expected: ModelSelection | undefined, requested: ModelSelection | undefined): void {
    if (expected?.provider !== requested?.provider || expected?.modelId !== requested?.modelId) {
      throw new TerminalBridgeError("session_busy", "此恢复操作已绑定不同模型选择，请查询原操作；恢复后使用真实会话 ID 显式切换模型。");
    }
  }

  async #applyModel(record: RecoveryRecord, meta: TerminalSessionMeta): Promise<void> {
    const pending = this.#modelJobs.get(record.operationId);
    if (pending) return pending;
    const selection = record.modelSelection;
    if (!selection || selection.state !== "pending") return;
    const job = (async () => {
      selection.state = "applying";
      await this.#save(record);
      try {
        if (!await this.canControl(meta)) throw new TerminalBridgeError("session_busy", "会话尚未通过恢复验证，不能切换模型");
        if (!this.#options.bridge.setModel) throw new TerminalBridgeError("not_implemented", "请更新 Mac 桥接以选择模型");
        const result = await this.#options.bridge.setModel(meta.sessionId, selection.requested);
        if (result.sessionId !== meta.sessionId || result.model.provider !== selection.requested.provider || result.model.modelId !== selection.requested.modelId) {
          throw new TerminalBridgeError("internal_error", "模型未按预期生效，请重新读取当前模型");
        }
        selection.state = "applied";
        selection.applied = true;
        selection.model = { provider: result.model.provider, modelId: result.model.modelId, name: result.model.name };
      } catch (error) {
        selection.state = error instanceof TerminalBridgeError && ["invalid_frame", "session_busy", "not_implemented", "unknown_session"].includes(error.code) ? "failed" : "unknown";
        selection.error = error instanceof TerminalBridgeError ? { code: error.code, message: error.message } : { code: "internal_error", message: "模型切换结果尚未确认，请读取当前模型；不会自动重复切换。" };
      }
      await this.#save(record);
    })();
    this.#modelJobs.set(record.operationId, job);
    try { await job; }
    finally { this.#modelJobs.delete(record.operationId); }
  }

  async reconcile(): Promise<void> {
    await this.#loaded;
    if (this.#closed) return;
    const instances = await this.#options.bridge.instances();
    const interrupted = [...this.#records.values()].filter(record =>
      ["reconciling", "outcome_unknown"].includes(record.phase) && !this.#jobs.has(record.operationId) &&
      instances.some(meta => meta.launchId === record.launchId || meta.persistedSessionId === record.target.id || meta.sessionId === `terminal:${record.target.id}`));
    for (const record of interrupted.slice(0, 64)) await this.query(record.operationId);
  }

  async query(operationId: string, model?: ModelSelection): Promise<Record<string, unknown>> {
    await this.#loaded;
    if (model) {
      const record = this.#operations.get(operationId) ?? [...this.#operations.values()].find(value => value.requestIds.includes(operationId));
      if (record) this.#assertModel(record.modelSelection?.requested, model);
    }
    const pending = this.#queries.get(operationId);
    if (pending) return pending;
    const result = this.#query(operationId);
    this.#queries.set(operationId, result);
    try { return await result; }
    finally { this.#queries.delete(operationId); }
  }

  async #query(operationId: string): Promise<Record<string, unknown>> {
    await this.#loaded;
    const record = this.#operations.get(operationId) ?? [...this.#operations.values()].find(value => value.requestIds.includes(operationId));
    if (!record) throw new TerminalBridgeError("unknown_session", "恢复操作已失效，请刷新历史列表");
    await this.#observeStatus(record);
    if (this.#jobs.has(record.operationId)) return this.#public(record);
    let session: TerminalSessionMeta | undefined;
    try {
      session = await this.#options.history.resumeStored(record.target, async target => {
        const fileInfo = await lstat(target.file);
        if (record.fileIdentity !== `${fileInfo.dev}:${fileInfo.ino}`) throw new TerminalBridgeError("session_busy", "原历史文件已被替换");
        const candidates = (await this.#options.bridge.instances()).filter(meta => meta.persistedSessionId === target.id || meta.sessionId === `terminal:${target.id}` || meta.launchId === record.launchId);
        if (candidates.length > 1) throw new TerminalBridgeError("session_busy", "多个终端正在使用此历史");
        if (candidates.length === 1) {
          record.phase = "reconciling";
          return this.#verify(record, target, candidates[0]!);
        }
        const owners = await (this.#options.ownerPids ?? sessionOwnerPids)(target);
        if (owners.length) throw new TerminalBridgeError("session_busy", "历史仍有未桥接的运行进程");
        const status = await readRecoveryStatus(join(this.directory, `${record.operationId}.status`));
        const alreadyFailed = record.phase === "failed";
        record.phase = !record.commandPath || /^exited \d+ \d+\s*$/.test(status) ? "failed" : "outcome_unknown";
        if (!alreadyFailed || !record.errorCode) record.errorCode = /^exited \d+ \d+\s*$/.test(status) ? "omp_exited" : record.commandPath ? "launch_unconfirmed" : "not_running";
        return undefined;
      });
    } catch (error) {
      const info = await lstat(record.target.file).catch(() => null);
      const transient = error instanceof HistoryReadError && error.reason === "changed" && info && `${info.dev}:${info.ino}` === record.fileIdentity;
      record.phase = transient ? "reconciling" : "blocked";
      record.errorCode = transient ? "history_appending" : error instanceof TerminalBridgeError ? error.reason ?? error.code : "validation_failed";
    }
    await this.#save(record);
    if (session) await this.#applyModel(record, session);
    return this.#public(record, session);
  }

  #public(record: RecoveryRecord, meta?: TerminalSessionMeta): Record<string, unknown> {
    const state = record.phase === "ready" && meta ? "ready" : record.phase === "blocked" ? "blocked" : record.phase === "failed" ? "failed" : record.phase === "outcome_unknown" ? "unknown" : "pending";
    const errors: Record<string, string> = {
      binary_unavailable: "OMP 程序不存在或不可执行，请在 Mac 助手中检查运行时路径。",
      extension_unavailable: "桥接扩展源文件不可读，请重新安装或更新 Mac 助手。",
      history_changed: "历史文件或授权目录在恢复期间发生变化，请刷新历史列表。",
      omp_exited: "OMP 在启动后退出，请查看 Mac 终端中的错误，再点重试。",
      session_busy: "历史存在占用或实例冲突，请先在 Mac 上确认；未启动第二份会话。",
      history_appending: "历史正在更新，正在重新核对原运行实例。",
      owner_probe_failed: "本机进程占用检查未完成，未启动新进程。请稍后查询状态，勿手动同时打开此历史。",
      launch_unconfirmed: "启动结果尚未确认，不会再次启动。请检查 Mac 终端，再查询状态。",
      validation_failed: "历史文件、目录或恢复身份校验失败，请刷新列表或检查 Mac。",
      not_running: "原运行实例已退出，可以重新恢复。",
    };
    const data: Record<string, unknown> = { operationId: record.operationId, recoveryState: state, phase: record.phase === "ready" && !meta ? "verifying" : record.phase, canRetry: record.phase === "failed", branchPolicy: "last_recorded_or_live", approvalLocation: "mac_terminal", ...(record.errorCode ? { errorCode: record.errorCode, message: errors[record.errorCode] ?? "恢复未完成，请检查 Mac 后重试。" } : {}) };
    if (record.modelSelection) data.modelSelection = { ...record.modelSelection, requested: { ...record.modelSelection.requested } };
    if (meta && record.phase === "ready") {
      const { persistedSessionFile: _file, processId: _pid, instanceId: _instance, launchId: _launch, ...status } = meta;
      Object.assign(data, { sessionId: meta.sessionId, source: "terminal", status: { ...status, source: "terminal", state: "running", availability: "live", canControl: true } });
    }
    return data;
  }

  async #observeStatus(record: RecoveryRecord): Promise<void> {
    const status = await readRecoveryStatus(join(this.directory, `${record.operationId}.status`));
    const parsed = /^(waiting_omp|exited) (\d+)(?: (\d+))?\s*$/.exec(status);
    if (!parsed) return;
    const pid = Number(parsed[2]);
    if (record.wrapperPid === undefined) {
      record.wrapperPid = pid;
      record.wrapperIdentity = await (this.#options.processIdentity ?? processIdentity)(pid) ?? undefined;
    }
    if (parsed[1] === "exited" && parsed[3] !== undefined && record.wrapperPid === pid) record.exitCode = Number(parsed[3]);
    await this.#save(record);
  }


  async canControl(meta: TerminalSessionMeta): Promise<boolean> {
    await this.#loaded;
    const record = [...this.#records.values()].find(value => value.launchId === meta.launchId || value.target.id === meta.persistedSessionId || `terminal:${value.target.id}` === meta.sessionId);
    if (!record) return true;
    if (record.phase !== "ready") return false;
    if (!meta.instanceId || record.instanceId !== meta.instanceId || record.processId !== meta.processId || !meta.processId || record.processIdentity !== await (this.#options.processIdentity ?? processIdentity)(meta.processId)) {
      record.phase = "blocked";
      record.errorCode = "session_busy";
      await this.#save(record);
      return false;
    }
    let allowed = false;
    try {
      allowed = await this.#options.history.resumeStored(record.target, async target => {
        const fileInfo = await lstat(target.file);
        if (record.fileIdentity !== `${fileInfo.dev}:${fileInfo.ino}`) return false;
        const candidates = (await this.#options.bridge.instances()).filter(candidate => candidate.persistedSessionId === target.id || candidate.sessionId === meta.sessionId || candidate.launchId === record.launchId);
        if (candidates.length !== 1 || candidates[0]!.instanceId !== record.instanceId || !meta.persistedSessionFile || await realpath(meta.persistedSessionFile) !== target.file || await realpath(meta.cwd) !== target.cwd) return false;
        return !(await (this.#options.ownerPids ?? sessionOwnerPids)(target)).some(pid => pid !== meta.processId);
      });
    } catch (error) {
      const info = await lstat(record.target.file).catch(() => null);
      if (error instanceof HistoryReadError && error.reason === "changed" && info && `${info.dev}:${info.ino}` === record.fileIdentity) {
        record.phase = "reconciling";
        record.errorCode = "history_appending";
        await this.#save(record);
        return false;
      }
      allowed = false;
    }
    if (!allowed) { record.phase = "blocked"; record.errorCode = "validation_failed"; await this.#save(record); }
    return allowed && record.phase === "ready";
  }

  async wait(operationId: string): Promise<Record<string, unknown>> {
    await this.#loaded;
    const record = this.#operations.get(operationId) ?? [...this.#operations.values()].find(value => value.requestIds.includes(operationId));
    if (record) await this.#jobs.get(record.operationId);
    return this.query(operationId);
  }

  close(): void { this.#closed = true; }
}
