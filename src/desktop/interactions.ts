import type { DesktopPendingInteraction, DesktopUiResponse } from "../protocol/types.ts";
import { safeText } from "../terminal/extension.ts";

export interface DesktopInteractionClient {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

export const DESKTOP_INTERACTION_LIMITS = {
  requestsPerSnapshot: 100,
  questionsPerAsk: 32,
  optionsPerQuestion: 100,
  requestIdChars: 512,
  identifierChars: 1024,
  fieldBytes: 64 * 1024,
  snapshotBytes: 256 * 1024,
} as const;

export type DesktopInteractionErrorCode = "invalid_frame" | "not_found" | "result_uncertain";

export class DesktopInteractionError extends Error {
  readonly code: DesktopInteractionErrorCode;

  constructor(code: DesktopInteractionErrorCode, message: string) {
    super(message);
    this.name = "DesktopInteractionError";
    this.code = code;
  }
}

const MAX_SERIALIZE_DEPTH = 24;
const MAX_SERIALIZE_NODES = 4096;
const PENDING_OPERATION = "agent/pendingInteractive";
const PERMISSION_OPERATION = "tool/resolvePermission";
const QUESTION_OPERATION = "agent/askTool/resolve";

function hasUnsafeText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127 ||
      code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

function invalid(field: string): never {
  throw new DesktopInteractionError("invalid_frame", `Desktop 交互数据无效（${field}）`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordOf(value: unknown, field: string): Record<string, unknown> {
  return asRecord(value) ?? invalid(field);
}

class FieldBudget {
  #totalBytes = 0;

  add(value: string, field: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > DESKTOP_INTERACTION_LIMITS.fieldBytes) invalid(`${field} 超过单字段上限`);
    this.#totalBytes += bytes;
    if (this.#totalBytes > DESKTOP_INTERACTION_LIMITS.snapshotBytes) invalid("交互快照超过上限");
  }
}

function identity(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars ||
    value.trim().length === 0 || hasUnsafeText(value)) invalid(field);
  return value;
}

function displayString(value: unknown, field: string, budget: FieldBudget, nonEmpty: boolean): string {
  if (typeof value !== "string") invalid(field);
  budget.add(value, field);
  if (nonEmpty && value.trim().length === 0) invalid(field);
  if (hasUnsafeText(value)) invalid(`${field} 含无法安全显示的字符`);
  return value;
}

function optionalDescription(value: unknown, field: string, budget: FieldBudget): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(field);
  budget.add(value, field);
  const display = safeText(value);
  return display.length > 0 ? display : undefined;
}

function escapeUnsafeJsonChars(value: string): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x061c || code === 0x200e || code === 0x200f || code === 0x2028 || code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      escaped += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function serializeArgsPreview(value: unknown, field: string, budget: FieldBudget): string {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): string => {
    nodes++;
    if (nodes > MAX_SERIALIZE_NODES) invalid(`${field} 过于复杂`);
    if (depth > MAX_SERIALIZE_DEPTH) invalid(`${field} 层级过深`);
    if (item === null) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number") return Number.isFinite(item) ? String(item) : "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item !== "object") invalid(`${field} 含无法安全序列化的值`);

