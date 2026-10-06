import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultOmpHistoryRoots, OmpHistoryIndex } from "../src/history/history-index.ts";
import { branchPath, HistoryReadError, OmpReadSnapshot } from "../src/history/omp-reader.ts";
import { projectTranscript, TimelineRequestError, TimelineViewService, type PiSessionEntry } from "../src/terminal/extension.ts";
import { createPiAgentHandler } from "../src/agent/pi-agent-handler.ts";
import { PiProcessManager } from "../src/pi/process-manager.ts";
import { requestFrame } from "./helpers/relay-harness.ts";

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "omp-history-fixture-"));
  const workspace = join(dir, "workspace");
  const root = join(dir, "sessions");
  const bucket = join(root, "synthetic-bucket");
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(bucket, { recursive: true, mode: 0o700 });
  const file = join(bucket, "2026-10-07_fixture.jsonl");
  const header = { type: "session", version: 3, id: "fixture", cwd: workspace, timestamp: "2026-10-07T00:00:00Z" };
  const save = (entries: unknown[], extra = {}) => writeFileSync(file, [JSON.stringify({ type: "title", v: 1, title: "合成历史", pad: "" }).padEnd(255),
    JSON.stringify({ ...header, ...extra }), ...entries.map(entry => typeof entry === "string" ? entry : JSON.stringify(entry))].join("\n") + "\n", { mode: 0o600 });
  return { dir, workspace, root, bucket, file, header, save, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function msg(id: string, parentId: string | null, text: string, role = "assistant"): PiSessionEntry {
  return { type: "message", id, parentId, message: { role, content: [{ type: "text", text }] } };
}
async function aliasOf(index: OmpHistoryIndex): Promise<string> {
  await index.ready();
  return ((await index.list({})).sessions as { sessionId: string }[])[0]!.sessionId;
}

test("v3 title slot and parent tree preserve compaction/reset text, not siblings or secrets", async () => {
  const f = fixture();
  try {
    f.save([msg("a", null, "压缩前正文"), msg("sibling", "a", "兄弟正文不应出现"),
      { type: "compaction", id: "c", parentId: "a", summary: "安全摘要", details: { providerPayload: "secret" } },
      { type: "reset_boundary", id: "r", parentId: "c" }, msg("z", "r", "最后记录分支正文")]);
    const before = readFileSync(f.file);
    const snapshot = await OmpReadSnapshot.open(f.root, f.file, f.workspace);
    try {
      const tree = await snapshot.tree();
      assert.equal(tree.header.title, "合成历史");
      assert.deepEqual(branchPath(tree).map(node => node.id), ["a", "c", "r", "z"]);
      assert.equal(tree.leaves.length, 2);
      const entries = await Promise.all(branchPath(tree).map(node => snapshot.entry(node)));
      const projection = projectTranscript(entries);
      assert.deepEqual(projection.items.map(item => item.text), ["压缩前正文", "上下文已压缩", "上下文已清空", "最后记录分支正文"]);
      assert.ok(!JSON.stringify(projection).includes("providerPayload"));
    } finally { await snapshot.close(); }
    assert.deepEqual(readFileSync(f.file), before, "reader must never write the source");
  } finally { f.cleanup(); }
});

test("missing parents, duplicates and cycles reject affected branches", async () => {
  for (const entries of [[msg("x", "missing", "gap")], [msg("x", null, "first"), msg("x", null, "second")],
    [msg("x", "y", "x"), msg("y", "x", "y")]]) {
    const f = fixture();
    try {
      f.save(entries);
      const snapshot = await OmpReadSnapshot.open(f.root, f.file, f.workspace);
      try {
        const tree = await snapshot.tree();
        assert.throws(() => branchPath(tree), HistoryReadError);
      } finally { await snapshot.close(); }
    } finally { f.cleanup(); }
  }
});

test("header authorization rejects unknown versions, similar-prefix and additional workspaces", async () => {
  const f = fixture();
  const outside = join(f.dir, "workspace-other"); mkdirSync(outside);
  try {
    for (const extra of [{ version: 2 }, { cwd: outside }, { additionalDirectories: [outside] }]) {
      f.save([], extra);
      const snapshot = await OmpReadSnapshot.open(f.root, f.file, f.workspace);
      try { await assert.rejects(snapshot.header(), HistoryReadError); } finally { await snapshot.close(); }
    }
    writeFileSync(f.file, "{bad header}\n");
    const snapshot = await OmpReadSnapshot.open(f.root, f.file, f.workspace);
    try { await assert.rejects(snapshot.header(), HistoryReadError); } finally { await snapshot.close(); }
  } finally { f.cleanup(); }
});

test("symlink roots, buckets, files and group-writable files fail closed", async () => {
  const f = fixture();
  try {
    f.save([msg("a", null, "safe")]);
    const linkRoot = join(f.dir, "linked-root"); symlinkSync(f.root, linkRoot);
    await assert.rejects(OmpReadSnapshot.open(linkRoot, join(linkRoot, "synthetic-bucket", "2026-10-07_fixture.jsonl"), f.workspace));
    const linkedBucket = join(f.root, "linked-bucket"); symlinkSync(f.bucket, linkedBucket);
    await assert.rejects(OmpReadSnapshot.open(f.root, join(linkedBucket, "2026-10-07_fixture.jsonl"), f.workspace));
    const linkedFile = join(f.bucket, "linked.jsonl"); symlinkSync(f.file, linkedFile);
    await assert.rejects(OmpReadSnapshot.open(f.root, linkedFile, f.workspace));
    chmodSync(f.file, 0o660);
    await assert.rejects(OmpReadSnapshot.open(f.root, f.file, f.workspace));
  } finally { f.cleanup(); }
});

test("directory replacement, atomic replacement and same-size edits invalidate a snapshot", async () => {
  const f = fixture();
  try {
    f.save([msg("a", null, "aaaa")]);
    for (const mutation of [() => { const replacement = f.file + ".new"; copyFileSync(f.file, replacement); renameSync(replacement, f.file); },
      () => writeFileSync(f.file, readFileSync(f.file, "utf8").replace("aaaa", "bbbb")),
      () => { renameSync(f.bucket, f.bucket + "-old"); mkdirSync(f.bucket, { mode: 0o700 }); copyFileSync(join(f.bucket + "-old", "2026-10-07_fixture.jsonl"), f.file); }]) {
      const snapshot = await OmpReadSnapshot.open(f.root, f.file, f.workspace);
      try { await snapshot.header(); mutation(); await assert.rejects(snapshot.verify(), HistoryReadError); }
      finally { await snapshot.close(); }
    }
  } finally { f.cleanup(); }
});

test("damaged lines and incomplete UTF-8 tail are warned and never invented", async () => {
  const f = fixture();
  try {
    f.save([msg("a", null, "中文"), "{damaged line}", msg("b", "a", "完整正文")]);
    writeFileSync(f.file, Buffer.concat([readFileSync(f.file), Buffer.from('{"type":"message","id":"tail","text":"'), Buffer.from([0xe4, 0xb8])]));
    const snapshot = await OmpReadSnapshot.open(f.root, f.file, f.workspace);
    try {
      const tree = await snapshot.tree();
      assert.deepEqual(branchPath(tree).map(node => node.id), ["a", "b"]);
      assert.equal(tree.warnings.length, 2);
    } finally { await snapshot.close(); }
  } finally { f.cleanup(); }
});

test("archive pagination exceeds legacy limits, details stay UTF-8 safe and branch-bound", async () => {
  const f = fixture();
  const index = new OmpHistoryIndex({ workspaceRoot: f.workspace, roots: [f.root] });
  try {
    const entries = Array.from({ length: 125 }, (_, i) => msg(`e${i}`, i ? `e${i - 1}` : null, `${i} ` + "中😀".repeat(600)));
    entries.push({ id: "call", parentId: "e124", type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "NEVER-SEND" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "fixture.txt", apiKey: "NEVER-SEND" } }] } });
    entries.push({ id: "result", parentId: "call", type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "中😀".repeat(20_000) }], isError: false } });
    f.save(entries);
    const alias = await aliasOf(index);
    let page = await index.get(alias, { viewVersion: 2 });
    const all: string[] = [];
    const latest = page;
    do {
      const items = page.items as { id: string }[];
      assert.ok(items.length <= 50);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
      all.unshift(...items.map(item => item.id));
      const pagination = page.page as { before: string | null };
      if (!pagination.before) break;
      page = await index.get(alias, { viewVersion: 2, before: pagination.before, branchId: page.branchId });
    } while (true);
    assert.equal(all.length, 127); assert.equal(new Set(all).size, 127);
    assert.equal(all[0], "e0:block-0");
    const call = (latest.items as Record<string, unknown>[]).find(item => item.kind === "toolCall")!;
    assert.equal(call.status, "succeeded");
    const args = await index.get(alias, { viewVersion: 2, view: "tool", branchId: latest.branchId, revision: latest.revision, detailId: call.detailId, field: "arguments" });
    assert.ok(!JSON.stringify(args).includes("NEVER-SEND"));
    const result = await index.get(alias, { viewVersion: 2, view: "tool", branchId: latest.branchId, revision: latest.revision, detailId: call.detailId });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
    assert.ok(!(result.text as string).includes("�")); assert.ok(result.nextCursor);
    let combined = String(result.text);
    let cursor: unknown = result.nextCursor;
    while (cursor) {
      const next = await index.get(alias, { viewVersion: 2, view: "tool", branchId: latest.branchId, revision: latest.revision, detailId: call.detailId, cursor });
      assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 64 * 1024);
      combined += next.text;
      cursor = next.nextCursor;
    }
    assert.equal(combined, "中😀".repeat(20_000));
    await assert.rejects(index.get(alias, { viewVersion: 2, before: "forged" }), TimelineRequestError);
    f.save([...entries, msg("sibling", "e0", "different branch")]);
    await assert.rejects(index.get(alias, { viewVersion: 2, view: "tool", branchId: latest.branchId, revision: latest.revision, detailId: call.detailId }), TimelineRequestError);
  } finally { index.close(); f.cleanup(); }
});

