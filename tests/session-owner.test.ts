import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sessionOwnerPids } from "../src/terminal/session-owner.ts";

test("owner detection sees an unbridged process with an open history and clears after it exits", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-owner-test-"));
  const file = join(dir, "history.jsonl");
  writeFileSync(file, "synthetic history");
  const target = { file, id: `test-${randomUUID()}` };
  const child = spawn(process.execPath, ["-e", "require('node:fs').openSync(process.argv[1], 'r'); console.log('ready'); process.stdin.resume()", file], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    const owners = await sessionOwnerPids(target);
    assert.ok(owners.includes(child.pid!));
    const exited = once(child, "exit");
    child.kill(); await exited;
    assert.deepEqual(await sessionOwnerPids(target), []);
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test("an unowned lease plus the helper's read handle is not a writer, while partial-match external owners still block", { skip: process.platform !== "darwin" }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "owner-partial-match-")));
  const file = join(dir, "history.jsonl");
  const config = join(dir, "config");
  const locks = join(config, "run", "session-owners");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const id = `partial-${randomUUID()}`;
  writeFileSync(join(locks, `${id}.lock`), "", { mode: 0o600 });
  writeFileSync(file, "synthetic history", { mode: 0o600 });
  const previousConfig = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = config;
  const ownReadHandle = openSync(file, "r");
  const child = spawn(process.execPath, ["-e", "require('node:fs').openSync(process.argv[1], 'r'); console.log('ready'); process.stdin.resume()", file], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    assert.ok((await sessionOwnerPids({ file, id })).includes(child.pid!), "exit 1 with partial output must still preserve the real external owner");
    const exited = once(child, "exit");
    child.kill(); await exited;
    assert.deepEqual(await sessionOwnerPids({ file, id }), [], "own read handle and unowned stale lease must permit offline resume");
  } finally {
    child.kill(); closeSync(ownReadHandle);
    if (previousConfig === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
