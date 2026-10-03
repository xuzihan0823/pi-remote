// JSONL → RenderMessage 读取链。
//
// 读取路径分两层（对应卡面"整文件扫索引 + 窗口内完整 parse"的许可）：
//  1. scanLines：顺序分块流过全文件，逐行只提取 uuid/parentUuid/type/isSidechain/isMeta
//     等定位字段后立即丢弃行内容（驻留内存为每行 ~100B 的索引项，非文件本身）。
//     必须过一遍全文件：seq 是 1 起绝对行号，不数完行无法给尾部行编号。
//  2. 主链行确定后按 offset 逐行 seek 读取，只对窗口内（≤limit 行）做完整解析。
//
// JSONL 无官方 schema 承诺：所有未知形态一律容错（跳过或降级为 kind:meta），不抛错。

import { open } from "node:fs/promises";

import type { ReadPage, RenderMessage, RenderRole } from "./types.ts";

/** 已知的元数据行 type：不渲染、不报 meta 卡。新版本 CLI 的未知 type 走 kind:meta 兜底。 */
const KNOWN_META_TYPES = new Set([
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "file-history-delta",
  "last-prompt",
  "summary",
  "queue-operation",
  "attachment",
  "system",
  "todo",
]);

/** CLI 注入的包裹标签：剥掉后剩余才算真实用户文本。 */
const WRAPPER_TAGS = [
  "local-command-caveat",
  "command-name",
  "command-message",
  "command-args",
  "command-contents",
  "local-command-stdout",
  "local-command-stderr",
  "system-reminder",
  "ide_selection",
  "ide_opened_file",
  "ide_diagnostics",
];

const WRAPPER_PATTERNS = WRAPPER_TAGS.map(
  (tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g"),
);

export function stripWrapperTags(text: string): string {
  let result = text;
  for (const pattern of WRAPPER_PATTERNS) result = result.replace(pattern, "");
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 tool_result 的 content（字符串或 blocks 数组）提取纯文本。 */
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const item = isRecord(part) ? part : undefined;
        if (item?.type === "text" && typeof item.text === "string") return item.text;
        return "";
      })
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// 单行 → RenderMessage[]（03 卡增量 tail 复用的纯函数）
// ---------------------------------------------------------------------------

interface MessageBase {
  seq: number;
  uuid: string;
  parentUuid: string | null;
  timestamp?: string;
}

function baseOf(o: Record<string, unknown>, seq: number): MessageBase | null {
  const uuid = typeof o.uuid === "string" ? o.uuid : null;
  if (uuid === null) return null;
  const parentUuid = typeof o.parentUuid === "string" ? o.parentUuid : null;
  const timestamp = typeof o.timestamp === "string" ? o.timestamp : undefined;
  return { seq, uuid, parentUuid, ...(timestamp === undefined ? {} : { timestamp }) };
}

function userMessages(base: MessageBase, content: unknown): RenderMessage[] {
  if (typeof content === "string") {
    const text = stripWrapperTags(content).trim();
    if (text === "") return [];
    return [{ ...base, blockIndex: 0, role: "user", kind: "text", text }];
  }
  if (!Array.isArray(content)) return [];
  const messages: RenderMessage[] = [];
  content.forEach((part, blockIndex) => {
    if (!isRecord(part)) return;
    if (part.type === "text" && typeof part.text === "string") {
      const text = stripWrapperTags(part.text).trim();
      if (text !== "") messages.push({ ...base, blockIndex, role: "user", kind: "text", text });
      return;
    }
    if (part.type === "tool_result") {
      const toolUseId = typeof part.tool_use_id === "string" ? part.tool_use_id : undefined;
      messages.push({
        ...base,
        blockIndex,
        role: "user",
        kind: "tool_result",
        text: contentText(part.content),
        isError: part.is_error === true,
        ...(toolUseId === undefined ? {} : { toolUseId }),
      });
    }
    // 其余 block（image 等）阶段一跳过
  });
  return messages;
}