test("history aliases never reach managed writer routes and legacy lists omit archives", async () => {
  const f = fixture();
  const index = new OmpHistoryIndex({ workspaceRoot: f.workspace, roots: [f.root] });
  let spawns = 0;
  const manager = new PiProcessManager({ piBin: "fixture-must-not-execute", spawnFn: () => { spawns++; throw new Error("no writer allowed"); } });
  const handler = createPiAgentHandler({ manager, workspaceRoot: f.workspace, history: index });
  try {
    f.save([msg("a", null, "合成历史")]);
    const alias = await aliasOf(index);
    assert.deepEqual((await handler(requestFrame("legacy", "session.list"))).data && ((await handler(requestFrame("legacy2", "session.list"))).data as { sessions: unknown[] }).sessions, []);
    const listed = await handler(requestFrame("new", "session.list", { params: { viewVersion: 2, includeArchived: true } }));
    assert.equal((listed.data as { sessions: unknown[] }).sessions.length, 1);
    for (const method of ["session.start", "session.prompt", "session.abort", "ui.response"] as const) {
      const result = await handler(requestFrame(method, method, { sessionId: alias, params: { message: "do not run", requestId: "fake" } }));
      assert.equal(result.ok, false); assert.equal(result.error?.code, "invalid_frame");
    }
    assert.equal(spawns, 0);
    rmSync(f.file);
    const unavailable = await handler(requestFrame("deleted", "session.get", { sessionId: alias, params: { viewVersion: 2 } }));
    assert.equal(unavailable.ok, false); assert.ok(!JSON.stringify(unavailable).includes(f.dir));
  } finally { index.close(); await manager.closeAll(); f.cleanup(); }
});

