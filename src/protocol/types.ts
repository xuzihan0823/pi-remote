export type SessionId = string;

export interface AgentStartEvent {
  type: "agent_start";
  sessionId: SessionId;
}

export interface AgentEndEvent {
  type: "agent_end";
  sessionId: SessionId;
  willRetry: boolean;
}

export interface AgentSettledEvent {
  type: "agent_settled";
  sessionId: SessionId;
}

export interface TurnStartEvent {
  type: "turn_start";
  sessionId: SessionId;
}

export interface TurnEndEvent {
  type: "turn_end";
  sessionId: SessionId;
  toolResultCount: number;
}

export interface MessageStartEvent {
  type: "message_start";
  sessionId: SessionId;
  role: string;
}

export interface MessageEndEvent {
  type: "message_end";
  sessionId: SessionId;
  role: string;
}

export interface TextStartEvent {
  type: "text_start";
  sessionId: SessionId;
  contentIndex: number;
}

export interface TextDeltaEvent {
  type: "text_delta";
  sessionId: SessionId;
  contentIndex: number;
  text: string;
}

export interface TextEndEvent {
  type: "text_end";
  sessionId: SessionId;
  contentIndex: number;
  text: string;
}

export interface ThinkingStartEvent {
  type: "thinking_start";
  sessionId: SessionId;
  contentIndex: number;
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  sessionId: SessionId;
  contentIndex: number;
  text: string;
}

export interface ThinkingEndEvent {
  type: "thinking_end";
  sessionId: SessionId;
  contentIndex: number;
  text: string;
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  sessionId: SessionId;
  contentIndex: number;
  toolCallId: string;
  toolName: string;
}

export interface ToolCallDeltaEvent {
  type: "tool_call_delta";
  sessionId: SessionId;
  contentIndex: number;
  text: string;
}

export interface ToolCallEndEvent {
  type: "tool_call_end";
  sessionId: SessionId;
  contentIndex: number;
  toolCallId: string;
  toolName: string;
}

export interface ToolStartEvent {
  type: "tool_start";
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolUpdateEvent {
  type: "tool_update";
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  text: string;
}

export interface ToolEndEvent {
  type: "tool_end";
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
}

export interface BashOutputEvent {
  type: "bash_output";
  sessionId: SessionId;
  requestId: string | undefined;
  text: string;
}

export interface QueueUpdateEvent {
  type: "queue_update";
  sessionId: SessionId;
  steering: string[];
  followUp: string[];
}

export interface CompactionStartEvent {
  type: "compaction_start";
  sessionId: SessionId;
  reason: string;
}

export interface CompactionEndEvent {
  type: "compaction_end";
  sessionId: SessionId;
  reason: string;
  aborted: boolean;
  willRetry: boolean;
  errorMessage: string | undefined;
}

export interface RetryStartEvent {
  type: "retry_start";
  sessionId: SessionId;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface RetryEndEvent {
  type: "retry_end";
  sessionId: SessionId;
  success: boolean;
  attempt: number;
  errorMessage: string | undefined;
}

export interface ExtensionErrorEvent {
  type: "extension_error";
  sessionId: SessionId;
  extensionPath: string | undefined;
  event: string | undefined;
  error: string;
}

export interface UiRequestEvent {
  type: "ui_request";
  sessionId: SessionId;
  requestId: string;
  method: string;
  expectsResponse: boolean;
  payload: Record<string, unknown>;
}

export interface NoticeEvent {
  type: "notice";
  sessionId: SessionId;
  level: "info" | "warning" | "error";
  text: string;
}

export interface StderrEvent {
  type: "stderr";
  sessionId: SessionId;
  text: string;
}

export interface ProtocolErrorEvent {
  type: "protocol_error";
  sessionId: SessionId;
  message: string;
  line: string | undefined;
}

export interface ProcessExitEvent {
  type: "process_exit";
  sessionId: SessionId;
  code: number | null;
  signal: string | null;
  expected: boolean;
}

export interface ProcessErrorEvent {
  type: "process_error";
  sessionId: SessionId;
  message: string;
}

export interface UnknownEvent {
  type: "unknown_event";
  sessionId: SessionId;
  name: string;
}

export type GatewayEvent =
  | AgentStartEvent
  | AgentEndEvent
  | AgentSettledEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageEndEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | BashOutputEvent
  | QueueUpdateEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | RetryStartEvent
  | RetryEndEvent
  | ExtensionErrorEvent
  | UiRequestEvent
  | NoticeEvent
  | StderrEvent
  | ProtocolErrorEvent
  | ProcessExitEvent
  | ProcessErrorEvent
  | UnknownEvent;

export type GatewayEventType = GatewayEvent["type"];

export interface UiDialogResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface RpcSessionState {
  sessionId: string;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  isStreaming: boolean;
  isCompacting: boolean;
  thinkingLevel: string;
  messageCount: number;
  pendingMessageCount: number;
}
