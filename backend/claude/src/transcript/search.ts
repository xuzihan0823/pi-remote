// 会话检索：GET /api/sessions/search 的实现。
//
// 两档：
//  - 默认（meta）：只在已有 SessionSummary 上做子串匹配（title / cwd / lastPreview），零额外 IO；
//  - full：逐个流式扫 JSONL 原文。先对原始行做小写子串预筛（绝大多数行直接跳过，不 JSON.parse），
//    命中再用 parseTranscriptLine 解析出可读文本确认并截取片段。每个会话命中第一处即停。
//
// 全文检索按 lastActiveAt 降序扫，凑够 limit 条即停；另设总字节预算，防止上 GB 的历史
// 让一次搜索卡住 daemon（超出预算时 truncated=true，客户端可提示"结果不完整"）。

import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { parseTranscriptLine } from "./reader.ts";
import type { SessionSummary } from "./types.ts";

export type SearchField = "title" | "cwd" | "preview" | "content";

export interface SearchHit {
  session: SessionSummary;
  field: SearchField;
  /** 命中处前后文，单行、已截断。 */
  snippet: string;
  /** field=content 时为命中消息所在行号（可直接用于定位）。 */
  seq?: number;
}

export interface SearchOptions {
  full?: boolean;
  limit?: number;
  /** 全文检索最多读取的原始字节数（默认 256MB）。 */
  byteBudget?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 全文检索因字节预算提前终止。 */
  truncated: boolean;
}

// 命中词前只留少量上下文：客户端列表宽度有限，命中词必须落在可见范围内
const SNIPPET_BEFORE = 12;
const SNIPPET_AFTER = 40;
const DEFAULT_BYTE_BUDGET = 256 * 1024 * 1024;

/** 以命中位置为中心截取单行片段（按 code point 计）。 */
export function makeSnippet(text: string, needleLower: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  const lower = collapsed.toLowerCase();
  // 小写化改变 UTF-16 长度时（极少数字符）索引不可对齐，回退到开头
  const idx = lower.length === collapsed.length ? lower.indexOf(needleLower) : -1;
  const at = idx < 0 ? 0 : Array.from(collapsed.slice(0, idx)).length;
  const needleLen = Array.from(needleLower).length;
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(chars.length, at + needleLen + SNIPPET_AFTER);
  return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`;
}

function metaHit(session: SessionSummary, needle: string): SearchHit | undefined {
  const fields: Array<[SearchField, string]> = [
    ["title", session.title],
    ["cwd", session.cwd],
    ["preview", session.lastPreview],
  ];
  for (const [field, value] of fields) {
    if (value.toLowerCase().includes(needle)) return { session, field, snippet: makeSnippet(value, needle) };
  }
  return undefined;
}

async function contentHit(
  file: string,
  needle: string,
  budget: { remaining: number },
): Promise<{ snippet: string; seq: number } | undefined> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seq = 0;
  try {
    for await (const line of lines) {
      seq += 1;
      budget.remaining -= line.length + 1;
      if (budget.remaining < 0) return undefined;
      // JSON 里中文可能被转义成 \uXXXX；Claude Code 写盘不转义，这里只做原文预筛。
      if (!line.toLowerCase().includes(needle)) continue;
      for (const message of parseTranscriptLine(line, seq)) {
        if (message.kind !== "text" && message.kind !== "tool_result") continue;
        const text = message.text ?? "";
        if (text.toLowerCase().includes(needle)) return { snippet: makeSnippet(text, needle), seq };
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return undefined;
}

/**
 * 在会话摘要列表上检索。sessions 须已按 lastActiveAt 降序（listSessions 的输出）。
 * meta 命中优先于全文命中；同一会话只出现一次。
 */
export async function searchSessions(
  projectsDir: string,
  sessions: readonly SessionSummary[],
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const needle = query.trim().toLowerCase();
  const limit = options.limit ?? 50;
  if (needle === "") return { hits: [], truncated: false };

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const hit = metaHit(session, needle);
    if (hit === undefined) continue;
    hits.push(hit);
    seen.add(session.sessionId);
    if (hits.length >= limit) return { hits, truncated: false };
  }
  if (options.full !== true) return { hits, truncated: false };

  const budget = { remaining: options.byteBudget ?? DEFAULT_BYTE_BUDGET };
  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue;
    if (budget.remaining <= 0) return { hits, truncated: true };
    const file = join(projectsDir, session.projectDirName, `${session.sessionId}.jsonl`);
    let found: { snippet: string; seq: number } | undefined;
    try {
      found = await contentHit(file, needle, budget);
    } catch {
      continue; // 文件消失等瞬态错误
    }
    if (budget.remaining < 0) return { hits, truncated: true };
    if (found === undefined) continue;
    hits.push({ session, field: "content", snippet: found.snippet, seq: found.seq });
    if (hits.length >= limit) break;
  }
  return { hits, truncated: false };
}
