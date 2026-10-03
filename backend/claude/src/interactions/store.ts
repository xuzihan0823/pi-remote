import { DatabaseSync } from "node:sqlite";

import type {
  AuditRecord,
  Decision,
  InteractionKind,
  InteractionPayload,
  InteractionRecord,
  InteractionStatus,
} from "./types.ts";

interface InteractionRow {
  interaction_id: string;
  session_key: string;
  user_id: string;
  kind: InteractionKind;
  payload: string;
  status: InteractionStatus;
  expires_at: number;
  resolved_at: number | null;
  decision: string | null;
  created_at: number;
}

interface AuditRow {
  audit_id: number;
  interaction_id: string;
  action: string;
  actor_user_id: string | null;
  detail: string | null;
  created_at: number;
}

export interface ResolveStoreInput {
  interactionId: string;
  userId: string;
  status: Exclude<InteractionStatus, "pending">;
  decision: Decision;
  resolvedAt: number;
  auditAction: string;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function mapInteraction(row: InteractionRow): InteractionRecord {
  return {
    interactionId: row.interaction_id,
    sessionKey: row.session_key,
    userId: row.user_id,
    kind: row.kind,
    payload: parseJson<InteractionPayload>(row.payload),
    status: row.status,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    decision: row.decision === null ? null : parseJson<Decision>(row.decision),
    createdAt: row.created_at,
  };
}

function mapAudit(row: AuditRow): AuditRecord {
  return {
    auditId: row.audit_id,
    interactionId: row.interaction_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    detail: row.detail === null ? null : parseJson<Record<string, unknown>>(row.detail),
    createdAt: row.created_at,
  };
}

export class InteractionStore {
  readonly #database: DatabaseSync;

  constructor(path = ":memory:") {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS interactions (
        interaction_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('approval', 'question')),
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'answered', 'expired')),
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        decision TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS interactions_pending_expiry
        ON interactions(status, expires_at);
      CREATE TABLE IF NOT EXISTS interaction_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        interaction_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_user_id TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.#database.close();
  }

  create(record: InteractionRecord): void {
    this.#database.prepare(`
      INSERT INTO interactions (
        interaction_id, session_key, user_id, kind, payload, status,
        expires_at, resolved_at, decision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.interactionId,
      record.sessionKey,
      record.userId,
      record.kind,
      JSON.stringify(record.payload),
      record.status,
      record.expiresAt,
      record.resolvedAt,
      record.decision === null ? null : JSON.stringify(record.decision),
      record.createdAt,
    );
    this.appendAudit(record.interactionId, "created", record.userId, { kind: record.kind });
  }

  get(interactionId: string): InteractionRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM interactions WHERE interaction_id = ?",
    ).get(interactionId) as unknown as InteractionRow | undefined;
    return row === undefined ? undefined : mapInteraction(row);
  }

  listPending(): InteractionRecord[] {
    const rows = this.#database.prepare(
      "SELECT * FROM interactions WHERE status = 'pending' ORDER BY created_at",
    ).all() as unknown as InteractionRow[];
    return rows.map(mapInteraction);
  }

  resolve(input: ResolveStoreInput): InteractionRecord | undefined {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(input.interactionId);
      if (current === undefined || current.status !== "pending" || current.userId !== input.userId) {
        this.#database.exec("ROLLBACK");
        return undefined;
      }

      const result = this.#database.prepare(`
        UPDATE interactions
        SET status = ?, resolved_at = ?, decision = ?
        WHERE interaction_id = ? AND status = 'pending' AND user_id = ?
      `).run(
        input.status,
        input.resolvedAt,
        JSON.stringify(input.decision),
        input.interactionId,
        input.userId,
      );
      if (result.changes !== 1) {
        this.#database.exec("ROLLBACK");
        return undefined;
      }
      this.appendAudit(input.interactionId, input.auditAction, input.userId, {
        decision: input.decision.type,
      });
      this.#database.exec("COMMIT");
      return this.get(input.interactionId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  expirePending(now: number): InteractionRecord[] {
    const candidates = this.#database.prepare(
      "SELECT interaction_id, user_id FROM interactions WHERE status = 'pending' AND expires_at <= ?",
    ).all(now) as unknown as Array<{ interaction_id: string; user_id: string }>;
    const expired: InteractionRecord[] = [];
    for (const candidate of candidates) {
      const decision: Decision = { type: "deny", message: "Interaction timed out" };
      const record = this.resolve({
        interactionId: candidate.interaction_id,
        userId: candidate.user_id,
        status: "expired",
        decision,
        resolvedAt: now,
        auditAction: "auto_deny_timeout",
      });
      if (record !== undefined) expired.push(record);
    }
    return expired;
  }

  denyPendingOnRestart(now: number): InteractionRecord[] {
    const pending = this.listPending();
    const denied: InteractionRecord[] = [];
    for (const record of pending) {
      const decision: Decision = { type: "deny", message: "Interaction denied after process restart" };
      const resolved = this.resolve({
        interactionId: record.interactionId,
        userId: record.userId,
        status: "denied",
        decision,
        resolvedAt: now,
        auditAction: "auto_deny_restart",
      });
      if (resolved !== undefined) denied.push(resolved);
    }
    return denied;
  }

  appendAudit(
    interactionId: string,
    action: string,
    actorUserId: string | null,
    detail: Record<string, unknown> | null,
    createdAt = Date.now(),
  ): void {
    this.#database.prepare(`
      INSERT INTO interaction_audit (interaction_id, action, actor_user_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      interactionId,
      action,
      actorUserId,
      detail === null ? null : JSON.stringify(detail),
      createdAt,
    );
  }

  listAudit(interactionId: string): AuditRecord[] {
    const rows = this.#database.prepare(
      "SELECT * FROM interaction_audit WHERE interaction_id = ? ORDER BY audit_id",
    ).all(interactionId) as unknown as AuditRow[];
    return rows.map(mapAudit);
  }
}
