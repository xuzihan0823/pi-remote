import type { Approval, Decision, Question } from "./types.ts";

export type AgentSdkPermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export function approvalFromToolRequest(
  toolName: string,
  input: Record<string, unknown>,
): Approval {
  return {
    toolName,
    input,
    prompt: `Claude 请求使用工具 ${toolName}\n\n${JSON.stringify(input, null, 2)}`,
  };
}

export function questionFromAskUserInput(input: Record<string, unknown>): Question {
  const questions = input.questions;
  if (!Array.isArray(questions)) throw new TypeError("AskUserQuestion input.questions must be an array");
  return { questions: questions as Question["questions"] };
}

export function decisionToAgentSdkResult(
  decision: Decision,
  originalInput: Record<string, unknown>,
): AgentSdkPermissionResult {
  switch (decision.type) {
    case "allow_once":
      return { behavior: "allow", updatedInput: originalInput };
    case "deny":
      return { behavior: "deny", message: decision.message ?? "User denied this action" };
    case "answer":
      return {
        behavior: "allow",
        updatedInput: { ...originalInput, answers: decision.answers },
      };
  }
}