test("tool projection pairs call IDs, not names/order, and refuses conflicting IDs", () => {
  const calls = { type: "message", id: "a", message: { role: "assistant", content: [
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "one" } },
    { type: "toolCall", id: "c2", name: "read", arguments: { path: "two" } }] } };
  const result = (id: string, callId: string, text: string, isError = false) => ({ type: "message", id, message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }], isError } });
  const projection = projectTranscript([calls, result("r2", "c2", "two failed", true), result("r1", "c1", "one success")]);
  assert.deepEqual(projection.items.slice(0, 2).map(item => item.status), ["succeeded", "failed"]);
  assert.equal(projection.details["a:block-0"]?.result, "one success");
  assert.equal(projection.details["a:block-1"]?.result, "two failed");
  const conflict = projectTranscript([calls, result("r1", "c1", "one"), result("r2", "c1", "another")]);
  assert.equal(conflict.items[0]?.status, "unknown"); assert.equal(conflict.details["a:block-0"]?.result, undefined);
  assert.ok(conflict.warnings.length);
  const service = new TimelineViewService();
  const context = { sessionId: "s", branchId: "b", revision: "r", availability: "archived" as const, canControl: false };
  const page = service.respond(context, projection, {});
  const items = page.items as Record<string, unknown>[];
  assert.ok(items.every(item => item.arguments === undefined && item.result === undefined), "only previews and opaque detail references are transmitted");
});

