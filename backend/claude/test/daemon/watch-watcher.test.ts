import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  SessionWatcher,
  type DirWatchFactory,
  type WatcherMessageEvent,
  type WatcherResyncEvent,
  type WatcherWriteEvent,
} from "../../src/watch/watcher.ts";
import { FakeScheduler, settle } from "./fixtures/watch/fake-scheduler.ts";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function userLine(uuid: string, parentUuid: string | null, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    timestamp: "2026-07-18T09:00:00.000Z",
    cwd: "/tmp/demo",
    message: { role: "user", content: text },
  });
}

function assistantLine(uuid: string, parentUuid: string, blocks: unknown[]): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-07-18T09:00:01.000Z",
    message: { role: "assistant", content: blocks },
  });
}

interface Project {
  projectsDir: string;
  file: string;
  sessionId: string;
}

/** 建临时 projectsDir/<编码目录>/<sessionId>.jsonl，每个 line 自动补换行。 */
async function makeProject(lines: string[], sessionId = "sid-0001"): Promise<Project> {
  const projectsDir = await mkdtemp(join(tmpdir(), "watch-test-"));
  tempDirs.push(projectsDir);
  const dir = join(projectsDir, "-tmp-demo");
  await mkdir(dir);
  const file = join(dir, `${sessionId}.jsonl`);
  await writeFile(file, lines.map((line) => `${line}\n`).join(""));
  return { projectsDir, file, sessionId };
}

interface Collected {
  message: WatcherMessageEvent[];
  resync: WatcherResyncEvent[];
  write: WatcherWriteEvent[];
  error: unknown[];
}

function collect(watcher: SessionWatcher): Collected {
  const events: Collected = { message: [], resync: [], write: [], error: [] };
  watcher.on("message", (e) => events.message.push(e));
  watcher.on("resync", (e) => events.resync.push(e));
  watcher.on("write", (e) => events.write.push(e));
  watcher.on("error", (e) => events.error.push(e));
  return events;
}

/** 默认测试配置：禁用 fs.watch、假定时器（不推进则轮询永不自触发），全靠 pollNow 驱动。 */
function makeWatcher(projectsDir: string, scheduler = new FakeScheduler()): SessionWatcher {
  return new SessionWatcher({
    projectsDir,
    scheduler,
    now: scheduler.now,
    dirWatchFactory: null,
  });
}

const baseLines = [userLine("u1", null, "第一问"), assistantLine("a1", "u1", [{ type: "text", text: "第一答" }])];

// ---------------------------------------------------------------------------
// 增量追加
// ---------------------------------------------------------------------------

test("增量追加：新行经 02 解析后逐条推送，seq 为物理行号", async () => {
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const watcher = makeWatcher(projectsDir);
  try {
    const events = collect(watcher);
    await watcher.watch(sessionId);
    await watcher.pollNow();
    assert.equal(events.message.length, 0); // 历史部分不推，由消费方 readTail 拉

    await appendFile(file, `${userLine("u2", "a1", "第二问")}\n`);
    await watcher.pollNow();
    assert.equal(events.message.length, 1);
    const first = events.message[0];
    assert.equal(first?.sessionId, sessionId);
    assert.deepEqual(
      [first?.message.seq, first?.message.role, first?.message.kind, first?.message.text],
      [3, "user", "text", "第二问"],
    );

    // 一行多 block 拆多条：thinking / text / tool_use 同 seq 不同 blockIndex
    await appendFile(
      file,
      `${assistantLine("a2", "u2", [
        { type: "thinking", thinking: "想一下" },
        { type: "text", text: "第二答" },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
      ])}\n`,
    );
    await watcher.pollNow();
    const line4 = events.message.slice(1).map((e) => e.message);
    assert.deepEqual(
      line4.map((m) => [m.seq, m.blockIndex, m.kind]),
      [[4, 0, "thinking"], [4, 1, "text"], [4, 2, "tool_use"]],
    );
    assert.equal(events.resync.length, 0);
    assert.equal(events.error.length, 0);
  } finally {
    watcher.close();
  }
});

test("write 事件：文件字节变化即发出，带注入时钟的时间戳", async () => {
  const scheduler = new FakeScheduler();
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const watcher = makeWatcher(projectsDir, scheduler);
  try {
    const events = collect(watcher);
    await watcher.watch(sessionId);
    await scheduler.advance(1234);
    await appendFile(file, `${userLine("u2", "a1", "again")}\n`);
    await watcher.pollNow();
    assert.equal(events.write.length, 1);
    assert.equal(events.write[0]?.at, 1234);
    // 无变化的轮询不再发 write
    await watcher.pollNow();
    assert.equal(events.write.length, 1);
  } finally {
    watcher.close();
  }
});

