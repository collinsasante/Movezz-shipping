// Keepup sync worker (Phase 7H). One pass = reap -> claim -> (external call, outside any transaction) -> record.
//
// The crash-safety argument, step by step (the exact states are tabulated in docs/OPERATIONAL-RELIABILITY.md):
//   1. claim      one short transaction commits state 'creating' + a lease token BEFORE Keepup is contacted.
//   2. call       the gateway is called with NO database transaction open (no locks held across the network).
//   3. record     one short transaction applies the outcome through a function that requires the lease token of THIS attempt.
// A crash between 1 and 3 leaves 'creating' with an expiring lease. The reaper turns an expired lease into 'needs_reconciliation'
// ("outcome unknown") - a row is never put back to 'pending' without proof that nothing was created, because that is how duplicate
// sales would happen. Only a definitive rejection (kind: "rejected") or an error raised BEFORE the request was built is 'failed'
// (retried with back-off, bounded by max_attempts).
import type { Pool } from "pg";
import { withActorTransaction, type ActorAssertion } from "../actor";
import { describeError, logEvent } from "../log";
import type { KeepupCancelRequest, KeepupCreateOutcome, KeepupGateway, KeepupOpOutcome, KeepupPaymentRequest, KeepupSaleRequest } from "../../integrations/keepup-gateway";

export interface KeepupWorkerOptions {
  gateway: KeepupGateway;
  /** Stable name of this worker process, e.g. "keepup-worker-1". Recorded as the lease owner. */
  owner: string;
  batch?: number;
  leaseSeconds?: number;
  /** Upper bound for one gateway call. Must be comfortably below the lease so a live call can never outlive its own lease. */
  callTimeoutMs?: number;
  /** Test seam: the clock used for the pre-send lease check (default Date.now). */
  clock?: () => number;
  /** "integration" (default) or "system". */
  actorType?: "integration" | "system";
  /** Test seam: replaces the default request builder. A throw here means no request was sent (a definite failure). */
  buildRequest?: (tx: Parameters<typeof buildRequest>[0], row: Claimed) => Promise<KeepupSaleRequest>;
}

export interface KeepupOpsResult { claimed: number; applied: number; failed: number; ambiguous: number; needsReconciliation: number; notSent: number }
export interface KeepupWorkerResult { reaped: number; claimed: number; synced: number; failed: number; ambiguous: number; needsReconciliation: number; notSent: number; ops: KeepupOpsResult }

export interface Claimed { id: string; invoice_id: string; lease_token: string; attempt_count: number; idempotency_key: string }

const actor = (o: KeepupWorkerOptions, phase: string): ActorAssertion =>
  ({ type: o.actorType ?? "integration", requestId: `keepup:${o.owner}:${phase}:${Date.now().toString(36)}` });