    const object = item as object;
    if (ancestors.has(object)) invalid(`${field} 含循环引用`);
    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        return `[${object.map(entry => walk(entry, depth + 1)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) invalid(`${field} 含无法安全序列化的值`);
      const record = object as Record<string, unknown>;
      return `{${Object.keys(record).map(key => `${JSON.stringify(key)}:${walk(record[key], depth + 1)}`).join(",")}}`;
    } finally {
      ancestors.delete(object);
    }
  };
  const text = escapeUnsafeJsonChars(walk(value, 0));
  budget.add(text, field);
  return text;
}

function parsePermission(value: unknown, nativeId: string, publicId: string, budget: FieldBudget): DesktopPendingInteraction {
  const record = recordOf(value, "permission");
  const requestId = identity(record.requestId, "permission.requestId", DESKTOP_INTERACTION_LIMITS.requestIdChars);
  budget.add(requestId, "permission.requestId");
  const sessionId = identity(record.sessionId, "permission.sessionId", DESKTOP_INTERACTION_LIMITS.identifierChars);
  budget.add(sessionId, "permission.sessionId");
  if (sessionId !== nativeId) invalid("permission.sessionId");
  const toolName = displayString(record.toolName, "permission.toolName", budget, true);
  const reason = displayString(record.reason, "permission.reason", budget, false);
  if (!Object.hasOwn(record, "argsPreview")) invalid("permission.argsPreview");
  const argsPreview = serializeArgsPreview(record.argsPreview, "permission.argsPreview", budget);
  const agentName = record.agentName === undefined
    ? undefined
    : displayString(record.agentName, "permission.agentName", budget, true);
  return {
    kind: "permission",
    requestId,
    sessionId: publicId,
    toolName,
    reason,
    argsPreview,
    ...(agentName === undefined ? {} : { agentName }),
  };
}

function parseOption(value: unknown, field: string, budget: FieldBudget): { label: string; description?: string } {
  if (typeof value === "string") {
    return { label: displayString(value, `${field}.label`, budget, true) };
  }
  const record = recordOf(value, field);
  const label = displayString(record.label, `${field}.label`, budget, true);
  const description = optionalDescription(record.description, `${field}.description`, budget);
  return description === undefined ? { label } : { label, description };
}

function parseQuestion(value: unknown, field: string, budget: FieldBudget): {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
} {
  const record = recordOf(value, field);
  const question = displayString(record.question, `${field}.question`, budget, true);
  if (!Array.isArray(record.options) ||
    record.options.length > DESKTOP_INTERACTION_LIMITS.optionsPerQuestion) invalid(`${field}.options`);
  const options = record.options.map((option, index) => parseOption(option, `${field}.options[${index}]`, budget));
  if (record.multiSelect !== undefined && typeof record.multiSelect !== "boolean") invalid(`${field}.multiSelect`);
  return { question, options, multiSelect: record.multiSelect === true };
}

function parseAsk(value: unknown, nativeId: string, publicId: string, budget: FieldBudget): DesktopPendingInteraction {
  const record = recordOf(value, "ask");
  const requestId = identity(record.requestId, "ask.requestId", DESKTOP_INTERACTION_LIMITS.requestIdChars);
  budget.add(requestId, "ask.requestId");
  const sessionId = identity(record.sessionId, "ask.sessionId", DESKTOP_INTERACTION_LIMITS.identifierChars);
  budget.add(sessionId, "ask.sessionId");
  if (sessionId !== nativeId) invalid("ask.sessionId");
  if (!Array.isArray(record.questions) || record.questions.length === 0 ||
    record.questions.length > DESKTOP_INTERACTION_LIMITS.questionsPerAsk) invalid("ask.questions");
  const questions = record.questions.map((question, index) => parseQuestion(question, `ask.questions[${index}]`, budget));
  return { kind: "question", requestId, sessionId: publicId, questions };
}

export async function readDesktopInteractions(
  client: DesktopInteractionClient,
  nativeSessionId: string,
  publicSessionId: string,
): Promise<DesktopPendingInteraction[]> {
  identity(nativeSessionId, "nativeSessionId", DESKTOP_INTERACTION_LIMITS.identifierChars);
  identity(publicSessionId, "publicSessionId", DESKTOP_INTERACTION_LIMITS.identifierChars);

  const raw = await client.call("pi_desktop_invoke", {
    operation: PENDING_OPERATION,
    args: [{ sessionId: nativeSessionId }],
  });
  const envelope = recordOf(raw, "result");
  if (envelope.operation !== PENDING_OPERATION) invalid("operation");
  if (!Object.hasOwn(envelope, "result")) invalid("result");
  const result = recordOf(envelope.result, "result");
  if (!Array.isArray(result.asks) || !Array.isArray(result.permissions)) invalid("result");

  const total = result.asks.length + result.permissions.length;
  if (total > DESKTOP_INTERACTION_LIMITS.requestsPerSnapshot) invalid("请求数量超过上限");

  const budget = new FieldBudget();
  const asks = result.asks.map(value => parseAsk(value, nativeSessionId, publicSessionId, budget));
  const permissions = result.permissions.map(value =>
    parsePermission(value, nativeSessionId, publicSessionId, budget));
  const interactions = [...asks, ...permissions];
  const seen = new Set<string>();
  for (const interaction of interactions) {
    if (seen.has(interaction.requestId)) invalid("requestId 重复");
    seen.add(interaction.requestId);
  }
  return interactions;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) invalid(field);
  }
}

function validateAnswers(
  answers: unknown,
  questions: readonly { multiSelect: boolean }[],
): Array<string[] | null> {
  if (!Array.isArray(answers) || answers.length !== questions.length) invalid("response.answers");
  const budget = new FieldBudget();
  return answers.map((answer, index) => {
    const question = questions[index]!;
    if (answer === null) return null;
    if (!Array.isArray(answer) || answer.length === 0) invalid(`response.answers[${index}]`);
    if (!question.multiSelect && answer.length > 1) invalid(`response.answers[${index}]`);
    const values: string[] = [];
    for (const value of answer) {
      if (typeof value !== "string" || value.trim().length === 0) invalid(`response.answers[${index}]`);
      budget.add(value, `response.answers[${index}]`);
      if (hasUnsafeText(value)) invalid(`response.answers[${index}]`);
      values.push(value);
    }
    return values;
  });
}

async function invokeResolver(
  client: DesktopInteractionClient,
  operation: string,
  args: readonly unknown[],
): Promise<void> {
  let raw: unknown;
  try {
    raw = await client.call("pi_desktop_invoke", { operation, args, confirm: true });
  } catch (error) {
    if (error instanceof DesktopInteractionError) throw error;
    throw new DesktopInteractionError("result_uncertain", "无法确认 Desktop 是否已处理该交互，请刷新后核对");
  }
  const envelope = asRecord(raw);
  if (!envelope || envelope.operation !== operation || !Object.hasOwn(envelope, "result")) {
    throw new DesktopInteractionError("result_uncertain", "无法确认 Desktop 是否已处理该交互，请刷新后核对");
  }
  const result = asRecord(envelope.result);
  if (!result || result.ok !== true) {
    throw new DesktopInteractionError("result_uncertain", "Desktop 未确认交互已处理，请刷新后核对");
  }
}

export async function resolveDesktopInteraction(
  client: DesktopInteractionClient,
  nativeId: string,
  publicId: string,
  requestId: string,
  response: DesktopUiResponse,
): Promise<void> {
  const key = identity(requestId, "requestId", DESKTOP_INTERACTION_LIMITS.requestIdChars);
  const pending = await readDesktopInteractions(client, nativeId, publicId);
  const interaction = pending.find(item => item.requestId === key);
  if (!interaction) throw new DesktopInteractionError("not_found", "Desktop 交互请求已失效，请刷新后重试");

  const record = recordOf(response, "response");
  if (record.kind !== interaction.kind) invalid("response.kind");

  if (interaction.kind === "permission") {
    assertOnlyKeys(record, ["kind", "decision"], "response");
    if (record.decision !== "allow-once" && record.decision !== "deny") invalid("response.decision");
    await invokeResolver(client, PERMISSION_OPERATION, [{ requestId: key, decision: record.decision }]);
    return;
  }

  assertOnlyKeys(record, ["kind", "answers"], "response");
  const answers = validateAnswers(record.answers, interaction.questions);
  await invokeResolver(client, QUESTION_OPERATION, [{ sessionId: nativeId, requestId: key, answers }]);
}
