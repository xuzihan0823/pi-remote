import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { projectTranscript, TimelineViewService, TimelineRequestError, type TimelineContext, type ProjectedTranscript, type PiSessionEntry } from "../terminal/extension.ts";
import { OmpReadSnapshot, branchPath, HistoryReadError, type HistoryHeader, type HistoryTree, type EntryOffset } from "./omp-reader.ts";

export const HISTORY_PREFIX = "history:";
export function defaultOmpHistoryRoots(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string[] {
  if (env.OMP_HISTORY_ROOTS !== undefined) {
    let roots: unknown;
    try { roots = JSON.parse(env.OMP_HISTORY_ROOTS); } catch { throw new Error("OMP_HISTORY_ROOTS must be a JSON array of absolute paths"); }
    if (!Array.isArray(roots) || !roots.every(root => typeof root === "string" && isAbsolute(root))) throw new Error("OMP_HISTORY_ROOTS must be a JSON array of absolute paths");
    return [...new Set(roots.map(root => resolve(root)))];
  }
  const profile = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  const named = profile && profile !== "default" ? profile : undefined;
  if (named && (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(named) || named.endsWith(".") || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(named))) throw new Error("Invalid OMP profile");
  const config = join(home, env.PI_CONFIG_DIR || ".omp");
  const defaultAgent = named ? join(config, "profiles", named, "agent") : join(config, "agent");
  const agent = !named && env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : defaultAgent;
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) && (platform === "darwin" || platform === "linux")
    ? join(env.XDG_DATA_HOME, "omp", ...(named ? ["profiles", named] : [])) : undefined;
  return [join(agent === defaultAgent && xdg && existsSync(xdg) ? xdg : agent, "sessions")];
}

interface ArchiveRecord { alias: string; root: string; file: string; header: HistoryHeader; modifiedAt: number; identity: string }
export interface HistoryIndexOptions { workspaceRoot: string; roots: readonly string[]; scanIntervalMs?: number }
export interface LiveHistoryView {
  context: Omit<TimelineContext, "revision">;
  leaf: string | null;
  extraEntries?: readonly PiSessionEntry[];
}
export class OmpHistoryIndex {
  readonly #workspace: string;
  readonly #roots: readonly string[];
  readonly #interval: number;
  readonly #records = new Map<string, ArchiveRecord>();
  readonly #views = new TimelineViewService();
  readonly #secret = randomBytes(32);
  readonly #trees = new Map<string, { fingerprint: string; tree: HistoryTree }>();
  readonly #liveTimes = new Map<string, number>();
  readonly #cancel = new AbortController();
  readonly #watchers = new Map<string, FSWatcher>();
  #changeVersion = 0;
  #building: Promise<void> | null = null;
  #lastScan = 0;
  #closed = false;
  #activeReads = 0;
  readonly #readWaiters: (() => void)[] = [];
  #warnings: string[] = [];
  constructor(options: HistoryIndexOptions) {
    this.#workspace = resolve(options.workspaceRoot); this.#roots = options.roots;
    this.#interval = options.scanIntervalMs ?? 5_000;
  }

