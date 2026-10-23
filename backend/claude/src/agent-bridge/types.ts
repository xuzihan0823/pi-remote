export type WorkerEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant_delta"; text: string; messageId: string; index?: number }
  /** 流式：一条 API 消息开始（apiMessageId = message.id，与转录里 assistant 行的 message.id 相同）。 */
  | { type: "assistant_stream_start"; apiMessageId: string }
  /** 流式：一个 content block 结束。 */
  | { type: "assistant_block_stop"; index: number }
  | { type: "assistant"; text: string; messageId: string }
  | { type: "tool_use"; toolUseId: string; toolName: string; input: Record<string, unknown>; messageId: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean; messageId?: string }
  | { type: "result"; subtype: string; isError: boolean; result?: string; errors?: string[]; messageId: string };

export type InteractionDecision =
  | { type: "allow_once" }
  | { type: "deny"; message?: string }
  | { type: "answer"; answers: Record<string, string> };
