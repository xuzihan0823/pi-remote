import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildProjectIndex } from "../../src/transcript/projects.ts";
import type { SessionSummary } from "../../src/transcript/types.ts";
import { git, projectWorkspaces } from "./fixtures/project-workspaces.ts";

function summary(cwd: string, lastActiveAt: number): SessionSummary {
  return {
    sessionId: `session-${lastActiveAt}`, cwd, lastActiveAt,
    projectDirName: "fixture", title: "test", lastPreview: "", sizeBytes: 1, status: "idle",
  };
}

test("project projection merges worktrees/subdirectories, preserves runnable cwds and recent ordering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claude-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, worktree, nested, plainA, plainB, missing } = await projectWorkspaces(root);
  const sessions = [
    summary(nested, 10), summary(repo, 30), summary(worktree, 90), summary(worktree, 50),
    summary(plainA, 80), summary(plainB, 70), summary(missing, 60), summary("", 100),
  ];
  const { catalog, projectIdByCwd } = await buildProjectIndex(sessions);
  assert.equal(catalog.totalSessions, 8);
  assert.equal(catalog.unclassifiedCount, 1);
  assert.deepEqual(catalog.projects, [
    { id: repo, name: "repo with spaces", cwd: worktree, cwds: [worktree, repo, nested], sessionCount: 4, lastActiveAt: 90 },
    { id: plainA, name: "same-name", cwd: plainA, cwds: [plainA], sessionCount: 1, lastActiveAt: 80 },
    { id: plainB, name: "same-name", cwd: plainB, cwds: [plainB], sessionCount: 1, lastActiveAt: 70 },
    { id: missing, name: "deleted-workspace", cwd: missing, cwds: [missing], sessionCount: 1, lastActiveAt: 60 },
  ]);
  assert.equal(projectIdByCwd.get(nested), repo);
  assert.equal(projectIdByCwd.get(worktree), repo);
  assert.equal(projectIdByCwd.has(""), false);
  assert.deepEqual(sessions.map((session) => session.lastActiveAt), [10, 30, 90, 50, 80, 70, 60, 100]);

  const worktreeOnly = await buildProjectIndex([summary(worktree, 1)]);
  assert.deepEqual(worktreeOnly.catalog.projects[0]?.cwds, [worktree]);
  assert.equal(worktreeOnly.catalog.projects[0]?.id, repo);
  assert.equal(worktreeOnly.catalog.projects[0]?.cwd, worktree);
});

test("bare common directory remains the repository identity instead of its parent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claude-projects-bare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const bare = join(canonicalRoot, "repository.git");
  await mkdir(bare);
  git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
  const tree = git(bare, "write-tree");
  const commit = git(bare, "commit-tree", tree, "-m", "bare fixture");
  git(bare, "update-ref", "refs/heads/main", commit);
  const worktree = join(canonicalRoot, "bare-linked-workspace");
  git(bare, "worktree", "add", "--quiet", "--detach", worktree);
  const { catalog } = await buildProjectIndex([summary(worktree, 2), summary(bare, 1)]);
  assert.deepEqual(catalog.projects, [{
    id: bare, name: "repository.git", cwd: worktree, cwds: [worktree, bare], sessionCount: 2, lastActiveAt: 2,
  }]);
});

test("separate git metadata does not become the working repository root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claude-projects-gitdir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const repo = join(canonicalRoot, "working-repository");
  const nested = join(repo, "src");
  git(canonicalRoot, "init", "--quiet", "--separate-git-dir", join(canonicalRoot, "metadata.git"), repo);
  await mkdir(nested);
  const { catalog } = await buildProjectIndex([summary(nested, 2), summary(repo, 1)]);
  assert.deepEqual(catalog.projects, [{
    id: repo, name: "working-repository", cwd: nested, cwds: [nested, repo], sessionCount: 2, lastActiveAt: 2,
  }]);
});

test("empty data, missing cwds, invalid paths and case-distinct non-Git paths preserve identity", async () => {
  assert.deepEqual((await buildProjectIndex([])).catalog, { projects: [], totalSessions: 0, unclassifiedCount: 0 });
  const { catalog } = await buildProjectIndex([
    summary("", 9), summary("", 8), summary("/missing/Project", 3), summary("/missing/project", 2),
    summary("relative-path", 1), summary("invalid\0path", 0),
  ]);
  assert.equal(catalog.unclassifiedCount, 2);
  assert.equal(catalog.totalSessions, 6);
  assert.deepEqual(catalog.projects.map((project) => project.id), [
    "/missing/Project", "/missing/project", "relative-path", "invalid\0path",
  ]);
});
