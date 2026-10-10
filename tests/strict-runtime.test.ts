import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RpcClient } from "../src/pi/rpc-client.ts";

export async function strictFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-strict-")));
  const cwd = join(root, "workspace 'quoted'");
  await mkdir(cwd, { mode: 0o700 });
  const id = randomUUID();
  const file = join(root, `${id}.jsonl`);
  const timestamp = new Date().toISOString();
  await writeFile(file, [
    { type: "session", version: 3, id, cwd, timestamp },
    { type: "message", id: "first", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "synthetic old history" }], timestamp: Date.now() } },
    { type: "message", id: "sibling", parentId: "first", timestamp, message: { role: "user", content: [{ type: "text", text: "wrong branch" }], timestamp: Date.now() } },
    { type: "message", id: "leaf", parentId: "first", timestamp, message: { role: "user", content: [{ type: "text", text: "correct last branch" }], timestamp: Date.now() } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  return { root, cwd, id, file };
}

function runtime(target: { file: string; id: string; cwd: string }, owners: string) {
  return new RpcClient({
    sessionId: target.id, piBin: process.env.PI_LIVE_BUN_BIN ?? "/Users/mac/.bun/bin/bun", cwd: target.cwd,
    args: ["--session", target.file, "--no-extensions", "--no-skills", "--no-tools"], startupDelayMs: 0,
    env: { ...process.env, PI_TEST_SESSION_OWNERS_DIR: owners, PI_REMOTE_STRICT_TARGET: JSON.stringify({ ...target, launchId: randomUUID(), instanceId: randomUUID() }) },
    spawnFn: (bin, args, options) => spawn(bin, [process.env.PI_LIVE_CONTROLLED_RUNTIME ?? resolve("runtime/omp/run.ts"), ...args], options),
    requestTimeoutMs: 30_000,
  });
}

test("strict SDK holds the original native lease before first write, preserves branch, refuses implicit fork and survives own atomic rewrite", { skip: process.env.PI_STRICT_RUNTIME !== "1", timeout: 90_000 }, async () => {
  const target = await strictFixture();
  const owners = join(target.root, "owners");
  const first = runtime(target, owners);
  const second = runtime(target, owners);
  const original = await readFile(target.file, "utf8");
  try {
    await first.start();
    const state = await first.send<{ sessionId: string; sessionFile: string }>({ type: "get_state" });
    assert.equal(state.sessionId, target.id);
    assert.equal(state.sessionFile, target.file);
    const tree = await first.send<{ leafId: string }>({ type: "get_tree" });
    assert.equal(tree.leafId, "leaf");
    assert.equal(await readFile(target.file, "utf8"), original);
    await second.start();
    await assert.rejects(second.send({ type: "get_state" }), /strict_history_owned|exited/);
    await assert.rejects(first.send({ type: "new_session" }), /relocation_forbidden/);
    await assert.rejects(first.send({ type: "fork" }), /relocation_forbidden/);
    await first.send({ type: "set_session_name", name: "Strict synthetic title" });
    assert.equal((await first.send<{ sessionId: string }>({ type: "get_state" })).sessionId, target.id);
    assert.equal((await readdir(target.root)).filter(name => name.endsWith(".jsonl")).length, 1);
    const replacement = `${target.file}.replacement`;
    await writeFile(replacement, await readFile(target.file));
    await rename(replacement, target.file);
    const exited = Promise.withResolvers<void>();
    const detach = first.onEvent(event => { if (event.type === "process_exit") exited.resolve(); });
    await exited.promise;
    detach();
    await assert.rejects(first.send({ type: "get_state" }), /replaced|exited/);
  } finally { await Promise.all([first.close(), second.close()]); }
});

test("strict runtime releases its native lease after a crash and refuses deleted or permission-invalid originals without creating a replacement", { skip: process.env.PI_STRICT_RUNTIME !== "1", timeout: 90_000 }, async () => {
  const target = await strictFixture();
  const owners = join(target.root, "owners");
  const first = runtime(target, owners);
  const second = runtime(target, owners);
  try {
    await first.start();
    await first.send({ type: "get_state" });
    const exited = Promise.withResolvers<void>();
    first.onEvent(event => { if (event.type === "process_exit") exited.resolve(); });
    process.kill(first.pid!, "SIGKILL");
    await exited.promise;
    await second.start();
    assert.equal((await second.send<{ sessionId: string }>({ type: "get_state" })).sessionId, target.id);
    const denied = Promise.withResolvers<void>();
    second.onEvent(event => { if (event.type === "process_exit") denied.resolve(); });
    await chmod(target.file, 0o400);
    await denied.promise;
    await assert.rejects(second.send({ type: "set_session_name", name: "must-not-write" }), /exited/);
    assert.deepEqual((await readdir(target.root)).filter(name => name.endsWith(".jsonl")), [`${target.id}.jsonl`]);
    await chmod(target.file, 0o600);
    await unlink(target.file);
    const missing = runtime(target, owners);
    try {
      await missing.start();
      await assert.rejects(missing.send({ type: "get_state" }), /exited|ENOENT/);
    } finally { await missing.close(); }
    assert.equal((await readdir(target.root)).filter(name => name.endsWith(".jsonl")).length, 0);
  } finally { await Promise.all([first.close(), second.close()]); }
});
