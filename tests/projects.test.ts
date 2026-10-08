import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browseProjectDirectory, existingProjects, resolveProjectDirectory } from "../src/projects.ts";

test("Mac directory browser paginates existing folders, including projects without sessions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-picker-")));
  try {
    for (let n = 0; n < 105; n++) mkdirSync(join(root, `project-${String(n).padStart(3, "0")}`));
    writeFileSync(join(root, "not-a-project.txt"), "must not appear as a project");
    const first = await browseProjectDirectory(root);
    assert.equal(first.path, root);
    assert.equal(first.directories.length, 100);
    assert.equal(first.nextOffset, 100);
    const second = await browseProjectDirectory(root, root, first.nextOffset);
    assert.equal(second.directories.length, 5);
    assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.directories, ...second.directories].map(project => project.path)).size, 105);
    for (const project of [...first.directories, ...second.directories]) {
      assert.equal(await resolveProjectDirectory(root, project.path), project.path);
    }
    for (const offset of [-1, 1.5, "100", Infinity]) await assert.rejects(browseProjectDirectory(root, root, offset));
    await assert.rejects(browseProjectDirectory(root, join(root, "not-a-project.txt")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recent projects use canonical paths, deduplicate aliases and omit removed folders", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-picker-")));
  try {
    const project = join(root, "项目 with spaces");
    mkdirSync(project);
    symlinkSync(project, join(root, "alias"));
    symlinkSync(join(root, "missing"), join(root, "broken"));
    writeFileSync(join(root, "file"), "not a directory");
    const projects = await existingProjects([project, project, join(root, "alias"), join(root, "missing"), join(root, "file")]);
    assert.deepEqual(projects, [{ name: "项目 with spaces", path: project }]);
    const page = await browseProjectDirectory(root);
    assert.deepEqual(page.directories.map(directory => directory.name).sort(), ["alias", "项目 with spaces"].sort());
    rmSync(project, { recursive: true });
    await assert.rejects(resolveProjectDirectory(root, project));
    await assert.rejects(resolveProjectDirectory(root, "a\0b"));
    assert.equal((await browseProjectDirectory(root, "/")).parent, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
