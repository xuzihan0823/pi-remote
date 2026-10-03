// 会话转录数据结构 —— 字段与 docs/api-contract.md 一致。
// 本文件是 03 卡（watcher / HTTP 层）的依赖，交付后不可破坏性变更。

export type SessionStatus = "idle" | "terminal-driving" | "daemon-driving";

/** GET /api/sessions 列表条目。 */
export interface SessionSummary {
  /** JSONL 文件名去掉 .jsonl。 */
  sessionId: string;
  /** 从 JSONL 行内 cwd 字段读取；整个文件都没有 cwd 字段时为 ""。 */
  cwd: string;
  /** 编码目录名（仅展示分组用，不用于反解路径）。 */
  projectDirName: string;
  /** 首条真实 user 文本截 60 字；无则 "(空会话)"。 */
  title: string;
  /** 最后一条主链消息文本截 80 字；无则 ""。 */
  lastPreview: string;
  /** 文件 mtime（epoch ms）。 */
  lastActiveAt: number;
  sizeBytes: number;
  /** 本卡（02）固定填 "idle"，真实状态由 03 卡的 ActivityDetector 覆盖。 */
  status: SessionStatus;
}

export type RenderRole = "user" | "assistant";
export type RenderKind = "text" | "tool_use" | "tool_result" | "thinking" | "meta";

/** JSONL 行映射出的渲染用统一结构。一行可拆出多条（blocks），seq 相同、blockIndex 不同。 */
export interface RenderMessage {
  /** 物理行号（1 起），分页与去重的唯一键。 */
  seq: number;
  /** 行内 message.content 数组的原始下标；content 为字符串时为 0。 */
  blockIndex: number;
  uuid: string;
  parentUuid: string | null;
  role: RenderRole;
  kind: RenderKind;
  /** text / thinking / tool_result / meta 的文本。 */
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  /** 仅 tool_result。 */
  isError?: boolean;
  /** 行内 timestamp（ISO 字符串）。 */
  timestamp?: string;
  /** kind=meta 时保留原始行 type 供折叠展示。 */
  rawType?: string;
}

/** readTail / readBefore 的返回。messages 按 seq 升序，只含主链。 */
export interface ReadPage {
  messages: RenderMessage[];
  /**
   * 本页窗口首个主链行的 seq；空页为 null。
   * 向上翻页时把它作为下一次 readBefore 的 beforeSeq。
   * 注意可能小于 messages[0].seq（窗口首行可剥空产出 0 条）。
   */
  firstSeq: number | null;
  /** firstSeq 之前是否还有主链行。 */
  hasMore: boolean;
  /** 文件物理总行数（含空行/坏行/元数据行）。 */
  totalLines: number;
  /** JSON 解析失败被跳过的行数。 */
  badLines: number;
}

/** 单行解析器接口：给定原始 JSONL 行与其行号，产出 0..n 条渲染消息（03 卡增量 tail 复用）。 */
export type TranscriptLineParser = (line: string, seq: number) => RenderMessage[];
