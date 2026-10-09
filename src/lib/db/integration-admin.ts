// Manual administration of the integration state machines (docs/DECISIONS.md A4): super_admin only. Each call authorises the
// verified actor, then calls a database function that checks the role again, records a reason and writes the audit trail.
import type { Pool } from "pg";
import { withActorTransaction, type ActorAssertion } from "./actor";
import { authorize } from "./authz";
import { DomainError } from "./errors";

/** Resolves a Keepup row whose outcome was unknown. `created` needs the sale id verified in Keepup; `not_created` re-queues it. */
export async function resolveKeepupSync(db: Pool, i: { syncId: string; outcome: "created" | "not_created" | "cancelled"; saleId?: string; reason: string; actor: ActorAssertion }): Promise<void> {
  if (!/\S/.test(i.reason ?? "")) throw new DomainError("INVALID_INPUT", "A resolution reason is required");
  await withActorTransaction(db, i.actor, async (tx) => {
    await authorize(tx, "keepup.sync.manual");
    await tx.query("SELECT movezz_sec.keepup_resolve($1, $2, $3, $4)", [i.syncId, i.outcome, i.saleId ?? null, i.reason]);
  });
}

/** Re-queues a sync that FAILED definitively (never one with an unknown outcome). */
export async function retryKeepupSync(db: Pool, i: { syncId: string; reason: string; actor: ActorAssertion }): Promise<void> {
  if (!/\S/.test(i.reason ?? "")) throw new DomainError("INVALID_INPUT", "A retry reason is required");
  await withActorTransaction(db, i.actor, async (tx) => {
    await authorize(tx, "keepup.sync.manual");
    await tx.query("SELECT movezz_sec.keepup_manual_retry($1, $2)", [i.syncId, i.reason]);
  });
}

/** Resolves a Keepup payment/cancel operation whose outcome was unknown, after a person checked Keepup. */
export async function resolveKeepupOperation(db: Pool, i: { syncId: string; outcome: "applied" | "not_applied" | "abandoned"; reason: string; actor: ActorAssertion }): Promise<void> {
  if (!/\S/.test(i.reason ?? "")) throw new DomainError("INVALID_INPUT", "A resolution reason is required");
  await withActorTransaction(db, i.actor, async (tx) => {
    await authorize(tx, "keepup.sync.manual");
    await tx.query("SELECT movezz_sec.keepup_op_resolve($1, $2, $3)", [i.syncId, i.outcome, i.reason]);
  });
}

/** Re-queues a payment/cancel operation that FAILED definitively (never one with an unknown outcome). */
export async function retryKeepupOperation(db: Pool, i: { syncId: string; reason: string; actor: ActorAssertion }): Promise<void> {
  if (!/\S/.test(i.reason ?? "")) throw new DomainError("INVALID_INPUT", "A retry reason is required");
  await withActorTransaction(db, i.actor, async (tx) => {
    await authorize(tx, "keepup.sync.manual");
    await tx.query("SELECT movezz_sec.keepup_op_manual_retry($1, $2)", [i.syncId, i.reason]);
  });
}

export async function requeueDeadNotification(db: Pool, i: { outboxId: string; reason: string; actor: ActorAssertion }): Promise<void> {
  if (!/\S/.test(i.reason ?? "")) throw new DomainError("INVALID_INPUT", "A reason is required");
  await withActorTransaction(db, i.actor, async (tx) => {
    await authorize(tx, "keepup.sync.manual");
    await tx.query("SELECT movezz_sec.outbox_requeue_dead($1, $2)", [i.outboxId, i.reason]);
  });
}
