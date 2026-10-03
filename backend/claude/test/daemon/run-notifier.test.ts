// Notifier 三态：未配置 no-op / 配置后 POST / 失败仅 warn 不抛。fetch 全部 mock。

import assert from "node:assert/strict";
import { test } from "node:test";

import { createNotifier, createNotifierFromEnv } from "../../src/run/notifier.ts";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(response: () => Response | Promise<Response>): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn = (async (url: unknown, init?: unknown): Promise<Response> => {
    calls.push({ url: String(url), init: init as RequestInit | undefined });
    return response();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test("未配置任何 URL：no-op，不发请求", async () => {
  const { fetchFn, calls } = mockFetch(() => new Response("", { status: 200 }));
  const notify = createNotifier({ fetchFn });
  await notify("标题", "内容");
  assert.deepEqual(calls, []);
});

test("BARK_URL：POST 到 {url}/{title}/{body}，路径分段编码", async () => {
  const { fetchFn, calls } = mockFetch(() => new Response("", { status: 200 }));
  const notify = createNotifier({ barkUrl: "https://api.day.app/key/", fetchFn });
  await notify("待审批", "Bash: ls -la");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    `https://api.day.app/key/${encodeURIComponent("待审批")}/${encodeURIComponent("Bash: ls -la")}`,
  );
  assert.equal(calls[0]!.init?.method, "POST");
});

test("NTFY_URL：POST body 为内容，title 走查询参数", async () => {
  const { fetchFn, calls } = mockFetch(() => new Response("", { status: 200 }));
  const notify = createNotifier({ ntfyUrl: "https://ntfy.sh/my-topic", fetchFn });
  await notify("任务完成", "轮次已结束");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://ntfy.sh/my-topic?title=${encodeURIComponent("任务完成")}`);
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(calls[0]!.init?.body, "轮次已结束");
});

test("两个都配时取 Bark（二选一）", async () => {
  const { fetchFn, calls } = mockFetch(() => new Response("", { status: 200 }));
  const notify = createNotifier({ barkUrl: "https://api.day.app/key", ntfyUrl: "https://ntfy.sh/t", fetchFn });
  await notify("t", "b");
  assert.match(calls[0]!.url, /^https:\/\/api\.day\.app\//);
});

test("fetch reject：仅 console.warn，一次都不抛", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const fetchFn = (async (): Promise<Response> => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const notify = createNotifier({ ntfyUrl: "https://ntfy.sh/t", fetchFn });
  await notify("t", "b");
  assert.equal(warn.mock.callCount(), 1);
});

test("非 2xx 响应：仅 console.warn", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const { fetchFn } = mockFetch(() => new Response("", { status: 500 }));
  const notify = createNotifier({ barkUrl: "https://api.day.app/key", fetchFn });
  await notify("t", "b");
  assert.equal(warn.mock.callCount(), 1);
});

test("createNotifierFromEnv：读 BARK_URL / NTFY_URL，缺省 no-op", async () => {
  const { fetchFn, calls } = mockFetch(() => new Response("", { status: 200 }));
  const notify = createNotifierFromEnv({ BARK_URL: "https://api.day.app/key" }, fetchFn);
  await notify("t", "b");
  assert.equal(calls.length, 1);

  const noop = createNotifierFromEnv({}, fetchFn);
  await noop("t", "b");
  assert.equal(calls.length, 1, "空 env 不得发请求");
});
