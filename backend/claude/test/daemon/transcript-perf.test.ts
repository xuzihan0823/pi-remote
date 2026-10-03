import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { readBefore, readTail } from "../../src/transcript/reader.ts";

/** 生成 ≥4MB 的合法会话文件：user/assistant 交替、parentUuid 成链、穿插元数据行。 */
async function generateLargeSession(dir: string): Promise<{ file: string; sizeBytes: number; lineCount: number }> {
  const file = join(dir, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl");
  const filler = "这是一段用来撑大文件体积的正文内容，模拟真实会话里较长的回复。".repeat(8);
  const lines: string[] = [];
  let parent: string | null = null;
  let index = 0;
  let bytes = 0;
  while (bytes < 4 * 1024 * 1024) {
    index += 1;
    if (index % 50 === 0) {
      lines.push(JSON.stringify({ type: "file-history-snapshot", messageId: `snap-${index}`, snapshot: {} }));
    }
    const uuid = `node-${index}`;
    const isUser = index % 2 === 1;
    const line = JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      type: isUser ? "user" : "assistant",
      message: isUser
        ? { role: "user", content: `第 ${index} 个问题：${filler}` }
        : { role: "assistant", content: [{ type: "text", text: `第 ${index} 个回答：${filler}` }] },
      uuid,
      timestamp: "2026-07-18T08:00:00.000Z",
      cwd: "/tmp/perf",
      sessionId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      version: "2.1.209",
    });
    lines.push(line);
    parent = uuid;
    bytes += line.length + 1;
  }
  await writeFile(file, `${lines.join("\n")}\n`);
  const stats = await stat(file);
  return { file, sizeBytes: stats.size, lineCount: lines.length };
}

test("readTail(100) on a ~4MB file is fast and pages correctly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-remote-perf-"));
  try {
    const { file, sizeBytes, lineCount } = await generateLargeSession(dir);
    assert.equal(sizeBytes >= 4 * 1024 * 1024, true);

    const started = performance.now();
    const page = await readTail(file, 100);
    const tailMs = performance.now() - started;

    assert.equal(page.messages.length, 100); // 每个窗口行恰好产出 1 条
    assert.equal(page.hasMore, true);
    assert.equal(page.totalLines, lineCount);
    assert.equal(page.badLines, 0);
    const lastSeq = page.messages.at(-1)?.seq ?? 0;
    assert.equal(lastSeq, lineCount); // 最后一行是主链尾

    const beforeStarted = performance.now();
    const previous = await readBefore(file, page.firstSeq ?? 0, 100);
    const beforeMs = performance.now() - beforeStarted;
    assert.equal(previous.messages.length, 100);
    const previousMax = previous.messages.at(-1)?.seq ?? 0;
    assert.equal(previousMax < (page.firstSeq ?? 0), true);

    // 宽松阈值防 CI 抖动；实测值打印进测试输出供报告引用
    console.log(
      `[perf] file=${(sizeBytes / 1024 / 1024).toFixed(2)}MB lines=${lineCount} ` +
        `readTail(100)=${tailMs.toFixed(1)}ms readBefore(100)=${beforeMs.toFixed(1)}ms`,
    );
    assert.equal(tailMs < 1000, true, `readTail took ${tailMs.toFixed(1)}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
