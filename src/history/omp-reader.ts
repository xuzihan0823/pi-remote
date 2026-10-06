// OMP v3 format/tree semantics adapted from can1357/oh-my-pi at
// 093275112f7adff207608673c0e33c7f3d16e27f (MIT). No runtime or storage APIs are invoked.
/*
MIT License
Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { projectTranscript, safeText, type PiSessionEntry } from "../terminal/extension.ts";

export const HISTORY_LIMITS = { fileBytes: 128 * 1024 * 1024, recordBytes: 8 * 1024 * 1024, entries: 200_000, headerBytes: 64 * 1024 };
export class HistoryReadError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) { super(message); this.reason = reason; }
}
export interface HistoryHeader { id: string; version: 3; cwd: string; title: string; timestamp: string; additionalDirectories: string[] }
export interface EntryOffset {
  id: string; parentId: string | null; offset: number; length: number; itemIds: string[];
  calls: string[]; results: string[];
}
export interface HistoryTree {
  header: HistoryHeader; revision: string; nodes: Map<string, EntryOffset>; order: string[];
  duplicates: Set<string>; leaves: string[]; warnings: string[];
}
interface ChainEntry { path: string; stat: Stats; handle: FileHandle }

export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function identity(a: Stats, b: Stats, content = false): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid &&
    (!content || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
}
function privateNode(stat: Stats): boolean { return stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0; }

export class OmpReadSnapshot {
  readonly handle: FileHandle;
  readonly stat: Stats;
  readonly #chain: ChainEntry[];
  readonly #workspace: string;
  readonly #workspaceReal: string;
  readonly #file: string;
  readonly #signal?: AbortSignal;
  #authorized: { path: string; canonical: string; identity: Stats }[] = [];
  #closed = false;

  private constructor(handle: FileHandle, stat: Stats, chain: ChainEntry[], workspace: string, workspaceReal: string, file: string, signal?: AbortSignal) {
    this.handle = handle; this.stat = stat; this.#chain = chain;
    this.#workspace = workspace; this.#workspaceReal = workspaceReal; this.#file = file;
    this.#signal = signal;
  }

  static async open(root: string, file: string, workspace: string, signal?: AbortSignal): Promise<OmpReadSnapshot> {
    if (signal?.aborted) throw new HistoryReadError("closed", "历史读取已取消");
    const absoluteRoot = resolve(root);
    const absoluteFile = resolve(file);
    if (!within(absoluteRoot, absoluteFile)) throw new HistoryReadError("outside_root", "历史路径越界");
    const workspaceReal = await realpath(workspace);
    const chain: ChainEntry[] = [];
    let handle: FileHandle | undefined;
    try {
      // Open and retain every directory descriptor. Post-read verification rejects replacement
      // of any component, including parent symlinks; Node has no portable openat API.
      const components = absoluteFile.split(sep).filter(Boolean);
      let path: string = sep;
      for (const component of components.slice(0, -1)) {
        path = resolve(path, component);
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HistoryReadError("unsafe_path", "历史目录包含符号链接或非目录");
        if (within(absoluteRoot, path) && !privateNode(stat)) throw new HistoryReadError("permissions", "历史目录权限不安全");
        const dirHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        chain.push({ path, stat, handle: dirHandle });
        if (!identity(stat, await dirHandle.stat())) throw new HistoryReadError("changed", "历史目录已变化，请重试");
      }
      const stat = await lstat(absoluteFile);
      if (!stat.isFile() || stat.isSymbolicLink() || !privateNode(stat)) throw new HistoryReadError("permissions", "历史文件类型或权限不安全");
      if (stat.size > HISTORY_LIMITS.fileBytes) throw new HistoryReadError("file_limit", "历史文件超过 128 MiB 读取上限");
      handle = await open(absoluteFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!identity(stat, await handle.stat(), true)) throw new HistoryReadError("changed", "历史文件已变化，请重试");
      return new OmpReadSnapshot(handle, stat, chain, workspace, workspaceReal, absoluteFile, signal);
    } catch (error) {
      await handle?.close();
      await Promise.all(chain.map(item => item.handle.close()));
      throw error;
    }
  }

  async verify(): Promise<void> {
    if (this.#closed || this.#signal?.aborted) throw new HistoryReadError("closed", "历史读取已取消");
    for (const entry of this.#chain) {
      const current = await lstat(entry.path);
      if (!identity(entry.stat, current) || !identity(entry.stat, await entry.handle.stat()) || !current.isDirectory()) {
        throw new HistoryReadError("changed", "历史目录已被替换，请重试");
      }
      if (entry.stat.uid === process.getuid?.() && (current.mode & 0o022) !== 0) throw new HistoryReadError("permissions", "历史目录权限已变化");
    }
    if (!identity(this.stat, await lstat(this.#file), true) || !identity(this.stat, await this.handle.stat(), true)) {
      throw new HistoryReadError("changed", "历史文件已变化，请刷新");
    }
    if (await realpath(this.#workspace) !== this.#workspaceReal) throw new HistoryReadError("changed", "授权工作区已变化");
    for (const entry of this.#authorized) {
      if (await realpath(entry.path) !== entry.canonical || !within(this.#workspaceReal, entry.canonical) ||
        !identity(entry.identity, await stat(entry.canonical))) throw new HistoryReadError("workspace", "历史工作区授权已失效");
    }
  }

  async header(): Promise<HistoryHeader> {
    const bytes = Buffer.alloc(Math.min(this.stat.size, HISTORY_LIMITS.headerBytes));
    const { bytesRead } = await this.handle.read(bytes, 0, bytes.length, 0);
    const lines = bytes.subarray(0, bytesRead).toString("utf8").split("\n");
    let value: Record<string, unknown> | undefined;
    let title: string | undefined;
    for (const line of lines.slice(0, -1)) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line); } catch { throw new HistoryReadError("header", "历史头损坏"); }
      if (!value && parsed.type === "title" && title === undefined) { title = typeof parsed.title === "string" ? parsed.title : ""; continue; }
      value = parsed; break;
    }
    if (!value || value.type !== "session" || typeof value.id !== "string" || !value.id || value.id.length > 128 ||
      typeof value.cwd !== "string" || !isAbsolute(value.cwd)) throw new HistoryReadError("header", "缺失或过大的历史头");
    if (value.version !== 3) throw new HistoryReadError("version", "不支持的历史版本（仅支持 OMP v3）");
    if (value.additionalDirectories !== undefined && (!Array.isArray(value.additionalDirectories) ||
      !value.additionalDirectories.every(item => typeof item === "string" && isAbsolute(item)))) throw new HistoryReadError("workspace", "无效的附加工作区");
    const directories = [value.cwd, ...(value.additionalDirectories as string[] | undefined ?? [])];
    const canonical = await Promise.all(directories.map(path => realpath(path)));
    if (!canonical.every(path => within(this.#workspaceReal, path))) throw new HistoryReadError("workspace", "历史会话不在允许的工作区内");
    // Keep both spelling and identity: deleted/symlink-swapped workspaces fail closed.
    this.#authorized = await Promise.all(directories.map(async (path, index) => ({
      path, canonical: canonical[index]!, identity: await stat(canonical[index]!),
    })));
    for (const [index, path] of directories.entries()) {
      if (await realpath(path) !== canonical[index]) throw new HistoryReadError("changed", "工作区已变化");
    }
    return { id: value.id, version: 3, cwd: canonical[0]!,
      title: safeText(title ?? (typeof value.title === "string" ? value.title : "")).replace(/\s+/g, " ").slice(0, 80),
      timestamp: typeof value.timestamp === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.timestamp) ? value.timestamp : "", additionalDirectories: canonical.slice(1) };
  }

  async *lines(): AsyncGenerator<{ offset: number; length: number; bytes: Buffer }> {
    let position = 0;
    let pending = Buffer.alloc(0);
    let lineOffset = 0;
    while (position < this.stat.size) {
      if (this.#closed || this.#signal?.aborted) throw new HistoryReadError("closed", "历史读取已取消");
      const chunk = Buffer.alloc(Math.min(64 * 1024, this.stat.size - position));
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new HistoryReadError("changed", "历史文件读取不完整");
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline = pending.indexOf(10);
      while (newline >= 0) {
        if (newline > HISTORY_LIMITS.recordBytes) throw new HistoryReadError("record_limit", "历史单条记录超过 8 MiB 上限");
        yield { offset: lineOffset, length: newline, bytes: pending.subarray(0, newline) };
        lineOffset += newline + 1;
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
      if (pending.length > HISTORY_LIMITS.recordBytes) throw new HistoryReadError("record_limit", "历史单条记录超过 8 MiB 上限");
      await yieldTurn();
    }
    // An incomplete final line (including a split UTF-8 code point) is never indexed.
  }

  async tree(): Promise<HistoryTree> {
    const header = await this.header();
    const hash = createHash("sha256");
    const nodes = new Map<string, EntryOffset>();
    const duplicates = new Set<string>();
    const order: string[] = [];
    const warnings: string[] = [];
    let badLines = 0;
    let completeBytes = 0;
    for await (const line of this.lines()) {
      hash.update(line.bytes).update("\n");
      completeBytes = line.offset + line.length + 1;
      let entry: PiSessionEntry;
      try { entry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.bytes)); }
      catch { badLines++; continue; }
      if (!entry || typeof entry !== "object" || !entry.type) { badLines++; continue; }
      if (entry.type === "title" || entry.type === "session") continue;
      if (typeof entry.id !== "string" || !entry.id || entry.id.length > 128 || (entry.parentId !== null && typeof entry.parentId !== "string")) { badLines++; continue; }
      if (order.length >= HISTORY_LIMITS.entries) throw new HistoryReadError("entry_limit", "历史条目超过 200,000 上限");
      if (nodes.has(entry.id)) { duplicates.add(entry.id); continue; }
      const projection = projectTranscript([entry]);
      nodes.set(entry.id, { id: entry.id, parentId: entry.parentId, offset: line.offset, length: line.length,
        itemIds: projection.items.map(item => item.id),
        calls: projection.items.flatMap(item => item.kind === "toolCall" && item.toolCallId ? [item.toolCallId] : []),
        results: projection.items.flatMap(item => item.kind === "toolResult" && item.toolCallId ? [item.toolCallId] : []) });
      order.push(entry.id);
    }
    if (badLines) warnings.push(`不完整历史：${badLines} 条记录损坏`);
    if (completeBytes < this.stat.size) warnings.push("不完整历史：末尾记录尚未写完");
    if (duplicates.size) warnings.push("不完整历史：存在重复条目 ID");
    const parents = new Set([...nodes.values()].flatMap(node => node.parentId ? [node.parentId] : []));
    const leaves = order.filter(id => !parents.has(id));
    await this.verify();
    return { header, revision: hash.digest("hex"), nodes, order, duplicates, leaves, warnings };
  }

  async entry(node: EntryOffset): Promise<PiSessionEntry> {
    const bytes = Buffer.alloc(node.length);
    const { bytesRead } = await this.handle.read(bytes, 0, bytes.length, node.offset);
    if (bytesRead !== bytes.length) throw new HistoryReadError("changed", "历史记录已变化");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([this.handle.close(), ...this.#chain.map(entry => entry.handle.close())]);
  }
}

export function branchPath(tree: HistoryTree, leafId = tree.order.at(-1)): EntryOffset[] {
  if (!leafId) return [];
  const path: EntryOffset[] = [];
  const seen = new Set<string>();
  let id: string | null = leafId;
  while (id !== null) {
    if (seen.has(id) || tree.duplicates.has(id)) throw new HistoryReadError("branch", "分支损坏：循环或重复 ID，不能拼接正文");
    seen.add(id);
    const node = tree.nodes.get(id);
    if (!node) throw new HistoryReadError("branch", "分支损坏：缺少父条目，不能拼接正文");
    path.push(node); id = node.parentId;
  }
  return path.reverse();
}