test("local history roots follow profile/agent precedence without creating absent roots", () => {
  const home = "/synthetic-home";
  assert.deepEqual(defaultOmpHistoryRoots({}, home), ["/synthetic-home/.omp/agent/sessions"]);
  assert.deepEqual(defaultOmpHistoryRoots({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/ignored" }, home), ["/synthetic-home/.omp/profiles/work/agent/sessions"]);
  assert.deepEqual(defaultOmpHistoryRoots({ PI_CODING_AGENT_DIR: "/custom-agent" }, home), ["/custom-agent/sessions"]);
  assert.deepEqual(defaultOmpHistoryRoots({ OMP_HISTORY_ROOTS: '["/custom-sessions"]' }, home), ["/custom-sessions"]);
  assert.throws(() => defaultOmpHistoryRoots({ OMP_HISTORY_ROOTS: '["relative"]' }, home));
});

test("mixed live/archive lists use bounded keyset pages and trustworthy identity deduplication", async () => {
  const f = fixture();
  const index = new OmpHistoryIndex({ workspaceRoot: f.workspace, roots: [f.root] });
  try {
    f.save([msg("a", null, "synthetic")]);
    await index.ready();
    const live = Array.from({ length: 35 }, (_, i) => ({ sessionId: `terminal:live-${i}`, cwd: f.workspace, title: `live ${i}`, runtime: "pi", persistedSessionId: `live-${i}` }));
    const first = await index.list({}, live);
    const firstSessions = first.sessions as Record<string, unknown>[];
    assert.equal(firstSessions.length, 30);
    const second = await index.list({ cursor: first.nextCursor }, live);
    const secondSessions = second.sessions as Record<string, unknown>[];
    assert.equal(secondSessions.length, 6);
    assert.equal(new Set([...firstSessions, ...secondSessions].map(session => session.sessionId)).size, 36);
    const reliable = [{ sessionId: "terminal:fixture", runtime: "omp", persistedSessionId: "fixture", cwd: f.workspace }];
    const deduplicated = await index.list({}, reliable);
    assert.equal((deduplicated.sessions as unknown[]).length, 1);
    const oldExtension = [{ sessionId: "terminal:fixture", cwd: f.workspace }];
    const unmerged = await index.list({}, oldExtension);
    assert.equal((unmerged.sessions as unknown[]).length, 2, "runtime-less old extensions must not be guessed");
    copyFileSync(f.file, join(f.bucket, "conflicting-copy.jsonl"));
    const conflictIndex = new OmpHistoryIndex({ workspaceRoot: f.workspace, roots: [f.root] });
    try {
      await conflictIndex.ready();
      assert.equal(await conflictIndex.hasConflict(reliable[0]!), true);
      const conflicts = await conflictIndex.list({});
      const sessions = conflicts.sessions as Record<string, unknown>[];
      assert.equal(sessions.length, 2);
      assert.ok(sessions.every(session => session.conflict === true && session.canControl === false));
    } finally { conflictIndex.close(); }
  } finally { index.close(); f.cleanup(); }
});

test("detail budget counts serialized escapes, not just raw text bytes", () => {
  const service = new TimelineViewService();
  const context = { sessionId: "s", branchId: "b", revision: "r", availability: "archived" as const, canControl: false };
  const projection = projectTranscript([{ type: "message", id: "result", message: { role: "toolResult", content: [{ type: "text", text: '\\n\"\\\\'.repeat(50_000) }] } }]);
  const timeline = service.respond(context, projection, {});
  const items = timeline.items as Record<string, unknown>[];
  const detail = service.respond(context, projection, { view: "tool", revision: "r", detailId: items[0]!.detailId });
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 64 * 1024);
  assert.ok(detail.nextCursor);
});

test("reader bounds sparse files and records, and cancels between streamed chunks", async () => {
  const f = fixture();
  try {
    f.save([]);
    truncateSync(f.file, 129 * 1024 * 1024);
    await assert.rejects(OmpReadSnapshot.open(f.root, f.file, f.workspace), error => error instanceof HistoryReadError && error.reason === "file_limit");
    f.save([msg("large", null, "x".repeat(8 * 1024 * 1024))]);
    let snapshot = await OmpReadSnapshot.open(f.root, f.file, f.workspace);
    try { await assert.rejects(snapshot.tree(), error => error instanceof HistoryReadError && error.reason === "record_limit"); }
    finally { await snapshot.close(); }
    f.save(Array.from({ length: 2000 }, (_, i) => msg(`e${i}`, i ? `e${i - 1}` : null, "synthetic")));
    const cancel = new AbortController();
    snapshot = await OmpReadSnapshot.open(f.root, f.file, f.workspace, cancel.signal);
    try {
      const iterator = snapshot.lines();
      assert.equal((await iterator.next()).done, false);
      cancel.abort();
      await assert.rejects(async () => { for await (const _ of iterator) {} },
        error => error instanceof HistoryReadError && error.reason === "closed");
    } finally { await snapshot.close(); }
  } finally { f.cleanup(); }
});
