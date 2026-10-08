// Audit and status history. There is deliberately NO actor parameter: PostgreSQL attributes every record to the actor
// verified for the current transaction (see actor.ts). The runtime role has no INSERT privilege on these tables; these
// helpers call the only functions that can write them. The audit trigger scrubs secret-looking keys from metadata.
import type { Queryable } from "./client";

export interface RequestMeta { ip?: string; userAgent?: string }

export async function recordAudit(
  tx: Queryable,
  e: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; request?: RequestMeta }
): Promise<void> {
  await tx.query("SELECT movezz_sec.append_audit($1, $2, $3, $4::jsonb, $5::jsonb, $6::inet, $7)", [
    e.action, e.entityType, e.entityId,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    e.request?.ip ?? null, e.request?.userAgent ?? null,
  ]);
}

export async function recordStatusEvent(
  tx: Queryable,
  e: { entityType: string; entityId: string; from: string | null; to: string; reason?: string; metadata?: unknown }
): Promise<void> {
  await tx.query("SELECT movezz_sec.append_status_event($1, $2, $3, $4, $5, $6::jsonb)", [
    e.entityType, e.entityId, e.from, e.to, e.reason ?? null, e.metadata === undefined ? null : JSON.stringify(e.metadata),
  ]);
}