function assistantMessages(base: MessageBase, content: unknown): RenderMessage[] {
  if (typeof content === "string") {
    if (content === "") return [];
    return [{ ...base, blockIndex: 0, role: "assistant", kind: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const messages: RenderMessage[] = [];
  content.forEach((part, blockIndex) => {
    if (!isRecord(part)) return;
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text !== "") {
        messages.push({ ...base, blockIndex, role: "assistant", kind: "text", text: part.text });
      }
      return;
    }
    if (part.type === "thinking") {
      const text = typeof part.thinking === "string" ? part.thinking : "";
      messages.push({
        ...base,
        blockIndex,
        role: "assistant",
        kind: "thinking",
        ...(text === "" ? {} : { text }),
      });
      return;
    }
    if (part.type === "tool_use" && typeof part.name === "string") {
      const toolUseId = typeof part.id === "string" ? part.id : undefined;
      messages.push({
        ...base,
        blockIndex,
        role: "assistant",
        kind: "tool_use",
        toolName: part.name,
        toolInput: isRecord(part.input) ? part.input : {},
        ...(toolUseId === undefined ? {} : { toolUseId }),
      });
    }
    // redacted_thinking 及未知 block 跳过
  });
  return messages;
}

/**
 * 解析单条 JSONL 行。返回 0..n 条渲染消息：
 * - 坏 JSON / 非对象行 / sidechain / isMeta / 已知元数据 type / 无 uuid 或无 message 的行 → []
 * - 未知 type 且含 message 结构 → 单条 kind:meta + rawType
 */
export function parseTranscriptLine(line: string, seq: number): RenderMessage[] {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(o)) return [];
  if (o.isSidechain === true) return [];
  if (o.isMeta === true) return [];
  const type = typeof o.type === "string" ? o.type : "";
  const message = isRecord(o.message) ? o.message : undefined;
  if (message === undefined) return [];
  const base = baseOf(o, seq);
  if (base === null) return [];

  if (type === "user") return userMessages(base, message.content);
  if (type === "assistant") return assistantMessages(base, message.content);
  if (KNOWN_META_TYPES.has(type) || type === "") return [];

  // 未知 type 兜底：折叠展示原始类型
  const role: RenderRole = message.role === "user" ? "user" : "assistant";
  const text = contentText(message.content);
  return [
    {
      ...base,
      blockIndex: 0,
      role,
      kind: "meta",
      rawType: type,
      ...(text === "" ? {} : { text }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 轻量行索引 + 主链
// ---------------------------------------------------------------------------

interface LineEntry {
  seq: number;
  offset: number;
  length: number;
  uuid: string | null;
  parentUuid: string | null;
  type: string | null;
  sidechain: boolean;
  meta: boolean;
  hasMessage: boolean;
  bad: boolean;
}

function indexLine(text: string, seq: number, offset: number, length: number): LineEntry {
  const entry: LineEntry = {
    seq,
    offset,
    length,
    uuid: null,
    parentUuid: null,
    type: null,
    sidechain: false,
    meta: false,
    hasMessage: false,
    bad: false,
  };
  const trimmed = text.trim();
  if (trimmed === "") return entry; // 空行：占行号，不算坏行
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    entry.bad = true;
    return entry;
  }
  if (!isRecord(o)) {
    entry.bad = true;
    return entry;
  }
  if (typeof o.uuid === "string") entry.uuid = o.uuid;
  if (typeof o.parentUuid === "string") entry.parentUuid = o.parentUuid;
  if (typeof o.type === "string") entry.type = o.type;
  entry.sidechain = o.isSidechain === true;
  entry.meta = o.isMeta === true;
  entry.hasMessage = isRecord(o.message);
  return entry;
}

interface ScanResult {
  entries: LineEntry[];
  badLines: number;
}

/** 顺序分块流过全文件，产出每行的定位索引。行内容解析后立即丢弃。 */
async function scanLines(file: string): Promise<ScanResult> {
  const entries: LineEntry[] = [];
  const handle = await open(file, "r");
  try {
    const chunkSize = 256 * 1024;
    const chunk = Buffer.alloc(chunkSize);
    let filePos = 0;
    let lineStart = 0;
    let pending: Buffer[] = [];
    let seq = 0;

    const finishLine = (lineBuffer: Buffer, offset: number): void => {
      seq += 1;
      entries.push(indexLine(lineBuffer.toString("utf8"), seq, offset, lineBuffer.length));
    };

    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, filePos);
      if (bytesRead === 0) break;
      let pieceStart = 0;
      for (let i = 0; i < bytesRead; i += 1) {
        if (chunk[i] !== 0x0a) continue;
        const piece = chunk.subarray(pieceStart, i);
        const lineBuffer =
          pending.length > 0 ? Buffer.concat([...pending, piece]) : Buffer.from(piece);
        pending = [];
        finishLine(lineBuffer, lineStart);
        lineStart = filePos + i + 1;
        pieceStart = i + 1;
      }
      // chunk 会被复用，跨块残段必须复制
      if (pieceStart < bytesRead) pending.push(Buffer.from(chunk.subarray(pieceStart, bytesRead)));
      filePos += bytesRead;
    }
    if (pending.length > 0) finishLine(Buffer.concat(pending), lineStart);
  } finally {
    await handle.close();
  }
  return { entries, badLines: entries.filter((entry) => entry.bad).length };
}

/**
 * 主链：文件最后一条非 sidechain 的 user/assistant 行，沿 parentUuid 回溯。
 * uuid 索引收所有带 uuid 的行——实测链会穿过 attachment/system/isMeta 行，
 * 这些行在链上但渲染时产出 0 条。
 */
function computeMainChain(entries: LineEntry[]): Set<number> {
  const byUuid = new Map<string, LineEntry>();
  for (const entry of entries) {
    if (entry.uuid !== null) byUuid.set(entry.uuid, entry);
  }
  let tail: LineEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.bad || entry.sidechain) continue;
    if (entry.type === "user" || entry.type === "assistant") {
      tail = entry;
      break;
    }
  }
  const chain = new Set<number>();
  const visited = new Set<string>(); // 防御坏数据成环
  let current = tail;
  while (current !== undefined) {
    chain.add(current.seq);
    const parent = current.parentUuid;
    if (parent === null || visited.has(parent)) break;
    visited.add(parent);
    current = byUuid.get(parent);
  }
  return chain;
}

