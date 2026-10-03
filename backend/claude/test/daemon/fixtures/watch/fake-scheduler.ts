// 测试用假时钟 + 假定时器：满足 watcher/activity 的 Scheduler 注入接口。
// advance() 按到期顺序同步触发回调；now() 随 advance 前进。不 sleep 实测时间。

import type { Scheduler } from "../../../../src/watch/watcher.ts";

interface FakeTask {
  fn: () => void;
  at: number;
}

export class FakeScheduler implements Scheduler {
  #now = 0;
  #nextId = 1;
  readonly #tasks = new Map<number, FakeTask>();

  readonly now = (): number => this.#now;

  set(fn: () => void, ms: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, { fn, at: this.#now + ms });
    return id;
  }

  clear(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }

  /** 未触发的挂起任务数（清理断言用）。 */
  get pending(): number {
    return this.#tasks.size;
  }

  /**
   * 时钟前进 ms。每触发一个到期回调后让出若干轮事件循环，
   * 使回调内的异步链（stat/read 等 fs promise）有机会完成并挂上新任务。
   */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueTask: FakeTask | undefined;
      for (const [id, task] of this.#tasks) {
        if (task.at > target) continue;
        if (dueTask === undefined || task.at < dueTask.at) {
          dueId = id;
          dueTask = task;
        }
      }
      if (dueId === undefined || dueTask === undefined) break;
      this.#now = Math.max(this.#now, dueTask.at);
      this.#tasks.delete(dueId);
      dueTask.fn();
      await settle();
    }
    this.#now = target;
  }
}

/** 让出足够多轮事件循环，使已触发的异步链（含 fs 线程池回调）尽量走完。 */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
