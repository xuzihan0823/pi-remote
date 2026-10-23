import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamBuffer, type StreamFrame } from "../../src/run/stream-buffer.ts";

function manual() {
  const tasks: Array<() => void> = [];
  return {
    scheduler: { set: (fn: () => void) => { tasks.push(fn); return fn; }, clear: (h: unknown) => { const i = tasks.indexOf(h as () => void); if (i >= 0) tasks.splice(i, 1); } },
    tick: () => { for (const fn of tasks.splice(0)) fn(); },
  };
}

test("合帧、offset 递增、done 与 clear", () => {
  const frames: StreamFrame[] = [];
  const m = manual();
  const buf = new StreamBuffer({ emit: (f) => frames.push(f), scheduler: m.scheduler });
  buf.start("s", "msg_1");
  buf.delta("s", 0, "你");
  buf.delta("s", 0, "好");
  assert.equal(frames.length, 0);
  m.tick();
  assert.deepEqual(frames, [{ type: "stream", sessionId: "s", key: "msg_1:0", offset: 0, text: "你好" }]);
  buf.delta("s", 0, "呀");
  buf.stop("s", 0);
  assert.deepEqual(frames[1], { type: "stream", sessionId: "s", key: "msg_1:0", offset: 2, text: "呀", done: true });
  m.tick();
  assert.equal(frames.length, 2);
  buf.end("s");
  assert.deepEqual(frames[2], { type: "stream", sessionId: "s", clear: true });
  assert.deepEqual(buf.snapshot("s"), []);
});

test("snapshot 给新订阅者完整草稿，新消息开始后丢掉已结束的 block", () => {
  const m = manual();
  const buf = new StreamBuffer({ emit: () => {}, scheduler: m.scheduler });
  buf.start("s", "msg_1");
  buf.delta("s", 0, "abc");
  buf.stop("s", 0);
  buf.delta("s", 1, "de");
  assert.deepEqual(buf.snapshot("s").map((f) => ("key" in f ? [f.key, f.offset, f.text, f.done ?? false] : null)), [
    ["msg_1:0", 0, "abc", true],
    ["msg_1:1", 0, "de", false],
  ]);
  buf.stop("s", 1);
  buf.start("s", "msg_2");
  buf.delta("s", 0, "x");
  assert.deepEqual(buf.snapshot("s").map((f) => ("key" in f ? f.key : "")), ["msg_2:0"]);
});
