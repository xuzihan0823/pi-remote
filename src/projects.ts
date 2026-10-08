import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface MacProject { name: string; path: string }

export async function resolveProjectDirectory(defaultDirectory: string, requested?: unknown): Promise<string> {
  if (requested != null && (typeof requested !== "string" || !requested.trim() || requested.includes("\0"))) {
    throw new Error("请选择 Mac 上已有的项目目录");
  }
  try {
    const path = await realpath(requested == null ? defaultDirectory : resolve(defaultDirectory, requested as string));
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
    await access(path, constants.R_OK | constants.X_OK);
    return path;
  } catch {
    throw new Error("项目目录不存在或无法访问，请在 Mac 上检查权限后重新选择");
  }
}

export async function existingProjects(paths: readonly string[]): Promise<MacProject[]> {
  const projects = new Map<string, MacProject>();
  for (const candidate of new Set(paths)) {
    try {
      const path = await resolveProjectDirectory(candidate);
      if (!projects.has(path)) projects.set(path, { name: basename(path) || path, path });
    } catch { /* Deleted or inaccessible projects are not selectable. */ }
  }
  return [...projects.values()];
}

export async function browseProjectDirectory(defaultDirectory: string, requested?: unknown, offset: unknown = 0) {
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("目录分页参数无效");
  const path = await resolveProjectDirectory(defaultDirectory, requested);
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));
  const page = entries.slice(offset, offset + 100);
  const directories: MacProject[] = [];
  for (const entry of page) {
    try {
      await resolveProjectDirectory(path, entry.name);
      directories.push({ name: entry.name, path: resolve(path, entry.name) });
    } catch { /* Skip broken links, files and inaccessible directories. */ }
  }
  return { path, parent: dirname(path) === path ? null : dirname(path), directories,
    nextOffset: offset + page.length < entries.length ? offset + page.length : null };
}
