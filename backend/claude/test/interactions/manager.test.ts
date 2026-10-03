import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InteractionAlreadyResolvedError,
  InteractionManager,
  InteractionUnauthorizedError,
} from "../../src/interactions/manager.ts";
import { decisionToAgentSdkResult } from "../../src/interactions/sdk-contract.ts";
import { InteractionStore } from "../../src/interactions/store.ts";

function setup(options: ConstructorParameters<typeof InteractionManager>[1] = {}) {
  const store = new InteractionStore();
  const manager = new InteractionManager(store, {
    autoScheduleExpiry: false,
    ...options,
  });
  return {
    store,
    manager,
    close(): void {
      manager.close();
      store.close();
    },
  };
}

test("allow_once resolves an approval and wakes all concurrent waiters", async () => {
  const context = setup();
  try {
    const approval = context.manager.createApproval({
      sessionKey: "session-1",
      userId: "user-1",
      payload: { toolName: "Bash", input: { command: "pwd" }, prompt: "Run pwd?" },
    });
    const first = context.manager.awaitDecision(approval.interactionId);
    const second = context.manager.awaitDecision(approval.interactionId);

    const resolution = context.manager.resolve(approval.interactionId, "user-1", { type: "allow_once" });

    assert.equal(resolution.record.status, "allowed");
    assert.deepEqual(await Promise.all([first, second]), [
      { type: "allow_once" },
      { type: "allow_once" },
    ]);
    assert.deepEqual(
      decisionToAgentSdkResult(resolution.decision, { command: "pwd" }),
      { behavior: "allow", updatedInput: { command: "pwd" } },
    );
  } finally {
    context.close();
  }
});

test("first resolution wins and duplicate resolution is rejected", () => {
  const context = setup();
  try {
    const approval = context.manager.createApproval({
      sessionKey: "session",
      userId: "owner",
      payload: { toolName: "Write", input: {}, prompt: "Write?" },
    });

    const first = context.manager.resolve(approval.interactionId, "owner", {
      type: "deny",
      message: "User denied this action",
    });
    assert.equal(first.record.status, "denied");
    assert.throws(
      () => context.manager.resolve(approval.interactionId, "owner", { type: "allow_once" }),
      InteractionAlreadyResolvedError,
    );
  } finally {
    context.close();
  }
});

test("non-owner user cannot resolve an interaction", () => {
  const context = setup();
  try {
    const approval = context.manager.createApproval({
      sessionKey: "session",
      userId: "owner",
      payload: { toolName: "Edit", input: {}, prompt: "Edit?" },
    });

    assert.throws(
      () => context.manager.resolve(approval.interactionId, "attacker", { type: "allow_once" }),
      InteractionUnauthorizedError,
    );
    assert.equal(context.manager.get(approval.interactionId)?.status, "pending");
    assert.equal(context.store.listAudit(approval.interactionId).at(-1)?.action, "unauthorized_resolution");
  } finally {
    context.close();
  }
});

test("expired approvals auto-deny and resolve awaitDecision", async () => {
  let now = 1_000;
  const context = setup({ now: () => now });
  try {
    const approval = context.manager.createApproval({
      sessionKey: "session",
      userId: "owner",
      ttlMs: 50,
      payload: { toolName: "Bash", input: {}, prompt: "Run?" },
    });
    const waiting = context.manager.awaitDecision(approval.interactionId);
    now = 1_051;

    const expired = context.manager.expireDue();

    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.status, "expired");
    assert.deepEqual(await waiting, { type: "deny", message: "Interaction timed out" });
    assert.equal(context.store.listAudit(approval.interactionId).at(-1)?.action, "auto_deny_timeout");
  } finally {
    context.close();
  }
});

test("startup auto-denies pending records and writes restart audit", () => {
  const store = new InteractionStore();
  const first = new InteractionManager(store, { autoScheduleExpiry: false });
  const approval = first.createApproval({
    sessionKey: "session",
    userId: "owner",
    payload: { toolName: "Bash", input: {}, prompt: "Run?" },
  });
  first.close();

  const restarted = new InteractionManager(store, { autoScheduleExpiry: false, now: () => 9_000 });
  try {
    assert.equal(restarted.get(approval.interactionId)?.status, "denied");
    assert.equal(store.listAudit(approval.interactionId).at(-1)?.action, "auto_deny_restart");
  } finally {
    restarted.close();
    store.close();
  }
});

test("question resolution records answers and maps to SDK result", () => {
  const context = setup();
  try {
    const question = context.manager.createQuestion({
      sessionKey: "session",
      userId: "owner",
      payload: {
        questions: [{
          question: "Which database?",
          header: "Database",
          multiSelect: false,
          options: [
            { label: "SQLite", description: "Local database" },
            { label: "Postgres", description: "Server database" },
          ],
        }],
      },
    });
    const resolution = context.manager.resolve(question.interactionId, "owner", {
      type: "answer",
      answers: { "Which database?": "SQLite" },
    });

    assert.equal(resolution.record.status, "answered");
    assert.deepEqual(resolution.decision, {
      type: "answer",
      answers: { "Which database?": "SQLite" },
    });
    assert.deepEqual(
      decisionToAgentSdkResult(resolution.decision, { questions: question.payload.questions }),
      {
        behavior: "allow",
        updatedInput: {
          questions: question.payload.questions,
          answers: { "Which database?": "SQLite" },
        },
      },
    );
  } finally {
    context.close();
  }
});

test("interaction IDs are unique high-entropy URL-safe values", () => {
  const context = setup();
  try {
    const ids = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
      const record = context.manager.createApproval({
        sessionKey: "session",
        userId: "owner",
        payload: { toolName: "Read", input: {}, prompt: "Read?" },
      });
      assert.match(record.interactionId, /^[A-Za-z0-9_-]{24}$/);
      ids.add(record.interactionId);
    }
    assert.equal(ids.size, 1_000);
  } finally {
    context.close();
  }
});
