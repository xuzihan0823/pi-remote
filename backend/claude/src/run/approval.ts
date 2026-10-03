// PermissionBroker → interactions 状态机 → WS 审批卡片的桥。
//
// 两侧的失败纪律不同：SDK 侧（request）fail-closed——任何异常一律折算成 deny；
// HTTP 侧（decide）永不抛裸异常——已解决/不存在/类型不匹配全部转成结构化结果
// （旧项目审查教训：双击按钮不得 500）。
//
// 超时 auto-deny 与重启 auto-deny 由 interactions 包既有逻辑负责；本模块只在
// awaitDecision 返回后按落库状态补发 approval.resolved（含 expired）。

import type { InteractionDecision, PermissionBroker, PermissionRequest } from "../agent-bridge/index.ts";
import {
  InteractionAlreadyResolvedError,
  InteractionManager,
  InteractionNotFoundError,
  InteractionTypeError,
  InteractionUnauthorizedError,
  InvalidInteractionAnswerError,
  questionFromAskUserInput,
  type Approval,
  type Decision,
  type InteractionRecord,
  type Question,
  type QuestionItem,
} from "../interactions/index.ts";

export type ResolvedStatus = "allowed" | "denied" | "answered" | "expired";

/** WS `approval` 帧的 interaction 载荷（见 docs/api-contract.md）。 */
export interface ApprovalCard {
  interactionId: string;
  sessionId: string;
  kind: "approval" | "question";
  toolName: string;
  input: Record<string, unknown>;
  prompt: string;
  expiresAt: number;
  /** kind=question 时为拆分后的单题。 */
  questions?: QuestionItem[];
}

export type ApprovalEvent =
  | { type: "approval"; interaction: ApprovalCard }
  | { type: "approval.resolved"; interactionId: string; status: ResolvedStatus };

/** decide 的结构化结果：06 卡映射 allowed|denied|answered→200、not_found→404、already_resolved→409、invalid→400。 */
export type DecideOutcome =
  | { status: "allowed" | "denied" | "answered" }
  | { status: "already_resolved" }
  | { status: "not_found" }
  | { status: "invalid"; message: string };

export interface ApprovalBridgeOptions {
  manager: InteractionManager;
  /** WS 层订阅审批事件；监听器异常只 warn，不得破坏状态机。 */
  onEvent?: (event: ApprovalEvent) => void;
}

/** AskUserQuestion 多题拆成单题卡串行提问（沿旧项目 dev-worker 手法）。 */
function splitQuestion(question: Question): Question[] {
  return question.questions.map((item) => ({ questions: [item] }));
}

export class ApprovalBridge implements PermissionBroker {
  readonly #manager: InteractionManager;
  readonly #onEvent: ((event: ApprovalEvent) => void) | undefined;
  readonly #resolvedEmitted = new Set<string>();

  constructor(options: ApprovalBridgeOptions) {
    this.#manager = options.manager;
    this.#onEvent = options.onEvent;
  }

  /** SDK 审批入口（经 permission-adapter 调用）。fail-closed：异常一律 deny。 */
  async request(request: PermissionRequest, signal: AbortSignal): Promise<InteractionDecision> {
    try {
      if (request.kind === "approval") {
        const record = this.#manager.createApproval({
          sessionKey: request.sessionKey,
          userId: request.userId,
          payload: { toolName: request.toolName, input: request.input, prompt: request.prompt },
        });
        this.#emitCard(record);
        const decision = await this.#manager.awaitDecision(record.interactionId, signal);
        this.#emitResolved(record.interactionId);
        return decision;
      }

      const answers: Record<string, string> = {};
      for (const payload of splitQuestion(questionFromAskUserInput(request.input))) {
        const record = this.#manager.createQuestion({
          sessionKey: request.sessionKey,
          userId: request.userId,
          payload,
        });
        this.#emitCard(record);
        const decision = await this.#manager.awaitDecision(record.interactionId, signal);
        this.#emitResolved(record.interactionId);
        if (decision.type !== "answer") return { type: "deny", message: "Question was not answered" };
        Object.assign(answers, decision.answers);
      }
      return { type: "answer", answers };
    } catch (error) {
      return {
        type: "deny",
        message: `approval channel failed closed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** HTTP 决策入口（POST /api/interactions/:id/decision）。永不抛异常。 */
  decide(interactionId: string, decision: Decision): DecideOutcome {
    if (
      typeof decision !== "object" || decision === null ||
      (decision.type !== "allow_once" && decision.type !== "deny" && decision.type !== "answer")
    ) {
      return { status: "invalid", message: "unknown decision type" };
    }
    if (decision.type === "answer" && (typeof decision.answers !== "object" || decision.answers === null)) {
      return { status: "invalid", message: "answers must be an object" };
    }
    try {
      const record = this.#manager.get(interactionId);
      if (record === undefined) return { status: "not_found" };
      // 单用户系统：鉴权在 HTTP Bearer 层，这里用记录自身的 userId 决议。
      const resolution = this.#manager.resolve(interactionId, record.userId, decision);
      this.#emitResolved(interactionId);
      return { status: resolution.record.status as "allowed" | "denied" | "answered" };
    } catch (error) {
      if (error instanceof InteractionAlreadyResolvedError) return { status: "already_resolved" };
      if (error instanceof InteractionNotFoundError) return { status: "not_found" };
      if (error instanceof InteractionUnauthorizedError) return { status: "invalid", message: "unauthorized" };
      if (error instanceof InteractionTypeError || error instanceof InvalidInteractionAnswerError) {
        return { status: "invalid", message: error.message };
      }
      return { status: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
  }

  #emitCard(record: InteractionRecord): void {
    const base = {
      interactionId: record.interactionId,
      sessionId: record.sessionKey,
      kind: record.kind,
      expiresAt: record.expiresAt,
    };
    if (record.kind === "approval") {
      const payload = record.payload as Approval;
      this.#emit({
        type: "approval",
        interaction: { ...base, toolName: payload.toolName, input: payload.input, prompt: payload.prompt },
      });
      return;
    }
    const payload = record.payload as Question;
    this.#emit({
      type: "approval",
      interaction: {
        ...base,
        toolName: "AskUserQuestion",
        input: { questions: payload.questions },
        prompt: payload.questions[0]?.question ?? "AskUserQuestion",
        questions: payload.questions,
      },
    });
  }

  /** 按落库终态补发 approval.resolved；decide 与 awaitDecision 续体都会走到，Set 去重。 */
  #emitResolved(interactionId: string): void {
    if (this.#resolvedEmitted.has(interactionId)) return;
    const record = this.#manager.get(interactionId);
    if (record === undefined || record.status === "pending") return;
    this.#resolvedEmitted.add(interactionId);
    this.#emit({ type: "approval.resolved", interactionId, status: record.status });
  }

  #emit(event: ApprovalEvent): void {
    try {
      this.#onEvent?.(event);
    } catch (error) {
      console.warn("approval event listener failed:", error instanceof Error ? error.message : error);
    }
  }
}
