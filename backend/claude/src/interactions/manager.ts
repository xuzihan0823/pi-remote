import { randomBytes } from "node:crypto";

import { InteractionStore } from "./store.ts";
import type {
  Approval,
  CreateInteractionInput,
  Decision,
  InteractionPayload,
  InteractionRecord,
  Question,
  Resolution,
} from "./types.ts";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export class InteractionNotFoundError extends Error {}
export class InteractionUnauthorizedError extends Error {}
export class InteractionAlreadyResolvedError extends Error {}
export class InteractionTypeError extends Error {}
export class InvalidInteractionAnswerError extends Error {}

interface Waiter {
  resolve: (decision: Decision) => void;
}

export interface InteractionManagerOptions {
  defaultTtlMs?: number;
  now?: () => number;
  autoScheduleExpiry?: boolean;
  cleanPendingOnStart?: boolean;
}

function createInteractionId(): string {
  return randomBytes(18).toString("base64url");
}

function assertPositiveTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive safe integer");
  }
}

function assertQuestion(question: Question): void {
  if (question.questions.length < 1 || question.questions.length > 4) {
    throw new RangeError("AskUserQuestion requires between 1 and 4 questions");
  }
  for (const item of question.questions) {
    if (!item.question.trim() || !item.header.trim()) {
      throw new TypeError("question text and header cannot be empty");
    }
    if (item.options.length < 2 || item.options.length > 4) {
      throw new RangeError("each question requires between 2 and 4 options");
    }
  }
}

function decisionStatus(decision: Decision): "allowed" | "denied" | "answered" {
  switch (decision.type) {
    case "allow_once":
      return "allowed";
    case "deny":
      return "denied";
    case "answer":
      return "answered";
  }
}

export class InteractionManager {
  readonly #waiters = new Map<string, Set<Waiter>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #defaultTtlMs: number;
  readonly #now: () => number;
  readonly #autoScheduleExpiry: boolean;
  readonly store: InteractionStore;

  constructor(store: InteractionStore, options: InteractionManagerOptions = {}) {
    this.store = store;
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    assertPositiveTtl(this.#defaultTtlMs);
    this.#now = options.now ?? Date.now;
    this.#autoScheduleExpiry = options.autoScheduleExpiry ?? true;

    if (options.cleanPendingOnStart ?? true) {
      store.denyPendingOnRestart(this.#now());
    }
  }

  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  createApproval(input: CreateInteractionInput<Approval>): InteractionRecord<Approval> {
    return this.#create("approval", input);
  }

  createQuestion(input: CreateInteractionInput<Question>): InteractionRecord<Question> {
    assertQuestion(input.payload);
    return this.#create("question", input);
  }

  get(interactionId: string): InteractionRecord | undefined {
    return this.store.get(interactionId);
  }

  awaitDecision(interactionId: string, signal?: AbortSignal): Promise<Decision> {
    const record = this.store.get(interactionId);
    if (record === undefined) return Promise.reject(new InteractionNotFoundError("interaction not found"));
    if (record.decision !== null) return Promise.resolve(record.decision);

    return new Promise<Decision>((resolve, reject) => {
      const waiter: Waiter = { resolve };
      const waiters = this.#waiters.get(interactionId) ?? new Set<Waiter>();
      waiters.add(waiter);
      this.#waiters.set(interactionId, waiters);

      const abort = (): void => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.#waiters.delete(interactionId);
        reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  resolve(interactionId: string, userId: string, decision: Decision): Resolution {
    const current = this.#getPendingForUser(interactionId, userId);
    this.#assertDecisionMatches(current, decision);

    const resolvedAt = this.#now();
    const record = this.store.resolve({
      interactionId,
      userId,
      status: decisionStatus(decision),
      decision,
      resolvedAt,
      auditAction: decision.type,
    });
    if (record === undefined) {
      throw new InteractionAlreadyResolvedError("interaction was already resolved");
    }

    this.#finish(interactionId, decision);
    return { record, decision };
  }

  expireDue(now = this.#now()): InteractionRecord[] {
    const expired = this.store.expirePending(now);
    for (const record of expired) {
      if (record.decision !== null) this.#finish(record.interactionId, record.decision);
    }
    return expired;
  }

  #create<T extends InteractionPayload>(
    kind: "approval" | "question",
    input: CreateInteractionInput<T>,
  ): InteractionRecord<T> {
    const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
    assertPositiveTtl(ttlMs);
    const createdAt = this.#now();
    const record: InteractionRecord<T> = {
      interactionId: createInteractionId(),
      sessionKey: input.sessionKey,
      userId: input.userId,
      kind,
      payload: input.payload,
      status: "pending",
      expiresAt: createdAt + ttlMs,
      resolvedAt: null,
      decision: null,
      createdAt,
    };
    this.store.create(record);
    if (this.#autoScheduleExpiry) this.#scheduleExpiry(record);
    return record;
  }

  #scheduleExpiry(record: InteractionRecord): void {
    const delay = Math.max(0, record.expiresAt - this.#now());
    const timer = setTimeout(() => {
      this.#timers.delete(record.interactionId);
      this.expireDue();
    }, delay);
    timer.unref();
    this.#timers.set(record.interactionId, timer);
  }

  #getPendingForUser(interactionId: string, userId: string): InteractionRecord {
    const record = this.store.get(interactionId);
    if (record === undefined) throw new InteractionNotFoundError("interaction not found");
    if (record.userId !== userId) {
      this.store.appendAudit(interactionId, "unauthorized_resolution", userId, null, this.#now());
      throw new InteractionUnauthorizedError("interaction belongs to a different QQ user");
    }
    if (record.status !== "pending") {
      throw new InteractionAlreadyResolvedError("interaction was already resolved");
    }
    return record;
  }

  #assertDecisionMatches(record: InteractionRecord, decision: Decision): void {
    if (record.kind === "approval" && decision.type === "answer") {
      throw new InteractionTypeError("approval cannot be resolved with an answer");
    }
    if (record.kind === "question" && decision.type !== "answer") {
      throw new InteractionTypeError("question must be resolved with answers");
    }
    if (record.kind === "question" && decision.type === "answer") {
      const question = record.payload as Question;
      for (const item of question.questions) {
        const answer = decision.answers[item.question]?.trim();
        if (!answer) throw new InvalidInteractionAnswerError(`missing answer for: ${item.question}`);
      }
    }
  }

  #finish(interactionId: string, decision: Decision): void {
    const timer = this.#timers.get(interactionId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(interactionId);

    const waiters = this.#waiters.get(interactionId);
    this.#waiters.delete(interactionId);
    for (const waiter of waiters ?? []) waiter.resolve(decision);
  }
}
