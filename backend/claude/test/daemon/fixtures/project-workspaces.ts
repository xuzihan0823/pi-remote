import { execFileSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

export async function projectWorkspaces(root: string) {
  const canonicalRoot = await realpath(root);
  const repo = join(canonicalRoot, "repo with spaces");
  const worktree = join(canonicalRoot, "linked workspace");
  const nested = join(repo, "src");
  const plainA = join(canonicalRoot, "a", "same-name");
  const plainB = join(canonicalRoot, "b", "same-name");
  const missing = join(canonicalRoot, "deleted-workspace");
  for (const dir of [repo, nested, plainA, plainB]) await mkdir(dir, { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch=main");
  const tree = git(repo, "write-tree");
  const commit = git(repo, "commit-tree", tree, "-m", "test fixture");
  git(repo, "update-ref", "refs/heads/main", commit);
  git(repo, "worktree", "add", "--quiet", "--detach", worktree);
  return { repo, worktree, nested, plainA, plainB, missing };
}
