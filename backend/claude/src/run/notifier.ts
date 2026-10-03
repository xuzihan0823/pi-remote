// Bark / ntfy 推送（可选旁路）。
//
// BARK_URL / NTFY_URL 二选一（都给时取 Bark）；未配置则 no-op。
// 推送失败仅 console.warn——通知永远不能反噬主流程，返回的 Promise 永不 reject。

import process from "node:process";

export type Notifier = (title: string, body: string) => Promise<void>;

export interface NotifierOptions {
  barkUrl?: string;
  ntfyUrl?: string;
  /** 测试注入；缺省用全局 fetch。 */
  fetchFn?: typeof fetch;
}

function normalizeUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : undefined;
}

export function createNotifier(options: NotifierOptions = {}): Notifier {
  const fetchFn = options.fetchFn ?? fetch;
  const barkUrl = normalizeUrl(options.barkUrl);
  const ntfyUrl = normalizeUrl(options.ntfyUrl);
  const target = barkUrl !== undefined
    ? { kind: "bark" as const, url: barkUrl }
    : ntfyUrl !== undefined
      ? { kind: "ntfy" as const, url: ntfyUrl }
      : undefined;
  if (target === undefined) return async () => undefined;

  return async (title, body) => {
    try {
      const response = target.kind === "bark"
        ? await fetchFn(`${target.url}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`, { method: "POST" })
        : await fetchFn(`${target.url}?title=${encodeURIComponent(title)}`, { method: "POST", body });
      if (!response.ok) console.warn(`notify failed: HTTP ${response.status}`);
    } catch (error) {
      console.warn(`notify failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** 06 卡接线入口：从环境变量读 BARK_URL / NTFY_URL。 */
export function createNotifierFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn?: typeof fetch): Notifier {
  return createNotifier({
    ...(env.BARK_URL ? { barkUrl: env.BARK_URL } : {}),
    ...(env.NTFY_URL ? { ntfyUrl: env.NTFY_URL } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  });
}
