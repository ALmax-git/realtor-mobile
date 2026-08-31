/**
 * The sync engine's work queue.
 *
 * Deliberately *not* an event log: there is at most one active outbox row
 * per (entity_type, entity_local_id). Repeated local edits before the row
 * has been drained just touch/upsert that single row (`touchOutbox`) rather
 * than piling up one row per keystroke. The row only carries enough
 * metadata to know *what* needs syncing and *how many times it's failed* —
 * the actual request payload is rebuilt from the live DB row at send time
 * (see `sync-engine.ts`), so whatever the agent last saved is always what
 * goes out, even if that happened after this row was queued.
 */
import { getDb } from "./db";

export type OutboxEntityType = "client" | "equity_application";
export type OutboxOperation = "create" | "update" | "delete";
export type OutboxStatus = "pending" | "syncing" | "failed_permanent" | "done";

export interface OutboxRow {
  id: number;
  entity_type: OutboxEntityType;
  entity_local_id: string;
  operation: OutboxOperation;
  status: OutboxStatus;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Ensure there is an active ('pending') outbox row for this entity, creating
 * one if needed or resetting an existing non-syncing row back to pending
 * (e.g. a previously `failed_permanent` row gets another chance once the
 * agent edits the record again).
 */
export async function touchOutbox(
  entityType: OutboxEntityType,
  entityLocalId: string,
): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  const existing = await db.select<any[]>(
    `SELECT id, status FROM sync_outbox WHERE entity_type = ? AND entity_local_id = ?`,
    [entityType, entityLocalId],
  );

  if (existing.length === 0) {
    await db.execute(
      `INSERT INTO sync_outbox (
          entity_type, entity_local_id, operation, status, attempt_count,
          last_error, last_payload, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'create', 'pending', 0, NULL, NULL, NULL, ?, ?)`,
      [entityType, entityLocalId, now, now],
    );
    return;
  }

  if (existing[0].status !== "syncing") {
    await db.execute(
      `UPDATE sync_outbox SET status = 'pending', next_attempt_at = NULL, updated_at = ?
       WHERE id = ?`,
      [now, existing[0].id],
    );
  }
  // If it's mid-flight ('syncing'), leave it — the in-flight request will
  // read the freshest row anyway, and reconciliation re-queues if the data
  // moved on during the round trip (see clients-repo.ts reconcile* fns).
}

/** Drop any outbox row for an entity (e.g. a draft that was deleted before ever syncing). */
export async function removeOutboxFor(
  entityType: OutboxEntityType,
  entityLocalId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM sync_outbox WHERE entity_type = ? AND entity_local_id = ?`,
    [entityType, entityLocalId],
  );
}

/** Rows ready to be attempted right now: pending, and past their backoff window (if any). */
export async function listDueOutboxRows(): Promise<OutboxRow[]> {
  const db = await getDb();
  const now = nowIso();
  return db.select<OutboxRow[]>(
    `SELECT * FROM sync_outbox
     WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at ASC`,
    [now],
  );
}

export async function countActiveOutboxRows(): Promise<{
  pending: number;
  failed: number;
}> {
  const db = await getDb();
  const pendingRows = await db.select<any[]>(
    `SELECT COUNT(*) as n FROM sync_outbox WHERE status IN ('pending', 'syncing')`,
  );
  const failedRows = await db.select<any[]>(
    `SELECT COUNT(*) as n FROM sync_outbox WHERE status = 'failed_permanent'`,
  );
  return {
    pending: Number(pendingRows[0]?.n ?? 0),
    failed: Number(failedRows[0]?.n ?? 0),
  };
}

export async function markOutboxSyncing(id: number, operation: OutboxOperation): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE sync_outbox SET status = 'syncing', operation = ?, updated_at = ? WHERE id = ?`,
    [operation, nowIso(), id],
  );
}

/** Success: the row's job is done, drop it from the queue. */
export async function markOutboxDone(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM sync_outbox WHERE id = ?`, [id]);
}

/**
 * Network/5xx failure: retry later with exponential backoff (capped).
 * Distinct from a validation (4xx) failure, which does NOT get auto-retried
 * (see `markOutboxPermanentFailure`) since resending the same bad payload
 * would just fail again — it needs the agent to fix the data first.
 */
export async function markOutboxRetry(
  id: number,
  attemptCount: number,
  message: string,
): Promise<void> {
  const db = await getDb();
  const backoffSeconds = Math.min(30 * 2 ** attemptCount, 15 * 60); // cap at 15 min
  const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
  await db.execute(
    `UPDATE sync_outbox SET status = 'pending', attempt_count = ?, last_error = ?,
        next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    [attemptCount, message, nextAttemptAt, nowIso(), id],
  );
}

/** Validation/4xx failure: stop auto-retrying until the agent edits the record again. */
export async function markOutboxPermanentFailure(
  id: number,
  message: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE sync_outbox SET status = 'failed_permanent', last_error = ?, updated_at = ?
     WHERE id = ?`,
    [message, nowIso(), id],
  );
}
