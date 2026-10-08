import { createHash } from "node:crypto";
import type { Queryable } from "./client";
import { DomainError } from "./errors";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type IdempotencyStart =
  | { state: "new"; id: string }
  | { state: "replay"; id: string; resultEntityType: string | null; resultEntityId: string | null; response: unknown };

/**
 * Claims (scope, actor, key) inside the caller's transaction.
 *  - first caller: row inserted -> "new"; the caller does the work and calls completeIdempotent() in the SAME transaction
 *  - same key again: "replay" with the stored result (a concurrent duplicate waits on the unique index until the first
 *    transaction commits, then replays - it can never run the operation twice)
 *  - same key, different request body: IDEMPOTENCY_CONFLICT
 */
export async function beginIdempotent(
  db: Queryable,
  p: { scope: string; actorUserId: string | null; key: string; requestHash: string }
): Promise<IdempotencyStart> {
  const ins = await db.query<{ id: string }>(
    `INSERT INTO idempotency_keys (scope, actor_user_id, key, request_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope, (coalesce(actor_user_id, '00000000-0000-0000-0000-000000000000'::uuid)), key) DO NOTHING
     RETURNING id`,
    [p.scope, p.actorUserId, p.key, p.requestHash]
  );
  if (ins.rows[0]) return { state: "new", id: ins.rows[0].id };
  const { rows } = await db.query(
    `SELECT id, request_hash, status, result_entity_type, result_entity_id, response FROM idempotency_keys
      WHERE scope = $1 AND coalesce(actor_user_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid) AND key = $3`,
    [p.scope, p.actorUserId, p.key]
  );
  const row = rows[0];
  if (row.request_hash !== p.requestHash) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used with a different request");
  }
  if (row.status !== "completed") {
    throw new DomainError("INVALID_STATE", "The original request with this idempotency key did not complete; use a new key");
  }
  return { state: "replay", id: row.id, resultEntityType: row.result_entity_type, resultEntityId: row.result_entity_id, response: row.response };
}

export async function completeIdempotent(
  db: Queryable,
  id: string,
  result: { entityType: string; entityId: string; response?: unknown }
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys SET status = 'completed', completed_at = now(), result_entity_type = $2, result_entity_id = $3, response = $4 WHERE id = $1`,
    [id, result.entityType, result.entityId, result.response === undefined ? null : JSON.stringify(result.response)]
  );
}
