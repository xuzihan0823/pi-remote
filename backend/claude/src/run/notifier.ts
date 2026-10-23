// Bark / ntfy 推送（可选旁路）。
//
// BARK_URL / NTFY_URL 二选一（都给时取 Bark）；未配置则 no-op。
// 推送失败仅 console.warn——通知永远不能反噬主流程，返回的 Promise 永不 reject。

import process from "node:process";

/** 推送附加信息：点击跳转、分组、打断级别。不支持的字段各服务自行忽略。 */
export interface NotifyOptions {
  /** 点击通知打开的链接（App 深链 claude-remote://…）。Bark: url 参数；ntfy: Click 头。 */
  url?: string;
  /** 通知分组（Bark group；ntfy 无对应，忽略）。 */
  group?: string;
  /** 待审批这类需要尽快处理的：Bark level=timeSensitive（可穿透专注模式）；ntfy Priority: high。 */
  urgent?: boolean;
}

export type Notifier = (title: string, body: string, options?: NotifyOptions) => Promise<void>;

/** App 深链：点推送直达某条审批 / 某个会话。 */
export function approvalLink(interactionId: string, sessionId: string): string {
  return `claude-remote://approval/${encodeURIComponent(interactionId)}?session=${encodeURIComponent(sessionId)}`;
}

export function sessionLink(sessionId: string): string {
  return `claude-remote://session/${encodeURIComponent(sessionId)}`;
}

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

  return async (title, body, options = {}) => {
    try {
      let response: Response;
      if (target.kind === "bark") {
        const query = new URLSearchParams();
        if (options.url) query.set("url", options.url);
        if (options.group) query.set("group", options.group);
        if (options.urgent) query.set("level", "timeSensitive");
        const qs = query.toString();
        response = await fetchFn(
          `${target.url}/${encodeURIComponent(title)}/${encodeURIComponent(body)}${qs ? `?${qs}` : ""}`,
          { method: "POST" },
        );
      } else {
        const headers: Record<string, string> = {};
        if (options.url) headers.Click = options.url;
        if (options.urgent) headers.Priority = "high";
        response = await fetchFn(`${target.url}?title=${encodeURIComponent(title)}`, {
          method: "POST",
          body,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
      }
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