  async #withRead<T>(read: () => Promise<T>): Promise<T> {
    if (this.#activeReads < 2) this.#activeReads++;
    else await new Promise<void>(resolveWait => this.#readWaiters.push(resolveWait));
    try {
      if (this.#closed) throw new HistoryReadError("closed", "历史服务已停止");
      return await read();
    } finally {
      const next = this.#readWaiters.shift();
      if (next) next();
      else this.#activeReads--;
    }
  }

  #startScan(): void {
    if (this.#closed || this.#building || (this.#lastScan && Date.now() - this.#lastScan < this.#interval)) return;
    const version = this.#changeVersion;
    this.#building = this.#scan().catch(() => { this.#warnings = ["历史索引暂不可用，请检查本机目录权限"]; })
      .finally(() => { this.#lastScan = version === this.#changeVersion ? Date.now() : 0; this.#building = null; });
  }

  #watchDirectory(path: string): void {
    if (this.#closed || this.#watchers.has(path)) return;
    try {
      const watcher = watch(path, { persistent: false }, () => { this.#changeVersion++; this.#lastScan = 0; });
      watcher.on("error", () => {
        watcher.close();
        this.#watchers.delete(path);
        this.#changeVersion++;
        this.#lastScan = 0;
      });
      this.#watchers.set(path, watcher);
    } catch {}
  }

  async #scan(): Promise<void> {
    const seen = new Set<string>();
    const warnings: string[] = [];
    const watched = new Set<string>();
    let candidates = 0;
    for (const root of this.#roots) {
      if (this.#closed) return;
      let buckets: string[];
      try {
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error("unsafe root");
        this.#watchDirectory(root);
        watched.add(root);
        buckets = await readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push("历史根权限不安全或不可读取");
        continue;
      }
      for (const bucket of buckets.sort()) {
        if (this.#closed) return;
        let names: string[];
        try {
          const path = join(root, bucket);
          const stat = await lstat(path);
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) continue;
          this.#watchDirectory(path);
          watched.add(path);
          names = await readdir(path);
        } catch { continue; }
        for (const name of names.filter(name => name.endsWith(".jsonl")).sort()) {
          if (++candidates > 10_000) { warnings.push("历史列表达到 10,000 文件扫描上限，结果不完整"); break; }
          const file = join(root, bucket, name);
          await this.#withRead(async () => {
            let snapshot: OmpReadSnapshot | undefined;
            try {
              snapshot = await OmpReadSnapshot.open(root, file, this.#workspace, this.#cancel.signal);
              const header = await snapshot.header();
              await snapshot.verify();
              if (this.#closed) return;
              const identity = `${snapshot.stat.dev}:${snapshot.stat.ino}`;
              const existing = this.#records.get(file);
              this.#records.set(file, { alias: existing && existing.header.id === header.id
                ? existing.alias : `${HISTORY_PREFIX}${randomUUID()}`, root, file, header, identity, modifiedAt: snapshot.stat.mtimeMs });
              seen.add(file);
            } catch (error) {
              if (error instanceof HistoryReadError && !["workspace", "outside_root"].includes(error.reason)) warnings.push(error.message);
            } finally { await snapshot?.close(); }
          });
          await yieldTurn();
        }
        if (candidates > 10_000) break;
      }
    }
    for (const file of this.#records.keys()) if (!seen.has(file)) this.#records.delete(file);
    for (const [path, watcher] of this.#watchers) if (!watched.has(path)) { watcher.close(); this.#watchers.delete(path); }
    this.#warnings = [...new Set(warnings)].slice(0, 20);
  }

  async ready(): Promise<void> { this.#startScan(); await this.#building; }

  async projectDirectories(): Promise<string[]> {
    await this.ready();
    return [...new Set([...this.#records.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map(record => record.header.cwd))];
  }

  async list(params: Record<string, unknown>, live: readonly Record<string, unknown>[] = []): Promise<Record<string, unknown>> {
    if (params.cursor == null) this.#startScan();
    await this.#building;
    let records = [...this.#records.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || a.alias.localeCompare(b.alias));
    const canonicalLive = await Promise.all(live.map(async session => ({ session, cwd: typeof session.cwd === "string" ? await realpath(session.cwd).catch(() => null) : null })));
    const identityCounts = new Map<string, number>();
    for (const record of records) {
      const key = `${record.header.cwd}\0${record.header.id}`;
      identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
    }
    records = records.filter(record => identityCounts.get(`${record.header.cwd}\0${record.header.id}`)! > 1 ||
      !canonicalLive.some(({ session, cwd }) => session.canControl !== false && session.runtime === "omp" && session.persistedSessionId === record.header.id && cwd === record.header.cwd));
    const liveIds = new Set(live.map(session => String(session.sessionId)));
    for (const id of this.#liveTimes.keys()) if (!liveIds.has(id)) this.#liveTimes.delete(id);
    for (const id of liveIds) if (!this.#liveTimes.has(id)) this.#liveTimes.set(id, Date.now());
    let entries: { alias: string; modifiedAt: number; record?: ArchiveRecord; session?: Record<string, unknown> }[] = [
      ...records.map(record => ({ alias: record.alias, modifiedAt: record.modifiedAt, record })),
      ...live.map(session => ({ alias: String(session.sessionId), modifiedAt: typeof session.startedAt === "number" && Number.isFinite(session.startedAt)
        ? session.startedAt : this.#liveTimes.get(String(session.sessionId))!, session })),
    ];
    entries.sort((a, b) => b.modifiedAt - a.modifiedAt || a.alias.localeCompare(b.alias));
    if (params.cursor != null) {
      const cursor = this.#decode(params.cursor, "list");
      entries = entries.filter(entry => entry.modifiedAt < Number(cursor.time) ||
        (entry.modifiedAt === cursor.time && entry.alias.localeCompare(String(cursor.alias)) > 0));
    }
    const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(30, Math.floor(params.limit))) : 30;
    const candidates = entries.slice(0, limit);
    const sessions: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      if (candidate.session) { sessions.push({ ...candidate.session, startedAt: candidate.modifiedAt }); continue; }
      const record = candidate.record!;
      await this.#withRead(async () => {
        let snapshot: OmpReadSnapshot | undefined;
        try {
          snapshot = await OmpReadSnapshot.open(record.root, record.file, this.#workspace, this.#cancel.signal);
          const header = await snapshot.header();
          await snapshot.verify();
          if (header.id !== record.header.id) throw new HistoryReadError("changed", "历史身份已变化");
          record.header = header;
          sessions.push({ sessionId: record.alias, source: "terminal", runtime: "omp", availability: "archived",
            state: "unknown", activity: "unknown", lastOutcome: "unknown", canControl: false,
            title: header.title || `历史会话 ${header.timestamp.slice(0, 10) || "（无标题）"}`,
            cwd: header.cwd, project: header.cwd.split("/").at(-1) || header.cwd, startedAt: record.modifiedAt,
            ...(identityCounts.get(`${header.cwd}\0${header.id}`)! > 1 ? { conflict: true, error: "存在冲突历史副本，仅可只读浏览" } : {}) });
        } catch {
          this.#records.delete(record.file);
          this.#trees.delete(record.file);
        } finally { await snapshot?.close(); }
      });
    }
    const last = candidates.at(-1);
    return { sessions, nextCursor: entries.length > candidates.length && last ? this.#token({ kind: "list", time: last.modifiedAt, alias: last.alias }) : null,
      indexState: this.#building ? "building" : "ready", warnings: this.#warnings };
  }

  async archivedForPersistedId(id: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ready();
    const matches = [...this.#records.values()].filter(record => record.header.id === id);
    if (matches.length !== 1) throw new HistoryReadError("alias", "原历史不存在或存在冲突，请刷新会话列表");
    const alias = matches[0]!.alias;
    return { ...await this.get(alias, params), historySessionId: alias };
  }

  async live(target: { file: string; id: string }, params: Record<string, unknown>, view: LiveHistoryView): Promise<Record<string, unknown>> {
    await this.ready();
    const record = this.#records.get(target.file);
    if (!record || record.header.id !== target.id) throw new HistoryReadError("alias", "后台原历史已变化");
    return this.get(record.alias, params, view);
  }

  async get(alias: string, params: Record<string, unknown>, live?: LiveHistoryView): Promise<Record<string, unknown>> {
    const record = [...this.#records.values()].find(record => record.alias === alias);
    if (!record) throw new HistoryReadError("alias", "历史引用已失效，请刷新会话列表");
    if (params.viewVersion !== 2) throw new TimelineRequestError("历史阅读需要 v2 客户端");
    return this.#withRead(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const snapshot = await OmpReadSnapshot.open(record.root, record.file, this.#workspace, this.#cancel.signal);
        try {
          const fingerprint = `${snapshot.stat.dev}:${snapshot.stat.ino}:${snapshot.stat.size}:${snapshot.stat.mtimeMs}:${snapshot.stat.ctimeMs}`;
          const cached = this.#trees.get(record.file);
          let tree: HistoryTree;
          if (cached?.fingerprint === fingerprint) {
            const header = await snapshot.header();
            tree = { ...cached.tree, header };
            await snapshot.verify();
            this.#trees.delete(record.file);
          } else {
            tree = await snapshot.tree();
          }
          this.#trees.set(record.file, { fingerprint, tree });
          let nodeCount = [...this.#trees.values()].reduce((count, entry) => count + entry.tree.nodes.size, 0);
          while (this.#trees.size > 8 || nodeCount > 400_000) {
            const oldest = this.#trees.keys().next().value!;
            nodeCount -= this.#trees.get(oldest)!.tree.nodes.size;
            this.#trees.delete(oldest);
          }
          if (tree.header.id !== record.header.id) throw new HistoryReadError("changed", "历史文件已被替换");
          let leaf = live ? live.leaf ?? undefined : tree.order.at(-1);
          if (!live && params.branchId != null) {
            const branch = this.#decode(params.branchId, "branch");
            if (branch.alias !== alias || branch.revision !== tree.revision || typeof branch.leaf !== "string" || !tree.nodes.has(branch.leaf)) throw new TimelineRequestError("分支引用已失效");
            leaf = branch.leaf;
          }
          const branchId = typeof params.branchId === "string" ? params.branchId :
            this.#token({ kind: "branch", alias, revision: tree.revision, leaf: leaf ?? "" });
          const path = branchPath(tree, leaf);
          let extras = live?.extraEntries ?? [];
          if (extras.length) {
            const tail = await Promise.all(path.slice(-8).map(node => snapshot.entry(node)));
            extras = extras.filter(extra => !tail.some(entry => entry.message?.role === extra.message?.role &&
              typeof extra.message?.timestamp === "number" && entry.message?.timestamp === extra.message.timestamp));
          }
          const context: TimelineContext = live ? { ...live.context, revision: createHash("sha256").update(tree.revision).update(JSON.stringify(extras)).digest("hex") } :
            { sessionId: alias, branchId, revision: tree.revision, availability: "archived", canControl: false, activity: "unknown" };
          if (live && params.branchId !== undefined && params.branchId !== context.branchId) throw new TimelineRequestError("当前分支已变化，请刷新");
          if (params.view === "branches") {
            const branches = tree.leaves.map((id, index) => {
              let damaged = false;
              try { branchPath(tree, id); } catch { damaged = true; }
              return { id: this.#token({ kind: "branch", alias, revision: tree.revision, leaf: id }), title: id === tree.order.at(-1) ? "最后记录分支" : `分支 ${index + 1}`, damaged };
            });
            if (branches.length > 1000) throw new HistoryReadError("branches_limit", "分支数量超过 1,000 上限");
            await snapshot.verify();
            return { ...context, branches, warnings: tree.warnings };
          }
          const itemRefs: { id: string; node?: EntryOffset }[] = [
            ...path.flatMap(node => node.itemIds.map(id => ({ id, node }))),
            ...projectTranscript(extras).items.map(item => ({ id: item.id })),
          ];
          const targetId = params.view === "tool" ? this.#views.detailItemId(context, params) : undefined;
          const range = targetId ? { start: 0, end: 0 } : this.#views.pageRange(context, itemRefs.length, params, itemRefs.map(item => item.id));
          const selected = targetId ? itemRefs.filter(item => item.id === targetId) : itemRefs.slice(range.start, range.end);
          if (targetId && !selected.length) throw new TimelineRequestError("详情不属于当前分支");
          const selectedNodes = new Set(selected.flatMap(item => item.node ? [item.node] : []));
          const callNodes = new Map<string, EntryOffset[]>();
          const resultNodes = new Map<string, EntryOffset[]>();
          for (const node of path) {
            for (const id of node.calls) callNodes.set(id, [...(callNodes.get(id) ?? []), node]);
            for (const id of node.results) resultNodes.set(id, [...(resultNodes.get(id) ?? []), node]);
          }
          for (const node of [...selectedNodes]) {
            for (const id of [...node.calls, ...node.results]) {
              if (callNodes.get(id)?.length === 1 && resultNodes.get(id)?.length === 1) {
                selectedNodes.add(callNodes.get(id)![0]!); selectedNodes.add(resultNodes.get(id)![0]!);
              }
            }
          }
          const entries: PiSessionEntry[] = [];
          for (const node of path) if (selectedNodes.has(node)) entries.push(await snapshot.entry(node));
          entries.push(...extras);
          const projected = projectTranscript(entries);
          for (const item of projected.items) if (item.toolCallId && ((callNodes.get(item.toolCallId)?.length ?? 0) > 1 || (resultNodes.get(item.toolCallId)?.length ?? 0) > 1)) {
            item.status = "unknown";
            projected.warnings.push("工具 ID 冲突，未配对详情");
            if (item.kind === "toolCall") projected.details[item.id] = { arguments: projected.details[item.id]?.arguments };
          }
          const wanted = new Set(selected.map(item => item.id));
          const projection: ProjectedTranscript = { ...projected, items: projected.items.filter(item => wanted.has(item.id)),
            offset: range.start, total: itemRefs.length, warnings: [...tree.warnings, ...projected.warnings] };
          const response = this.#views.respond(context, projection, params, range);
          await snapshot.verify();
          if (this.#closed) throw new HistoryReadError("closed", "历史读取已取消");
          return response;
        } catch (error) {
          if (!(error instanceof HistoryReadError && error.reason === "changed" && attempt === 0)) throw error;
        } finally { await snapshot.close(); }
      }
      throw new HistoryReadError("changed", "历史持续变化，请重试");
    });
  }

  async resume<T>(alias: string, operation: (target: { file: string; id: string; cwd: string; verify: () => Promise<void> }) => Promise<T>): Promise<T> {
    const record = [...this.#records.values()].find(record => record.alias === alias);
    if (!record) throw new HistoryReadError("alias", "历史引用已失效，请刷新会话列表");
    const snapshot = await this.#withRead(async () => {
      const snapshot = await OmpReadSnapshot.open(record.root, record.file, this.#workspace, this.#cancel.signal);
      try {
        const header = await snapshot.header();
        if (header.id !== record.header.id || header.cwd !== record.header.cwd) throw new HistoryReadError("changed", "历史身份已变化，请刷新后重试");
        if (await this.hasConflict({ runtime: "omp", persistedSessionId: header.id, cwd: header.cwd })) {
          throw new HistoryReadError("conflict", "存在冲突历史副本，请先在 Mac 上确认要继续的会话");
        }
        await snapshot.verify();
        return snapshot;
      } catch (error) { await snapshot.close(); throw error; }
    });
    try {
      return await operation({ file: record.file, id: record.header.id, cwd: record.header.cwd, verify: () => snapshot.verify() });
    } finally { await snapshot.close(); }
  }

  async resumeStored<T>(target: { file: string; id: string; cwd: string }, operation: (target: { file: string; id: string; cwd: string; verify: () => Promise<void> }) => Promise<T>): Promise<T> {
    await this.ready();
    const record = [...this.#records.values()].find(record => record.file === target.file && record.header.id === target.id && record.header.cwd === target.cwd);
    if (!record) throw new HistoryReadError("alias", "恢复目标已不在授权历史索引中，请刷新会话列表");
    return this.resume(record.alias, operation);
  }

  async hasConflict(session: { runtime?: unknown; persistedSessionId?: unknown; cwd?: unknown }): Promise<boolean> {
    if (session.runtime !== "omp" || typeof session.persistedSessionId !== "string" || typeof session.cwd !== "string") return false;
    const cwd = await realpath(session.cwd).catch(() => null);
    return [...this.#records.values()].filter(record => record.header.id === session.persistedSessionId && record.header.cwd === cwd).length > 1;
  }


  #token(value: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify({ ...value, expires: (Math.floor(Date.now() / 900_000) + 2) * 900_000 })).toString("base64url");
    return `${body}.${createHmac("sha256", this.#secret).update(body).digest("base64url")}`;
  }
  #decode(raw: unknown, kind: string): Record<string, unknown> {
    if (typeof raw !== "string" || raw.length > 4096) throw new TimelineRequestError("无效的历史引用");
    const [body, sig] = raw.split(".");
    if (!body || sig !== createHmac("sha256", this.#secret).update(body).digest("base64url")) throw new TimelineRequestError("无效的历史引用");
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.kind !== kind || Number(value.expires) < Date.now()) throw new TimelineRequestError("历史引用已过期");
    return value;
  }
  close(): void {
    this.#closed = true;
    this.#cancel.abort();
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    this.#records.clear(); this.#trees.clear(); this.#liveTimes.clear();
  }
}
