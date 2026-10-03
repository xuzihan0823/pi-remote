import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseTranscriptLine, readBefore, readTail, stripWrapperTags } from "../../src/transcript/reader.ts";

const fixturesDir = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const basicFile = join(fixturesDir, "-home-alice-projA", "11111111-aaaa-4aaa-8aaa-111111111111.jsonl");
const toolsFile = join(fixturesDir, "-home-alice-projA", "22222222-bbbb-4bbb-8bbb-222222222222.jsonl");
const forkFile = join(fixturesDir, "-home-bob-projB", "33333333-cccc-4ccc-8ccc-333333333333.jsonl");
const emptyFile = join(fixturesDir, "-home-bob-projB", "44444444-dddd-4ddd-8ddd-444444444444.jsonl");
const metaOnlyFile = join(fixturesDir, "-home-bob-projB", "55555555-eeee-4eee-8eee-555555555555.jsonl");

test("readTail returns the full main chain of a plain multi-turn session", async () => {
  const page = await readTail(basicFile, 100);
  assert.deepEqual(page.messages.map((m) => m.seq), [2, 3, 4, 5]);
  assert.deepEqual(page.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(page.messages.every((m) => m.kind === "text"), true);
  assert.equal(page.messages[0]?.text, "帮我看看这个项目的结构，重点是入口文件");
  assert.equal(page.messages[0]?.parentUuid, null);
  assert.equal(page.messages[0]?.timestamp, "2026-07-18T08:00:01.000Z");
  assert.equal(page.firstSeq, 2);
  assert.equal(page.hasMore, false);
  assert.equal(page.totalLines, 5);
  assert.equal(page.badLines, 0);
});

test("readTail pagination window and readBefore join up without gaps", async () => {
  const tail = await readTail(basicFile, 2);
  assert.deepEqual(tail.messages.map((m) => m.seq), [4, 5]);
  assert.equal(tail.firstSeq, 4);
  assert.equal(tail.hasMore, true);

  const previous = await readBefore(basicFile, tail.firstSeq ?? 0, 2);
  assert.deepEqual(previous.messages.map((m) => m.seq), [2, 3]);
  assert.equal(previous.hasMore, false);

  const beforeStart = await readBefore(basicFile, 2, 10);
  assert.deepEqual(beforeStart.messages, []);
  assert.equal(beforeStart.firstSeq, null);
  assert.equal(beforeStart.hasMore, false);
});

test("assistant blocks split into thinking/text/tool_use with stable blockIndex", async () => {
  const page = await readTail(toolsFile, 100);
  const line2 = page.messages.filter((m) => m.seq === 2);
  assert.deepEqual(
    line2.map((m) => [m.blockIndex, m.kind]),
    [[0, "thinking"], [1, "text"], [2, "tool_use"], [3, "tool_use"]],
  );
  assert.equal(line2[0]?.text, "用户要看文件列表，用 ls 即可。");
  assert.equal(line2[2]?.toolName, "Bash");
  assert.deepEqual(line2[2]?.toolInput, { command: "ls" });
  assert.equal(line2[2]?.toolUseId, "tu-1");
  assert.equal(line2.every((m) => m.role === "assistant"), true);
});

test("user tool_result blocks keep role user and carry isError", async () => {
  const page = await readTail(toolsFile, 100);
  const line3 = page.messages.filter((m) => m.seq === 3);
  assert.deepEqual(line3.map((m) => [m.blockIndex, m.kind, m.role]), [
    [0, "tool_result", "user"],
    [1, "tool_result", "user"],
  ]);
  assert.equal(line3[0]?.text, "file1.ts\nfile2.ts");
  assert.equal(line3[0]?.isError, false);
  assert.equal(line3[0]?.toolUseId, "tu-1");
  assert.equal(line3[1]?.text, "读取失败：文件不存在");
  assert.equal(line3[1]?.isError, true);
});

test("main chain excludes abandoned fork branch and sidechain lines", async () => {
  const page = await readTail(forkFile, 100);
  assert.deepEqual(page.messages.map((m) => m.seq), [2, 3, 6, 10, 11]);
  const allText = page.messages.map((m) => m.text ?? "").join("|");
  assert.equal(allText.includes("旧分支"), false);
  assert.equal(allText.includes("子代理"), false);
  assert.equal(page.totalLines, 12);
  assert.equal(page.badLines, 1);
});

test("unknown line type with message structure renders as kind meta with rawType", async () => {
  const page = await readTail(forkFile, 100);
  const meta = page.messages.find((m) => m.seq === 10);
  assert.equal(meta?.kind, "meta");
  assert.equal(meta?.rawType, "future-widget");
  assert.equal(meta?.role, "assistant");
  assert.equal(meta?.text, "来自未来版本的未知行");
});

test("paging across a chain that passes through skipped lines stays consistent", async () => {
  const tail = await readTail(forkFile, 3);
  assert.deepEqual(tail.messages.map((m) => m.seq), [6, 10, 11]);
  assert.equal(tail.firstSeq, 6);
  assert.equal(tail.hasMore, true);

  const previous = await readBefore(forkFile, tail.firstSeq ?? 0, 100);
  assert.deepEqual(previous.messages.map((m) => m.seq), [2, 3]);
  assert.equal(previous.hasMore, false);
});

test("empty and metadata-only files yield empty pages without errors", async () => {
  const empty = await readTail(emptyFile, 50);
  assert.deepEqual(empty, { messages: [], firstSeq: null, hasMore: false, totalLines: 0, badLines: 0 });

  const metaOnly = await readTail(metaOnlyFile, 50);
  assert.deepEqual(metaOnly.messages, []);
  assert.equal(metaOnly.firstSeq, null);
  assert.equal(metaOnly.hasMore, false);
  assert.equal(metaOnly.totalLines, 2);
});

test("parseTranscriptLine tolerates hostile input", () => {
  assert.deepEqual(parseTranscriptLine("{not json", 1), []);
  assert.deepEqual(parseTranscriptLine("123", 2), []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "user" }), 3), []);
  // 未知 type 但没有 uuid：无法参与链，跳过
  assert.deepEqual(
    parseTranscriptLine(JSON.stringify({ type: "odd", message: { role: "user", content: "x" } }), 4),
    [],
  );
  // 剥掉包裹标签后为空的 user 行不产出
  const caveat = {
    type: "user",
    uuid: "u-c",
    parentUuid: null,
    message: { role: "user", content: "<local-command-caveat>内部提示</local-command-caveat>" },
  };
  assert.deepEqual(parseTranscriptLine(JSON.stringify(caveat), 5), []);
  // isMeta / sidechain 行不产出
  assert.deepEqual(
    parseTranscriptLine(JSON.stringify({ ...caveat, message: { role: "user", content: "正文" }, isMeta: true }), 6),
    [],
  );
  assert.deepEqual(
    parseTranscriptLine(JSON.stringify({ ...caveat, message: { role: "user", content: "正文" }, isSidechain: true }), 7),
    [],
  );
});

test("stripWrapperTags removes known CLI wrapper tags but keeps user text", () => {
  const mixed = "<command-name>/clear</command-name>\n<command-message>clear</command-message>";
  assert.equal(stripWrapperTags(mixed).trim(), "");
  const withText = "<system-reminder>背景</system-reminder>请帮我修这个 bug";
  assert.equal(stripWrapperTags(withText).trim(), "请帮我修这个 bug");
  assert.equal(stripWrapperTags("普通 <b>加粗</b> 文本").trim(), "普通 <b>加粗</b> 文本");
});
