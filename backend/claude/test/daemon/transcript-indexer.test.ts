import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { listSessions } from "../../src/transcript/indexer.ts";

const fixturesDir = fileURLToPath(new URL("./fixtures/projects", import.meta.url));

const basicId = "11111111-aaaa-4aaa-8aaa-111111111111";
const toolsId = "22222222-bbbb-4bbb-8bbb-222222222222";
const forkId = "33333333-cccc-4ccc-8ccc-333333333333";
const emptyId = "44444444-dddd-4ddd-8ddd-444444444444";
const metaOnlyId = "55555555-eeee-4eee-8eee-555555555555";

/** fixture 文件 mtime 随检出环境漂移，测试内显式固定以获得确定排序。 */
async function pinFixtureMtimes(): Promise<void> {
  const at = (id: string, dir: string, iso: string) =>
    utimes(join(fixturesDir, dir, `${id}.jsonl`), new Date(iso), new Date(iso));
  await at(forkId, "-home-bob-projB", "2026-07-18T12:05:00.000Z");
  await at(toolsId, "-home-alice-projA", "2026-07-18T12:04:00.000Z");
  await at(basicId, "-home-alice-projA", "2026-07-18T12:03:00.000Z");
  await at(metaOnlyId, "-home-bob-projB", "2026-07-18T12:02:00.000Z");
  await at(emptyId, "-home-bob-projB", "2026-07-18T12:01:00.000Z");
}

test("listSessions returns all sessions sorted by lastActiveAt desc", async () => {
  await pinFixtureMtimes();
  const sessions = await listSessions(fixturesDir);
  assert.deepEqual(
    sessions.map((s) => s.sessionId),
    [forkId, toolsId, basicId, metaOnlyId, emptyId],
  );
  const fork = sessions[0];
  assert.equal(fork?.lastActiveAt, Date.parse("2026-07-18T12:05:00.000Z"));
  assert.equal(fork?.status, "idle");
  assert.equal(fork?.projectDirName, "-home-bob-projB");
});

test("cwd comes from in-line cwd field, title from first real user text", async () => {
  const sessions = await listSessions(fixturesDir);
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  const basic = byId.get(basicId);
  assert.equal(basic?.cwd, "/home/alice/projA");
  assert.equal(basic?.title, "帮我看看这个项目的结构，重点是入口文件");
  assert.equal(basic?.lastPreview, "src 下有三个模块：core、api、ui。");
  assert.equal(basic !== undefined && basic.sizeBytes > 0, true);

  const tools = byId.get(toolsId);
  assert.equal(tools?.title, "列出当前目录的文件");
  assert.equal(tools?.lastPreview, "目录下有两个 TS 文件。README 读取失败。");

  // fork 文件：title 跳过元数据行取首条真实 user；preview 跳过尾部 isMeta 行
  const fork = byId.get(forkId);
  assert.equal(fork?.cwd, "/home/bob/projB");
  assert.equal(fork?.title, "第一个问题：这个函数是干嘛的？");
  assert.equal(fork?.lastPreview, "重构完成，函数拆成了两个。");
});

test("empty and metadata-only sessions fall back to (空会话) with empty cwd", async () => {
  const sessions = await listSessions(fixturesDir);
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  const empty = byId.get(emptyId);
  assert.equal(empty?.title, "(空会话)");
  assert.equal(empty?.cwd, "");
  assert.equal(empty?.lastPreview, "");
  assert.equal(empty?.sizeBytes, 0);

  const metaOnly = byId.get(metaOnlyId);
  assert.equal(metaOnly?.title, "(空会话)");
  assert.equal(metaOnly?.cwd, "");
  assert.equal(metaOnly?.lastPreview, "");
});

test("missing projects dir returns empty array", async () => {
  const sessions = await listSessions(join(tmpdir(), "claude-remote-definitely-missing"));
  assert.deepEqual(sessions, []);
});

test("long titles truncate at 60 chars with ellipsis; skips tool_result-only and sidechain lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-remote-idx-"));
  try {
    const projectDir = join(dir, "-tmp-proj");
    await mkdir(projectDir);
    const longText = "这句话很长很长".repeat(12); // 84 chars
    const lines = [
      // 纯 tool_result 行：不算真实 user 文本
      JSON.stringify({
        parentUuid: null, isSidechain: false, type: "user", uuid: "t1", cwd: "/tmp/proj",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] },
      }),
      // sidechain user 行：跳过
      JSON.stringify({
        parentUuid: null, isSidechain: true, type: "user", uuid: "t2", cwd: "/tmp/proj",
        message: { role: "user", content: "支线内容" },
      }),
      JSON.stringify({
        parentUuid: "t1", isSidechain: false, type: "user", uuid: "t3", cwd: "/tmp/proj",
        message: { role: "user", content: longText },
      }),
    ].join("\n");
    await writeFile(join(projectDir, "99999999-ffff-4fff-8fff-999999999999.jsonl"), `${lines}\n`);

    const sessions = await listSessions(dir);
    const title = sessions[0]?.title ?? "";
    assert.equal(Array.from(title).length, 61); // 60 字 + 省略号
    assert.equal(title.endsWith("…"), true);
    assert.equal(title.startsWith("这句话很长很长"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