export async function runKeepupWorkerOnce(db: Pool, o: KeepupWorkerOptions): Promise<KeepupWorkerResult> {
  const lease = o.leaseSeconds ?? 120;
  const timeout = o.callTimeoutMs ?? 20_000;
  if (timeout >= lease * 1000 - 5000) throw new Error("callTimeoutMs must be at least 5s below the lease");
  const now = o.clock ?? Date.now;
  const res: KeepupWorkerResult = { reaped: 0, claimed: 0, synced: 0, failed: 0, ambiguous: 0, needsReconciliation: 0, notSent: 0, ops: { claimed: 0, applied: 0, failed: 0, ambiguous: 0, needsReconciliation: 0, notSent: 0 } };

  const claimed = await withActorTransaction(db, actor(o, "claim"), async (tx) => {
    res.reaped = (await tx.query<{ n: number }>("SELECT movezz_sec.keepup_reap_expired(50) AS n")).rows[0].n;
    return (await tx.query<Claimed>("SELECT id, invoice_id, lease_token, attempt_count, idempotency_key FROM movezz_sec.keepup_claim($1, $2, $3)", [o.batch ?? 5, lease, o.owner])).rows;
  });
  res.claimed = claimed.length;
  const claimedAt = now();
  // A row is only sent while its lease can still cover the call. Rows later in a batch may wait behind slower calls; if the lease would run out before
  // the call ends, the request is NOT sent (it is recorded as a definite, retryable failure) - otherwise the reaper could park a row as unknown while a
  // late request is still going out.
  const leaseCoversCall = () => now() - claimedAt + timeout <= lease * 1000 - 5000;
  const cid = actor(o, "pass").requestId;
  if (res.reaped) logEvent("warn", "keepup.lease_expired", { count: res.reaped, owner: o.owner }, cid);
  logEvent("info", "keepup.claimed", { count: claimed.length, owner: o.owner }, cid);

  for (const row of claimed) {
    // build the request (read-only). A failure here means NO request was sent: a definite, retryable failure.
    let req: KeepupSaleRequest;
    try {
      req = await withActorTransaction(db, actor(o, "build"), (tx) => (o.buildRequest ?? buildRequest)(tx, row));
    } catch (e) {
      await record(db, o, "SELECT movezz_sec.keepup_fail($1, $2, $3)", [row.id, row.lease_token, `could not build the request: ${(e as Error).message}`]);
      logEvent("warn", "keepup.sync_failed", { syncId: row.id, attempt: row.attempt_count, stage: "build", ...describeError(e) }, cid);
      res.failed++;
      continue;
    }
    if (!leaseCoversCall()) {
      await record(db, o, "SELECT movezz_sec.keepup_fail($1, $2, $3)", [row.id, row.lease_token, "not sent: the lease would have expired before the call could finish"]);
      logEvent("warn", "keepup.not_sent_lease", { syncId: row.id, attempt: row.attempt_count }, cid);
      res.notSent++; res.failed++;
      continue;
    }
    // the external call, with no transaction open. Any thrown error is ambiguous: the request may have left the process.
    let outcome: KeepupCreateOutcome;
    try {
      outcome = await o.gateway.createSale(req, { signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      outcome = { kind: "ambiguous", reason: `gateway error: ${(e as Error).message}` };
    }
    try {
      if (outcome.kind === "created" && !outcome.saleId?.trim()) outcome = { kind: "ambiguous", reason: "gateway reported success without a sale id" };
      if (outcome.kind === "created") {
        const r = await record(db, o, "SELECT movezz_sec.keepup_complete($1, $2, $3, $4, $5, $6::jsonb) AS s",
          [row.id, row.lease_token, outcome.saleId, outcome.externalStatus ?? null, outcome.link ?? null, JSON.stringify(outcome.link ? { share_link: outcome.link } : {})]);
        if (r === "synced") res.synced++; else res.needsReconciliation++;
        logEvent(r === "synced" ? "info" : "warn", r === "synced" ? "keepup.synced" : "keepup.needs_reconciliation", { syncId: row.id, attempt: row.attempt_count, reason: r === "synced" ? undefined : "sale created after cancellation or duplicate sale id" }, cid);
      } else if (outcome.kind === "rejected") {
        await record(db, o, "SELECT movezz_sec.keepup_fail($1, $2, $3)", [row.id, row.lease_token, outcome.reason]);
        res.failed++;
        logEvent("warn", "keepup.sync_failed", { syncId: row.id, attempt: row.attempt_count, stage: "rejected", reason: outcome.reason }, cid);
      } else {
        await record(db, o, "SELECT movezz_sec.keepup_ambiguous($1, $2, $3)", [row.id, row.lease_token, outcome.reason]);
        res.ambiguous++;
        logEvent("warn", "keepup.outcome_unknown", { syncId: row.id, attempt: row.attempt_count, reason: outcome.reason }, cid);
      }
    } catch (e) {
      logEvent("error", "keepup.record_failed", { syncId: row.id, attempt: row.attempt_count, ...describeError(e) }, cid);
      // The outcome could not be recorded (database unavailable, lease lost). The row stays 'creating'; the reaper will move it to
      // 'needs_reconciliation' when the lease expires. Nothing is retried and nothing is reported as success.
      res.needsReconciliation++;
    }
  }
  await runOperations(db, o, res.ops, now, lease, timeout);
  return res;
}

async function record(db: Pool, o: KeepupWorkerOptions, sql: string, params: unknown[]): Promise<string> {
  return withActorTransaction(db, actor(o, "record"), async (tx) => {
    const r = await tx.query(sql, params);
    const v = r.rows[0] as Record<string, unknown>;
    return String(v.s ?? Object.values(v)[0]);
  });
}

async function buildRequest(tx: { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, row: Claimed): Promise<KeepupSaleRequest> {
  const inv = (await tx.query(
    `SELECT i.invoice_ref, i.invoice_date::text AS invoice_date, i.total_ghs, i.subtotal_usd, i.discount_usd, c.name, c.email, c.phone
       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`, [row.invoice_id])).rows[0];
  if (!inv) throw new Error("invoice not found");
  const lines = (await tx.query("SELECT description, line_total_usd FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no", [row.invoice_id])).rows;
  if (lines.length === 0) throw new Error("invoice has no lines");
  // Keepup receives the frozen GHS total (the customer pays in GHS). Each line is scaled by total/sum(lines) in integer pesewas; the
  // last line takes the rounding remainder, so the lines always add up to EXACTLY the invoice total (a discount never makes a line negative).
  const totalPesewas = Math.round(Number(inv.total_ghs) * 100);
  const weights = lines.map((l) => Math.round(Number(l.line_total_usd) * 100));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (!(totalPesewas > 0) || !(weightSum > 0)) throw new Error("invoice total is not billable");
  let allocated = 0;
  const items = lines.map((l, idx) => {
    const pesewas = idx === lines.length - 1 ? totalPesewas - allocated : Math.round((weights[idx] * totalPesewas) / weightSum);
    allocated += pesewas;
    return { item_name: String(l.description).slice(0, 120), quantity: 1, price: pesewas / 100 };
  });
  return { reference: String(inv.invoice_ref), idempotencyKey: row.idempotency_key, customerName: String(inv.name), customerEmail: (inv.email as string) ?? undefined,
           customerPhone: (inv.phone as string) ?? undefined, invoiceDate: String(inv.invoice_date), items };
}


interface ClaimedOp { id: string; kind: "payment" | "cancel"; invoice_id: string; payment_id: string | null; sale_id: string; lease_token: string; attempt_count: number; idempotency_key: string }

/** Payments and sale cancellations (migration 0019). Same crash-safety argument as sale creation: claim commits first, the call has no open transaction, the outcome is recorded with this attempt's lease token. */
async function runOperations(db: Pool, o: KeepupWorkerOptions, out: KeepupOpsResult, now: () => number, lease: number, timeout: number): Promise<void> {
  const claimed = await withActorTransaction(db, actor(o, "op-claim"), async (tx) =>
    (await tx.query<ClaimedOp>("SELECT id, kind, invoice_id, payment_id, sale_id, lease_token, attempt_count, idempotency_key FROM movezz_sec.keepup_op_claim($1, $2, $3)", [o.batch ?? 5, lease, o.owner])).rows);
  out.claimed = claimed.length;
  const claimedAt = now(); const cid = actor(o, "ops").requestId;
  const rec = (sql: string, params: unknown[]) => record(db, o, sql, params);
  for (const row of claimed) {
    let req: KeepupPaymentRequest | KeepupCancelRequest;
    try { req = await withActorTransaction(db, actor(o, "op-build"), (tx) => buildOperation(tx, row)); }
    catch (e) {
      await rec("SELECT movezz_sec.keepup_op_fail($1, $2, $3)", [row.id, row.lease_token, `could not build the request: ${(e as Error).message}`]);
      logEvent("warn", "keepup.op_failed", { syncId: row.id, kind: row.kind, stage: "build", ...describeError(e) }, cid); out.failed++; continue;
    }
    if (now() - claimedAt + timeout > lease * 1000 - 5000) {
      await rec("SELECT movezz_sec.keepup_op_fail($1, $2, $3)", [row.id, row.lease_token, "not sent: the lease would have expired before the call could finish"]);
      logEvent("warn", "keepup.not_sent_lease", { syncId: row.id, kind: row.kind }, cid); out.notSent++; out.failed++; continue;
    }
    let outcome: KeepupOpOutcome;
    try {
      outcome = row.kind === "payment" ? await o.gateway.recordPayment(req as KeepupPaymentRequest, { signal: AbortSignal.timeout(timeout) }) : await o.gateway.cancelSale(req as KeepupCancelRequest, { signal: AbortSignal.timeout(timeout) });
    } catch (e) { outcome = { kind: "ambiguous", reason: `gateway error: ${(e as Error).message}` }; }
    try {
      if (outcome.kind === "applied") {
        const r = await rec("SELECT movezz_sec.keepup_op_complete($1, $2, '{}'::jsonb) AS s", [row.id, row.lease_token]);
        if (r === "synced") out.applied++; else out.needsReconciliation++;
        logEvent(r === "synced" ? "info" : "warn", r === "synced" ? "keepup.op_synced" : "keepup.op_needs_reconciliation", { syncId: row.id, kind: row.kind, attempt: row.attempt_count }, cid);
      } else if (outcome.kind === "rejected") {
        await rec("SELECT movezz_sec.keepup_op_fail($1, $2, $3)", [row.id, row.lease_token, outcome.reason]); out.failed++;
        logEvent("warn", "keepup.op_failed", { syncId: row.id, kind: row.kind, stage: "rejected", reason: outcome.reason }, cid);
      } else {
        await rec("SELECT movezz_sec.keepup_op_ambiguous($1, $2, $3)", [row.id, row.lease_token, outcome.reason]); out.ambiguous++;
        logEvent("warn", "keepup.op_outcome_unknown", { syncId: row.id, kind: row.kind, reason: outcome.reason }, cid);
      }
    } catch (e) {
      logEvent("error", "keepup.op_record_failed", { syncId: row.id, kind: row.kind, ...describeError(e) }, cid);
      out.needsReconciliation++;   // the row stays 'creating'; the reaper parks it for reconciliation when the lease ends. Nothing is retried, nothing is reported as success.
    }
  }
}

async function buildOperation(tx: { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, row: ClaimedOp): Promise<KeepupPaymentRequest | KeepupCancelRequest> {
  const inv = (await tx.query("SELECT invoice_ref FROM invoices WHERE id = $1", [row.invoice_id])).rows[0];
  if (!inv) throw new Error("invoice not found");
  if (row.kind === "cancel") return { saleId: row.sale_id, reference: String(inv.invoice_ref), idempotencyKey: row.idempotency_key };
  const p = (await tx.query("SELECT amount_ghs::text AS amount_ghs, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS paid_on, status FROM payments WHERE id = $1", [row.payment_id])).rows[0];
  if (!p) throw new Error("payment not found");
  if (p.status !== "completed") throw new Error("payment is not completed");
  return { saleId: row.sale_id, amountGhs: String(p.amount_ghs), paidOn: String(p.paid_on), reference: String(inv.invoice_ref), idempotencyKey: row.idempotency_key };
}

/** Counts of Keepup work by kind and state, for the operator: anything in failed / needs_reconciliation needs a person. Read-only. */
export async function keepupBacklog(db: Pool, owner = "keepup-backlog"): Promise<{ kind: string; state: string; n: number }[]> {
  return withActorTransaction(db, { type: "integration", requestId: `keepup:${owner}:backlog` }, async (tx) =>
    (await tx.query<{ kind: string; state: string; n: number }>("SELECT kind, sync_state AS state, count(*)::int AS n FROM keepup_sync GROUP BY 1, 2 ORDER BY 1, 2")).rows);
}
