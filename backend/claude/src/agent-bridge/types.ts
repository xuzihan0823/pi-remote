export type WorkerEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant_delta"; text: string; messageId: string }
  | { type: "assistant"; text: string; messageId: string }
  | { type: "tool_use"; toolUseId: string; toolName: string; input: Record<string, unknown>; messageId: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean; messageId?: string }
  | { type: "result"; subtype: string; isError: boolean; result?: string; errors?: string[]; messageId: string };

export type InteractionDecision =
  | { type: "allow_once" }
  | { type: "deny"; message?: string }
  | { type: "answer"; answers: Record<string, string> };
