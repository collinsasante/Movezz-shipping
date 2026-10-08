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
import type { KeepupCreateOutcome, KeepupGateway, KeepupSaleRequest } from "../../integrations/keepup-gateway";

export interface KeepupWorkerOptions {
  gateway: KeepupGateway;
  /** Stable name of this worker process, e.g. "keepup-worker-1". Recorded as the lease owner. */
  owner: string;
  batch?: number;
  leaseSeconds?: number;
  /** Upper bound for one gateway call. Must be comfortably below the lease so a live call can never outlive its own lease. */
  callTimeoutMs?: number;
  /** "integration" (default) or "system". */
  actorType?: "integration" | "system";
  /** Test seam: replaces the default request builder. A throw here means no request was sent (a definite failure). */
  buildRequest?: (tx: Parameters<typeof buildRequest>[0], row: Claimed) => Promise<KeepupSaleRequest>;
}

export interface KeepupWorkerResult { reaped: number; claimed: number; synced: number; failed: number; ambiguous: number; needsReconciliation: number }

export interface Claimed { id: string; invoice_id: string; lease_token: string; attempt_count: number; idempotency_key: string }

const actor = (o: KeepupWorkerOptions, phase: string): ActorAssertion =>
  ({ type: o.actorType ?? "integration", requestId: `keepup:${o.owner}:${phase}:${Date.now().toString(36)}` });

export async function runKeepupWorkerOnce(db: Pool, o: KeepupWorkerOptions): Promise<KeepupWorkerResult> {
  const lease = o.leaseSeconds ?? 120;
  const timeout = o.callTimeoutMs ?? 20_000;
  if (timeout >= lease * 1000 - 5000) throw new Error("callTimeoutMs must be at least 5s below the lease");
  const res: KeepupWorkerResult = { reaped: 0, claimed: 0, synced: 0, failed: 0, ambiguous: 0, needsReconciliation: 0 };

  const claimed = await withActorTransaction(db, actor(o, "claim"), async (tx) => {
    res.reaped = (await tx.query<{ n: number }>("SELECT movezz_sec.keepup_reap_expired(50) AS n")).rows[0].n;
    return (await tx.query<Claimed>("SELECT id, invoice_id, lease_token, attempt_count, idempotency_key FROM movezz_sec.keepup_claim($1, $2, $3)", [o.batch ?? 5, lease, o.owner])).rows;
  });
  res.claimed = claimed.length;

  for (const row of claimed) {
    // build the request (read-only). A failure here means NO request was sent: a definite, retryable failure.
    let req: KeepupSaleRequest;
    try {
      req = await withActorTransaction(db, actor(o, "build"), (tx) => (o.buildRequest ?? buildRequest)(tx, row));
    } catch (e) {
      await record(db, o, "SELECT movezz_sec.keepup_fail($1, $2, $3)", [row.id, row.lease_token, `could not build the request: ${(e as Error).message}`]);
      res.failed++;
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
      } else if (outcome.kind === "rejected") {
        await record(db, o, "SELECT movezz_sec.keepup_fail($1, $2, $3)", [row.id, row.lease_token, outcome.reason]);
        res.failed++;
      } else {
        await record(db, o, "SELECT movezz_sec.keepup_ambiguous($1, $2, $3)", [row.id, row.lease_token, outcome.reason]);
        res.ambiguous++;
      }
    } catch {
      // The outcome could not be recorded (database unavailable, lease lost). The row stays 'creating'; the reaper will move it to
      // 'needs_reconciliation' when the lease expires. Nothing is retried and nothing is reported as success.
      res.needsReconciliation++;
    }
  }
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