// ---------------------------------------------------------------------------
// 半行
// ---------------------------------------------------------------------------

test("半行写入：残行缓存凑齐换行才解析，多字节字符切在半截也不坏", async () => {
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const watcher = makeWatcher(projectsDir);
  try {
    const events = collect(watcher);
    await watcher.watch(sessionId);

    const full = Buffer.from(`${userLine("u2", "a1", "你好世界")}\n`, "utf8");
    // 切点落在中文字符的 UTF-8 字节中间
    const cut = full.indexOf(Buffer.from("好", "utf8")) + 1;
    await appendFile(file, full.subarray(0, cut));
    await watcher.pollNow();
    assert.equal(events.message.length, 0); // 半行不产出
    assert.equal(events.write.length, 1); // 但算一次写入

    await appendFile(file, full.subarray(cut));
    await watcher.pollNow();
    assert.equal(events.message.length, 1);
    assert.deepEqual(
      [events.message[0]?.message.seq, events.message[0]?.message.text],
      [3, "你好世界"],
    );
  } finally {
    watcher.close();
  }
});

test("watch 时文件已带尾部半行：补齐后按正确 seq 产出", async () => {
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const line = `${userLine("u2", "a1", "断行续写")}\n`;
  await appendFile(file, line.slice(0, 20)); // 无换行的半行
  const watcher = makeWatcher(projectsDir);
  try {
    const events = collect(watcher);
    await watcher.watch(sessionId);
    await appendFile(file, line.slice(20));
    await watcher.pollNow();
    assert.equal(events.message.length, 1);
    assert.deepEqual(
      [events.message[0]?.message.seq, events.message[0]?.message.text],
      [3, "断行续写"],
    );
  } finally {
    watcher.close();
  }
});

// ---------------------------------------------------------------------------
// 轮询兜底（禁用 fs.watch 模拟 FSEvents 失效）
// ---------------------------------------------------------------------------

test("轮询兜底：fs.watch 禁用时 500ms 定时器驱动增量", async () => {
  const scheduler = new FakeScheduler();
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const watcher = makeWatcher(projectsDir, scheduler);
  try {
    const events = collect(watcher);
    await watcher.watch(sessionId);
    await appendFile(file, `${userLine("u2", "a1", "轮询到我")}\n`);
    await settle();
    assert.equal(events.message.length, 0); // 定时器没到不触发

    await scheduler.advance(500);
    await settle();
    assert.equal(events.message.length, 1);
    assert.equal(events.message[0]?.message.text, "轮询到我");

    // 轮询循环持续：下一个间隔再追加仍能到
    await appendFile(file, `${userLine("u3", "u2", "再来一条")}\n`);
    await scheduler.advance(500);
    await settle();
    assert.equal(events.message.length, 2);
  } finally {
    watcher.close();
  }
});

test("fs.watch 主路：真实 FSEvents 触发（轮询定时器不推进）", async () => {
  const scheduler = new FakeScheduler();
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const watcher = new SessionWatcher({ projectsDir, scheduler, now: scheduler.now }); // 默认 fs.watch
  try {
    await watcher.watch(sessionId);
    const got = once(watcher, "message", { signal: AbortSignal.timeout(5000) });
    await appendFile(file, `${userLine("u2", "a1", "fsevents")}\n`);
    const [event] = (await got) as [WatcherMessageEvent];
    assert.equal(event.message.text, "fsevents");
    assert.equal(scheduler.pending > 0, true); // 轮询兜底仍挂着，但从未被推进
  } finally {
    watcher.close();
  }
});

// ---------------------------------------------------------------------------
// truncation / chain-mismatch resync
// ---------------------------------------------------------------------------

test("文件变小：重置 offset、重建链尾并 emit resync(truncated)", async () => {
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const watcher = makeWatcher(projectsDir);
  try {
    const events = collect(watcher);
    await watcher.watch(sessionId);

    await writeFile(file, `${userLine("nu1", null, "新文件")}\n`); // 整体替换成更小的文件
    await watcher.pollNow();
    assert.deepEqual(events.resync, [{ sessionId, reason: "truncated" }]);
    assert.equal(events.message.length, 0);

    // 重建后的 seq 与链尾以新文件为准
    await appendFile(file, `${assistantLine("na1", "nu1", [{ type: "text", text: "新答" }])}\n`);
    await watcher.pollNow();
    assert.deepEqual(
      [events.message[0]?.message.seq, events.message[0]?.message.text],
      [2, "新答"],
    );
    assert.equal(events.resync.length, 1);
  } finally {
    watcher.close();
  }
});

