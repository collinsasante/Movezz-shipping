// Notification outbox worker (Phase 7H). Same shape as the Keepup worker: claim (commit 'sending' + lease) -> send with no
// transaction open -> record. Delivery is AT-LEAST-ONCE: if the process dies after the provider accepted a message but before
// 'sent' was recorded, the lease expires and the row is retried. The sender therefore receives the row id as an idempotency key
// (Resend and most providers de-duplicate on it); a sender that cannot de-duplicate must accept an occasional repeat.
import type { Pool } from "pg";
import { describeError, logEvent } from "../log";
import { withActorTransaction, type ActorAssertion } from "../actor";

export interface OutboundMessage { id: string; eventType: string; channel: "email" | "whatsapp"; recipient: string; payload: Record<string, unknown>; attempt: number; idempotencyKey: string }
export type SendOutcome =
  | { kind: "sent"; providerRef?: string }
  | { kind: "retry"; reason: string }           // transient (timeout, 5xx, rate limit): back-off, then retry
  | { kind: "permanent"; reason: string };      // never going to work (invalid address, rejected content): dead-letter
export interface NotificationSender { send(msg: OutboundMessage, opts: { signal?: AbortSignal }): Promise<SendOutcome> }

export interface OutboxWorkerOptions {
  sender: NotificationSender;
  owner: string;
  batch?: number;
  leaseSeconds?: number;
  sendTimeoutMs?: number;
  actorType?: "integration" | "system";
}
export interface OutboxWorkerResult { reaped: number; claimed: number; sent: number; retried: number; dead: number; unrecorded: number }

const actor = (o: OutboxWorkerOptions, phase: string): ActorAssertion =>
  ({ type: o.actorType ?? "integration", requestId: `outbox:${o.owner}:${phase}:${Date.now().toString(36)}` });

export async function runOutboxWorkerOnce(db: Pool, o: OutboxWorkerOptions): Promise<OutboxWorkerResult> {
  const lease = o.leaseSeconds ?? 120;
  const timeout = o.sendTimeoutMs ?? 20_000;
  if (timeout >= lease * 1000 - 5000) throw new Error("sendTimeoutMs must be at least 5s below the lease");
  const res: OutboxWorkerResult = { reaped: 0, claimed: 0, sent: 0, retried: 0, dead: 0, unrecorded: 0 };
  const rows = await withActorTransaction(db, actor(o, "claim"), async (tx) => {
    res.reaped = (await tx.query<{ n: number }>("SELECT movezz_sec.outbox_reap_expired(100) AS n")).rows[0].n;
    return (await tx.query("SELECT id, event_type, channel, recipient, payload, attempts, lease_token FROM movezz_sec.outbox_claim($1, $2, $3)", [o.batch ?? 10, lease, o.owner])).rows;
  });
  res.claimed = rows.length;
  const cid = actor(o, "pass").requestId;
  if (res.reaped) logEvent("warn", "outbox.lease_expired", { count: res.reaped, owner: o.owner }, cid);
  logEvent("info", "outbox.claimed", { count: rows.length, owner: o.owner }, cid);
  for (const r of rows) {
    let outcome: SendOutcome;
    try {
      outcome = await o.sender.send(
        { id: r.id, eventType: r.event_type, channel: r.channel, recipient: r.recipient, payload: r.payload ?? {}, attempt: r.attempts, idempotencyKey: `outbox:${r.id}` },
        { signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      outcome = { kind: "retry", reason: `sender error: ${(e as Error).message}` };
    }
    try {
      await withActorTransaction(db, actor(o, "record"), async (tx) => {
        if (outcome.kind === "sent") { await tx.query("SELECT movezz_sec.outbox_complete($1, $2, $3)", [r.id, r.lease_token, outcome.providerRef ?? null]); res.sent++; logEvent("info", "outbox.sent", { outboxId: r.id, attempt: r.attempts, eventType: r.event_type, channel: r.channel }, cid); }
        else {
          const st = (await tx.query<{ s: string }>("SELECT movezz_sec.outbox_fail($1, $2, $3, $4) AS s", [r.id, r.lease_token, outcome.reason, outcome.kind === "permanent"])).rows[0].s;
          if (st === "dead") res.dead++; else res.retried++;
          logEvent(st === "dead" ? "error" : "warn", st === "dead" ? "outbox.dead_lettered" : "outbox.retry_scheduled", { outboxId: r.id, attempt: r.attempts, eventType: r.event_type, channel: r.channel, reason: outcome.reason }, cid);
        }
      });
    } catch (e) {
      logEvent("error", "outbox.record_failed", { outboxId: r.id, attempt: r.attempts, ...describeError(e) }, cid);
      res.unrecorded++;                                   // stays 'sending'; the reaper retries it when the lease expires
    }
  }
  return res;
}

/** In-memory sender for tests: scripted outcomes, a record of what was "sent", and a hook to simulate a crash after acceptance. */
export class MockNotificationSender implements NotificationSender {
  readonly accepted: OutboundMessage[] = [];
  private script: (SendOutcome | Error | ((m: OutboundMessage) => SendOutcome))[] = [];
  enqueue(...o: (SendOutcome | Error | ((m: OutboundMessage) => SendOutcome))[]): this { this.script.push(...o); return this; }
  async send(msg: OutboundMessage): Promise<SendOutcome> {
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") { const r = next(msg); if (r.kind !== "sent") return r; this.accepted.push(msg); return r; }
    if (next && next.kind !== "sent") return next;
    this.accepted.push(msg);
    return next ?? { kind: "sent", providerRef: `mock-${this.accepted.length}` };
  }
}
