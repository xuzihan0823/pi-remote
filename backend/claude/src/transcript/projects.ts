import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";

import type { SessionSummary } from "./types.ts";

export interface ProjectSummary {
  id: string;
  name: string;
  cwd: string;
  cwds: string[];
  sessionCount: number;
  lastActiveAt: number;
}

export interface ProjectCatalog {
  projects: ProjectSummary[];
  totalSessions: number;
  unclassifiedCount: number;
}

export interface ProjectIndex {
  catalog: ProjectCatalog;
  projectIdByCwd: ReadonlyMap<string, string>;
}

const GIT_TIMEOUT_MS = 1500;
const GIT_CONCURRENCY = 4;

async function readGit(cwd: string, args: string[]): Promise<string | undefined> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return new Promise((resolvePromise) => {
    execFile("git", args, {
      cwd,
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout) => resolvePromise(error === null ? stdout : undefined));
  });
}

async function resolveProjectId(cwd: string): Promise<string> {
  if (!isAbsolute(cwd) || cwd.includes("\0")) return cwd;
  const output = await readGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
  if (output === undefined) return cwd;
  const firstRecord = output.split("\0\0", 1)[0] ?? "";
  const fields = firstRecord.split("\0");
  const first = fields[0] ?? "";
  const root = first.startsWith("worktree ") ? first.slice("worktree ".length) : "";
  if (!isAbsolute(root)) return cwd;
  if (fields.includes("bare")) return root;

  // 独立 gitdir 的首条记录可能是元数据目录；普通仓库和 worktree 则使用主工作树路径。
  const paths = await readGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
  if (paths === undefined) return cwd;
  const [common, top, ...extra] = paths.replace(/\n$/, "").split("\n");
  if (extra.length !== 0 || common === undefined || top === undefined || !isAbsolute(top)) return cwd;
  return root === common ? top : root;
}

export async function buildProjectIndex(sessions: readonly SessionSummary[]): Promise<ProjectIndex> {
  const cwds = [...new Set(sessions.map((session) => session.cwd).filter((cwd) => cwd !== ""))];
  const projectIdByCwd = new Map<string, string>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(GIT_CONCURRENCY, cwds.length) }, async () => {
    while (cursor < cwds.length) {
      const cwd = cwds[cursor++]!;
      projectIdByCwd.set(cwd, await resolveProjectId(cwd));
    }
  }));

  const projects = new Map<string, ProjectSummary>();
  let unclassifiedCount = 0;
  const recent = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  for (const session of recent) {
    if (session.cwd === "") {
      unclassifiedCount += 1;
      continue;
    }
    const id = projectIdByCwd.get(session.cwd)!;
    const project = projects.get(id);
    if (project === undefined) {
      projects.set(id, {
        id,
        name: basename(id) || id,
        cwd: session.cwd,
        cwds: [session.cwd],
        sessionCount: 1,
        lastActiveAt: session.lastActiveAt,
      });
    } else {
      project.sessionCount += 1;
      if (!project.cwds.includes(session.cwd)) project.cwds.push(session.cwd);
    }
  }
  return {
    catalog: { projects: [...projects.values()], totalSessions: sessions.length, unclassifiedCount },
    projectIdByCwd,
  };
}