test("增量行 parentUuid 不指向已知链尾：emit resync(chain-mismatch)", async () => {
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const watcher = makeWatcher(projectsDir);
  try {
    const events = collect(watcher);
    await watcher.watch(sessionId);

    // 外部 rewind/fork：新行挂在历史节点 u1 而不是链尾 a1
    await appendFile(file, `${userLine("f1", "u1", "从历史分叉")}\n`);
    await watcher.pollNow();
    assert.deepEqual(events.resync, [{ sessionId, reason: "chain-mismatch" }]);
    assert.equal(events.message.length, 0); // 该行不重复推，消费方全量重拉

    // 后续行接上新链尾即恢复正常增量
    await appendFile(file, `${assistantLine("f2", "f1", [{ type: "text", text: "分叉后的答" }])}\n`);
    await watcher.pollNow();
    assert.equal(events.resync.length, 1);
    assert.deepEqual(
      [events.message[0]?.message.seq, events.message[0]?.message.text],
      [4, "分叉后的答"],
    );
  } finally {
    watcher.close();
  }
});

test("sidechain / 带 uuid 的元数据行 / 空行：不产出、不误报 resync、seq 照常计数", async () => {
  const { projectsDir, file, sessionId } = await makeProject(baseLines);
  const watcher = makeWatcher(projectsDir);
  try {
    const events = collect(watcher);
    await watcher.watch(sessionId);

    const sidechain = JSON.stringify({
      type: "assistant",
      uuid: "s1",
      parentUuid: "elsewhere",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "支线" }] },
    });
    // 链穿过 attachment（02 实测）：attachment 有 uuid，parent 指向 a1，下一条真实行挂在它上面
    const attachment = JSON.stringify({ type: "attachment", uuid: "att1", parentUuid: "a1" });
    const noUuidMeta = JSON.stringify({ type: "file-history-snapshot", snapshot: {} });
    await appendFile(file, `${sidechain}\n${attachment}\n${noUuidMeta}\n\n`);
    await watcher.pollNow();
    assert.equal(events.message.length, 0);
    assert.equal(events.resync.length, 0);

    // seq: sidechain=3 attachment=4 meta=5 空行=6，本行=7；parent 接 attachment
    await appendFile(file, `${userLine("u2", "att1", "穿过元数据行")}\n`);
    await watcher.pollNow();
    assert.equal(events.resync.length, 0);
    assert.deepEqual(
      [events.message[0]?.message.seq, events.message[0]?.message.text],
      [7, "穿过元数据行"],
    );
  } finally {
    watcher.close();
  }
});

// ---------------------------------------------------------------------------
// 生命周期与清理
// ---------------------------------------------------------------------------

test("watch 不存在的会话：抛 ENOENT 供 HTTP 层转 404", async () => {
  const { projectsDir } = await makeProject(baseLines);
  const watcher = makeWatcher(projectsDir);
  try {
    await assert.rejects(watcher.watch("no-such-session"), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ENOENT");
      return true;
    });
  } finally {
    watcher.close();
  }
});

test("unwatch/close 释放全部 timer 与目录监听，进程可退出", async () => {
  const scheduler = new FakeScheduler();
  const created: string[] = [];
  const closed: string[] = [];
  const factory: DirWatchFactory = (dir) => {
    created.push(dir);
    return { close: () => closed.push(dir) };
  };
  const { projectsDir, sessionId } = await makeProject(baseLines);
  const second = "sid-0002";
  await writeFile(join(projectsDir, "-tmp-demo", `${second}.jsonl`), `${userLine("x1", null, "另一会话")}\n`);

  const watcher = new SessionWatcher({ projectsDir, scheduler, now: scheduler.now, dirWatchFactory: factory });
  const events = collect(watcher);
  await watcher.watch(sessionId);
  await watcher.watch(second);
  assert.equal(created.length, 1); // 同目录两个会话共享一个目录监听
  assert.deepEqual(watcher.watched.sort(), [sessionId, second].sort());

  watcher.unwatch(sessionId);
  assert.equal(closed.length, 0); // 还有引用，目录监听保留
  assert.equal(scheduler.pending, 1); // 轮询 tick 仍在

  watcher.unwatch(second);
  assert.equal(closed.length, 1);
  assert.equal(scheduler.pending, 0); // 最后一个会话移除后 timer 清空

  // unwatch 后追加不再产生事件
  const file = join(projectsDir, "-tmp-demo", `${sessionId}.jsonl`);
  await appendFile(file, `${userLine("u2", "a1", "没人听")}\n`);
  await watcher.pollNow();
  await scheduler.advance(1000);
  assert.equal(events.message.length, 0);

  watcher.close();
  watcher.close(); // 幂等
  assert.equal(scheduler.pending, 0);
  await assert.rejects(watcher.watch(sessionId)); // close 后拒绝新订阅
});