/** 主链上会参与渲染窗口计数的行（user/assistant 或未知含 message 的行）。 */
function isRenderableChainLine(entry: LineEntry, chain: Set<number>): boolean {
  if (entry.bad || entry.sidechain || entry.meta) return false;
  if (!chain.has(entry.seq)) return false;
  if (entry.type === "user" || entry.type === "assistant") return true;
  return entry.type !== null && !KNOWN_META_TYPES.has(entry.type) && entry.hasMessage;
}

async function readPage(file: string, beforeSeq: number | null, limit: number): Promise<ReadPage> {
  const { entries, badLines } = await scanLines(file);
  const chain = computeMainChain(entries);
  const candidates = entries.filter((entry) => isRenderableChainLine(entry, chain));
  const eligible =
    beforeSeq === null ? candidates : candidates.filter((entry) => entry.seq < beforeSeq);
  const window = limit > 0 ? eligible.slice(-limit) : [];
  const hasMore = eligible.length > window.length;

  const messages: RenderMessage[] = [];
  if (window.length > 0) {
    const handle = await open(file, "r");
    try {
      for (const entry of window) {
        const buffer = Buffer.alloc(entry.length);
        await handle.read(buffer, 0, entry.length, entry.offset);
        messages.push(...parseTranscriptLine(buffer.toString("utf8"), entry.seq));
      }
    } finally {
      await handle.close();
    }
  }
  const first = window[0];
  return {
    messages,
    firstSeq: first === undefined ? null : first.seq,
    hasMore,
    totalLines: entries.length,
    badLines,
  };
}

/** 从尾部取最新 limit 个主链行的消息。文件不存在时抛原生 ENOENT，由调用方转 404。 */
export function readTail(file: string, limit: number): Promise<ReadPage> {
  return readPage(file, null, limit);
}

/** 取 seq < beforeSeq 的最后 limit 个主链行的消息（向上翻页）。 */
export function readBefore(file: string, beforeSeq: number, limit: number): Promise<ReadPage> {
  return readPage(file, beforeSeq, limit);
}
