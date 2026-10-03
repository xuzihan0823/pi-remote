import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivityTracker, type StatusChangeEvent } from "../../src/watch/activity.ts";
import { FakeScheduler } from "./fixtures/watch/fake-scheduler.ts";

function makeTracker(cooldownMs = 1000): {
  tracker: ActivityTracker;
  scheduler: FakeScheduler;
  changes: StatusChangeEvent[];
} {
  const scheduler = new FakeScheduler();
  const tracker = new ActivityTracker({ cooldownMs, scheduler, now: scheduler.now });
  const changes: StatusChangeEvent[] = [];
  tracker.on("change", (event) => changes.push(event));
  return { tracker, scheduler, changes };
}

test("初始状态：未知会话为 idle", () => {
  const { tracker } = makeTracker();
  assert.equal(tracker.getStatus("s1"), "idle");
});

test("外部写入 → terminal-driving，静默期满回落 idle", async () => {
  const { tracker, scheduler, changes } = makeTracker(1000);
  tracker.noteWrite("s1");
  assert.equal(tracker.getStatus("s1"), "terminal-driving");

  await scheduler.advance(999);
  assert.equal(tracker.getStatus("s1"), "terminal-driving");

  await scheduler.advance(1);
  assert.equal(tracker.getStatus("s1"), "idle");
  assert.deepEqual(changes, [
    { sessionId: "s1", status: "terminal-driving" },
    { sessionId: "s1", status: "idle" },
  ]);
  assert.equal(scheduler.pending, 0);
});

test("持续写入不断续期：从最后一次写入起算 cooldown", async () => {
  const { tracker, scheduler, changes } = makeTracker(1000);
  tracker.noteWrite("s1"); // t=0
  await scheduler.advance(600);
  tracker.noteWrite("s1"); // t=600，重挂到 1600
  await scheduler.advance(500); // t=1100，原到期点已过
  assert.equal(tracker.getStatus("s1"), "terminal-driving");
  await scheduler.advance(500); // t=1600
  assert.equal(tracker.getStatus("s1"), "idle");
  assert.equal(changes.filter((c) => c.status === "terminal-driving").length, 1); // 持续驾驶只报一次
});

test("cooldown 计时以写入时间戳为准（未来时间戳按剩余量重挂）", async () => {
  const { tracker, scheduler } = makeTracker(1000);
  tracker.noteWrite("s1", 500); // now=0，但写入记为 t=500
  await scheduler.advance(1000); // 定时器 t=1000 触发，但距 500 只静默了 500ms → 重挂
  assert.equal(tracker.getStatus("s1"), "terminal-driving");
  await scheduler.advance(500); // t=1500 = 500+1000
  assert.equal(tracker.getStatus("s1"), "idle");
  assert.equal(scheduler.pending, 0);
});

test("beginRun → daemon-driving；run 期间写入不算外部信号；endRun → idle", async () => {
  const { tracker, scheduler, changes } = makeTracker(1000);
  tracker.beginRun("s1");
  assert.equal(tracker.getStatus("s1"), "daemon-driving");

  tracker.noteWrite("s1"); // daemon 自己落盘的写入
  await scheduler.advance(5000);
  assert.equal(tracker.getStatus("s1"), "daemon-driving"); // 不迁移、不挂 cooldown

  tracker.endRun("s1");
  assert.equal(tracker.getStatus("s1"), "idle");
  await scheduler.advance(5000);
  assert.deepEqual(changes, [
    { sessionId: "s1", status: "daemon-driving" },
    { sessionId: "s1", status: "idle" },
  ]); // 全程不出现 terminal-driving
  assert.equal(scheduler.pending, 0);
});

test("terminal-driving 中 beginRun：清掉 cooldown 直接接管", async () => {
  const { tracker, scheduler, changes } = makeTracker(1000);
  tracker.noteWrite("s1");
  assert.equal(scheduler.pending, 1);

  tracker.beginRun("s1");
  assert.equal(tracker.getStatus("s1"), "daemon-driving");
  assert.equal(scheduler.pending, 0); // cooldown 被清

  tracker.endRun("s1");
  await scheduler.advance(10_000); // 不会有残留 timer 把状态改回去
  assert.equal(tracker.getStatus("s1"), "idle");
  assert.deepEqual(
    changes.map((c) => c.status),
    ["terminal-driving", "daemon-driving", "idle"],
  );
});

test("endRun 后的写入是外部信号：重新进入 terminal-driving", async () => {
  const { tracker, scheduler } = makeTracker(1000);
  tracker.beginRun("s1");
  tracker.endRun("s1");
  tracker.noteWrite("s1");
  assert.equal(tracker.getStatus("s1"), "terminal-driving");
  await scheduler.advance(1000);
  assert.equal(tracker.getStatus("s1"), "idle");
});

test("多会话互不干扰；未 beginRun 的 endRun 是 no-op", async () => {
  const { tracker, scheduler, changes } = makeTracker(1000);
  tracker.endRun("ghost");
  assert.deepEqual(changes, []);

  tracker.beginRun("s1");
  tracker.noteWrite("s2");
  assert.equal(tracker.getStatus("s1"), "daemon-driving");
  assert.equal(tracker.getStatus("s2"), "terminal-driving");
  await scheduler.advance(1000);
  assert.equal(tracker.getStatus("s1"), "daemon-driving");
  assert.equal(tracker.getStatus("s2"), "idle");
});

test("cooldownMs 可配（默认 120s 语义由契约固定）", async () => {
  const { tracker, scheduler } = makeTracker(50);
  tracker.noteWrite("s1");
  await scheduler.advance(50);
  assert.equal(tracker.getStatus("s1"), "idle");
});

test("dispose 清空全部 timer，进程可退出", () => {
  const { tracker, scheduler } = makeTracker(1000);
  tracker.noteWrite("s1");
  tracker.noteWrite("s2");
  assert.equal(scheduler.pending, 2);
  tracker.dispose();
  assert.equal(scheduler.pending, 0);
  assert.equal(tracker.getStatus("s1"), "idle");
  tracker.dispose(); // 幂等
});
