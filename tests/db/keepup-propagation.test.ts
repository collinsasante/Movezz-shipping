// Keepup payment and cancellation propagation (migration 0019) against a fake gateway and a local stub server. No real provider, no credentials.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dbDescribe, createTestDb, customer, staffUser, fxRate, packageRates, pricedItem, sqlstate, type TestDb } from "./helpers";
import { createInvoice, recordPayment, voidPayment, cancelInvoice } from "../../src/lib/db/invoices";
import { user, withActorTransaction, type ActorAssertion } from "../../src/lib/db/actor";
import { runKeepupWorkerOnce, keepupBacklog } from "../../src/lib/db/workers/keepup-worker";
import { resolveKeepupOperation, retryKeepupOperation } from "../../src/lib/db/integration-admin";
import { MockKeepupGateway, HttpKeepupGateway } from "../../src/lib/integrations/keepup-gateway";

let n = 0; const key = () => `kp-${Date.now()}-${++n}-abcdefgh`;
const svc: ActorAssertion = { type: "integration" };

dbDescribe("Keepup payment and cancellation propagation (fake gateway)", () => {
  let db: TestDb; let admin: string; let staff: string;
  beforeAll(async () => { db = await createTestDb(); admin = await staffUser(db.admin, "super_admin"); staff = await staffUser(db.admin, "warehouse_staff"); await packageRates(db.admin); await fxRate(db.admin); });
  afterAll(async () => { await db?.close(); });
  const mkInvoice = async (usd = "100.00") => { const c = await customer(db.admin); const i = await pricedItem(db.admin, c, usd); const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(admin), idempotencyKey: key() }); return invoice; };
  const pay = (invoiceId: string, amountGhs: string, extra: object = {}) => recordPayment(db.app, { invoiceId, amountGhs, actor: user(admin), idempotencyKey: key(), ...extra });
  const run = (gateway: MockKeepupGateway, over: object = {}) => runKeepupWorkerOnce(db.app, { gateway, owner: "w1", batch: 50, leaseSeconds: 60, callTimeoutMs: 20_000, ...over });
  const rows = async (invoiceId: string) => (await db.admin.query("SELECT id, kind, sync_state, attempt_count, keepup_sale_id, last_error, payment_id FROM keepup_sync WHERE invoice_id = $1 ORDER BY created_at, id", [invoiceId])).rows;
  const op = async (invoiceId: string, kind: string, i = 0) => (await rows(invoiceId)).filter((r) => r.kind === kind)[i];
  const drain = () => db.admin.query("UPDATE keepup_sync SET sync_state = 'cancelled' WHERE sync_state IN ('pending','failed')");
  beforeEach(drain);

  it("sends payments only after the sale exists, in creation order, exactly once each, with the real amount and invoice reference", async () => {
    const inv = await mkInvoice(); await pay(inv.id, "50.00"); await pay(inv.id, "30.5");
    const down = new MockKeepupGateway().enqueue({ kind: "ambiguous", reason: "timeout" });
    const r0 = await run(down); expect(down.receivedPayments).toEqual([]);                                   // no sale yet: nothing is sent
    expect(r0.ops.claimed).toBe(0); expect((await op(inv.id, "payment", 0)).sync_state).toBe("pending");
    await db.admin.query("UPDATE keepup_sync SET sync_state = 'cancelled' WHERE invoice_id = $1 AND kind = 'invoice'", [inv.id]);   // (that attempt is parked; use a fresh invoice for the happy path)
    const inv2 = await mkInvoice(); await pay(inv2.id, "50.00"); await pay(inv2.id, "30.5");
    const gw = new MockKeepupGateway(); const r = await run(gw);
    expect(r.synced).toBe(1); expect(r.ops).toMatchObject({ claimed: 1, applied: 1 });                         // one operation per invoice per pass (strict order)
    const r2 = await run(gw); expect(r2.ops).toMatchObject({ claimed: 1, applied: 1 });
    expect(gw.receivedPayments.map((p) => p.amountGhs)).toEqual(["50.00", "30.50"]);
    expect(gw.receivedPayments[0]).toMatchObject({ saleId: expect.stringMatching(/^MOCK-/), reference: expect.stringMatching(/^ORD-/), paidOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect((await rows(inv2.id)).map((x) => x.sync_state)).toEqual(["synced", "synced", "synced"]);
    const again = await run(gw); expect(again.ops.claimed).toBe(0); expect(gw.receivedPayments).toHaveLength(2);   // nothing is ever re-sent
  });

  it("an unresolved or failed earlier payment blocks later ones; a rejection backs off; a manual retry resumes the sequence in order", async () => {
    const inv = await mkInvoice(); await pay(inv.id, "10.00"); await pay(inv.id, "20.00");
    const gw = new MockKeepupGateway().enqueueOps({ kind: "rejected", reason: "Keepup rejected the request (HTTP 422)" });
    await run(gw);                                                                                            // sale created, first payment rejected
    const first = await op(inv.id, "payment", 0); expect(first).toMatchObject({ sync_state: "failed", attempt_count: 1 });
    expect((await db.admin.query("SELECT next_retry_at > now() AS later FROM keepup_sync WHERE id = $1", [first.id])).rows[0].later).toBe(true);
    await run(gw); expect(gw.receivedPayments).toHaveLength(1);                                               // backed off, and the second payment does not jump the queue
    await db.admin.query("UPDATE keepup_sync SET next_retry_at = now() WHERE id = $1", [first.id]);
    await run(gw); await run(gw);
    expect(gw.receivedPayments.map((p) => p.amountGhs)).toEqual(["10.00", "10.00", "20.00"]);                  // the rejected one was retried (definite failure), then the next
    expect((await rows(inv.id)).map((x) => x.sync_state)).toEqual(["synced", "synced", "synced"]);
    // retries are bounded; then it parks as 'failed' with no schedule until a person retries it
    const inv2 = await mkInvoice(); await pay(inv2.id, "5.00");
    const bad = new MockKeepupGateway(); for (let i = 0; i < 8; i++) bad.enqueueOps({ kind: "rejected", reason: "422" });
    for (let i = 0; i < 6; i++) { await run(bad); await db.admin.query("UPDATE keepup_sync SET next_retry_at = now() WHERE invoice_id = $1 AND kind = 'payment' AND sync_state = 'failed' AND attempt_count < 5", [inv2.id]); }
    const p2 = await op(inv2.id, "payment"); expect(p2.sync_state).toBe("failed"); expect(p2.attempt_count).toBe(5);
    expect((await db.admin.query("SELECT next_retry_at FROM keepup_sync WHERE id = $1", [p2.id])).rows[0].next_retry_at).toBeNull();
    await expect(retryKeepupOperation(db.app, { syncId: p2.id, reason: "", actor: user(admin) })).rejects.toThrow(/reason/);
    await expect(retryKeepupOperation(db.app, { syncId: p2.id, reason: "try again", actor: user(staff) })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await retryKeepupOperation(db.app, { syncId: p2.id, reason: "Keepup fixed the account", actor: user(admin) });
    const ok = new MockKeepupGateway(); await run(ok); expect((await op(inv2.id, "payment")).sync_state).toBe("synced");
  });

  it("AMBIGUOUS payment answers (timeout, 5xx, thrown error) are never re-sent: they park for a person, block later payments, and resolve in explicit ways", async () => {
    const inv = await mkInvoice(); await pay(inv.id, "10.00"); await pay(inv.id, "20.00");
    const gw = new MockKeepupGateway().enqueueOps({ kind: "ambiguous", reason: "timeout" });
    await run(gw);
    const p1 = await op(inv.id, "payment", 0); expect(p1.sync_state).toBe("needs_reconciliation");
    for (let i = 0; i < 3; i++) await run(gw);
    expect(gw.receivedPayments).toHaveLength(1);                                                              // never re-sent, and the second payment waits behind it
    await expect(resolveKeepupOperation(db.app, { syncId: p1.id, outcome: "applied", reason: "checked", actor: user(staff) })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(resolveKeepupOperation(db.app, { syncId: p1.id, outcome: "applied", reason: " ", actor: user(admin) })).rejects.toThrow(/reason/);
    await resolveKeepupOperation(db.app, { syncId: p1.id, outcome: "applied", reason: "Seen in the Keepup sale payments", actor: user(admin) });
    expect((await op(inv.id, "payment", 0)).sync_state).toBe("synced");
    await run(gw); expect(gw.receivedPayments.map((p) => p.amountGhs)).toEqual(["10.00", "20.00"]);          // the sequence resumes only after the person decided
    expect((await db.admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'keepup.resolve' AND entity_id = $1", [p1.id])).rows[0].n).toBe(1);
    // not_applied -> pending -> re-sent exactly once
    const inv2 = await mkInvoice(); await pay(inv2.id, "7.00");
    const g2 = new MockKeepupGateway().enqueueOps(new Error("socket hang up"), { kind: "applied" });
    await run(g2); const q = await op(inv2.id, "payment"); expect(q.sync_state).toBe("needs_reconciliation");
    await resolveKeepupOperation(db.app, { syncId: q.id, outcome: "not_applied", reason: "Not present in Keepup", actor: user(admin) });
    await run(g2); expect(g2.receivedPayments).toHaveLength(2); expect((await op(inv2.id, "payment")).sync_state).toBe("synced");
    // a person can also abandon an operation they handled by hand
    const inv3 = await mkInvoice(); await pay(inv3.id, "3.00"); const g3 = new MockKeepupGateway().enqueueOps({ kind: "ambiguous", reason: "HTTP 503" });
    await run(g3); await resolveKeepupOperation(db.app, { syncId: (await op(inv3.id, "payment")).id, outcome: "abandoned", reason: "Entered manually in Keepup", actor: user(admin) });
    expect((await op(inv3.id, "payment")).sync_state).toBe("cancelled");
  });

  it("crash recovery: a claim that never reported back is parked by the reaper and is NEVER sent again", async () => {
    const inv = await mkInvoice(); await pay(inv.id, "40.00"); const setup = new MockKeepupGateway(); await run(setup);   // sale created and the payment sent in this pass
    const inv2 = await mkInvoice(); await run(new MockKeepupGateway());                                                  // sale for inv2
    await pay(inv2.id, "15.00");
    const claimed = await withActorTransaction(db.app, svc, async (tx) => (await tx.query("SELECT id, lease_token FROM movezz_sec.keepup_op_claim(5, 10, 'crashing-worker')")).rows);
    expect(claimed).toHaveLength(1);                                                                                     // ... and the process dies here, before calling Keepup
    const id = claimed[0].id;
    expect((await db.admin.query("SELECT sync_state FROM keepup_sync WHERE id = $1", [id])).rows[0].sync_state).toBe("creating");
    const gw = new MockKeepupGateway(); await run(gw); expect(gw.receivedPayments).toEqual([]);                           // lease still valid: another worker waits
    await db.admin.query("UPDATE keepup_sync SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    const after = await run(gw); expect(after.reaped).toBe(1);
    expect((await db.admin.query("SELECT sync_state, last_error FROM keepup_sync WHERE id = $1", [id])).rows[0]).toMatchObject({ sync_state: "needs_reconciliation", last_error: expect.stringMatching(/unknown/) });
    await run(gw); await run(gw); expect(gw.receivedPayments).toEqual([]);
  });

  it("parallel workers never send the same operation twice and keep one operation in flight per invoice", async () => {
    const invs = [await mkInvoice(), await mkInvoice(), await mkInvoice()];
    await run(new MockKeepupGateway());                                                                                   // sales exist, no payments yet
    for (const i of invs) { await pay(i.id, "11.00"); await pay(i.id, "12.00"); }
    const gw = new MockKeepupGateway();
    await Promise.all([1, 2, 3, 4].map((k) => run(gw, { owner: `w${k}` }))); await Promise.all([1, 2, 3, 4].map((k) => run(gw, { owner: `w${k}` })));
    const amounts = gw.receivedPayments.map((p) => `${p.reference}:${p.amountGhs}`);
    expect(new Set(amounts).size).toBe(amounts.length);                                                                   // no duplicates
    expect(amounts).toHaveLength(6);
    for (const i of invs) {
      const ref = (await db.admin.query("SELECT invoice_ref FROM invoices WHERE id = $1", [i.id])).rows[0].invoice_ref;
      expect(gw.receivedPayments.filter((p) => p.reference === ref).map((p) => p.amountGhs)).toEqual(["11.00", "12.00"]);   // order per invoice
    }
  });

  it("duplicate events: a replayed payment request queues nothing new; payments that came from Keepup are never pushed back", async () => {
    const inv = await mkInvoice(); const k = key();
    await recordPayment(db.app, { invoiceId: inv.id, amountGhs: "9.00", actor: user(admin), idempotencyKey: k });
    const again = await recordPayment(db.app, { invoiceId: inv.id, amountGhs: "9.00", actor: user(admin), idempotencyKey: k });
    expect(again.replayed).toBe(true); expect((await rows(inv.id)).filter((r) => r.kind === "payment")).toHaveLength(1);
    await pay(inv.id, "4.00", { source: "keepup", keepupReference: "KP-REF-1" });
    expect((await rows(inv.id)).filter((r) => r.kind === "payment")).toHaveLength(1);
    const gw = new MockKeepupGateway(); await run(gw); await run(gw); expect(gw.receivedPayments.map((p) => p.amountGhs)).toEqual(["9.00"]);
  });

  it("void: before sending the payment is dropped; after sending it is flagged for manual reversal; a late success after a void is kept as evidence, never 'synced'", async () => {
    const a = await mkInvoice(); const pa = await pay(a.id, "10.00");
    await voidPayment(db.app, { paymentId: pa.payment.id, reason: "entered twice", actor: user(admin) });
    expect((await op(a.id, "payment")).sync_state).toBe("cancelled"); const gw = new MockKeepupGateway(); await run(gw); expect(gw.receivedPayments).toEqual([]);
    const b = await mkInvoice(); const pb = await pay(b.id, "10.00"); await run(gw);
    expect((await op(b.id, "payment")).sync_state).toBe("synced");
    await voidPayment(db.app, { paymentId: pb.payment.id, reason: "bounced", actor: user(admin) });
    expect(await op(b.id, "payment")).toMatchObject({ sync_state: "needs_reconciliation", last_error: expect.stringMatching(/reverse it in Keepup manually/) });
    await expect(resolveKeepupOperation(db.app, { syncId: (await op(b.id, "payment")).id, outcome: "applied", reason: "it is there", actor: user(admin) })).rejects.toThrow(/voided/);
    await resolveKeepupOperation(db.app, { syncId: (await op(b.id, "payment")).id, outcome: "abandoned", reason: "Reversed by hand in Keepup", actor: user(admin) });
    // void DURING the call
    const c = await mkInvoice(); const pc = await pay(c.id, "10.00"); await run(new MockKeepupGateway().enqueueOps({ kind: "applied" }));   // (sale + payment)
    const d = await mkInvoice(); const pd = await pay(d.id, "10.00");
    const racing = new MockKeepupGateway().enqueueOps(async () => { await voidPayment(db.app, { paymentId: pd.payment.id, reason: "voided during the call", actor: user(admin) }); return { kind: "applied" as const }; });
    const out = await run(racing); expect(out.ops.needsReconciliation).toBe(1); expect(out.ops.applied).toBe(0);
    expect(await op(d.id, "payment")).toMatchObject({ sync_state: "needs_reconciliation", last_error: expect.stringMatching(/voided in Movezz meanwhile/) });
    void pc;
  });

  it("cancellation: queued only when the sale exists, sent once after the payments are settled, closes the invoice's own sync row, and never when ambiguous", async () => {
    const a = await mkInvoice(); const gw = new MockKeepupGateway(); await run(gw);                                         // sale exists
    await cancelInvoice(db.app, { invoiceId: a.id, reason: "wrong customer", actor: user(admin), idempotencyKey: key() });
    expect((await rows(a.id)).map((r) => `${r.kind}:${r.sync_state}`)).toEqual(["invoice:needs_reconciliation", "cancel:pending"]);
    const r = await run(gw); expect(r.ops).toMatchObject({ claimed: 1, applied: 1 });
    expect(gw.receivedCancels).toEqual([{ saleId: expect.stringMatching(/^MOCK-/), reference: expect.any(String), idempotencyKey: `cancel:${a.id}` }]);
    expect((await rows(a.id)).map((x) => `${x.kind}:${x.sync_state}`)).toEqual(["invoice:cancelled", "cancel:synced"]);
    await run(gw); expect(gw.receivedCancels).toHaveLength(1);
    // no sale yet: nothing is queued (the 0015 behaviour is unchanged)
    const b = await mkInvoice(); await cancelInvoice(db.app, { invoiceId: b.id, reason: "cancelled early", actor: user(admin), idempotencyKey: key() });
    expect((await rows(b.id)).map((x) => `${x.kind}:${x.sync_state}`)).toEqual(["invoice:cancelled"]);
    // ambiguous cancel: parked, not resent; the invoice row stays flagged
    const c = await mkInvoice(); const g2 = new MockKeepupGateway(); await run(g2);
    await cancelInvoice(db.app, { invoiceId: c.id, reason: "duplicate", actor: user(admin), idempotencyKey: key() });
    g2.enqueueOps({ kind: "ambiguous", reason: "HTTP 502" }); await run(g2); await run(g2); expect(g2.receivedCancels).toHaveLength(1);
    expect((await rows(c.id)).map((x) => `${x.kind}:${x.sync_state}`)).toEqual(["invoice:needs_reconciliation", "cancel:needs_reconciliation"]);
    await resolveKeepupOperation(db.app, { syncId: (await op(c.id, "cancel")).id, outcome: "applied", reason: "Sale shows as cancelled in Keepup", actor: user(admin) });
    expect((await rows(c.id)).map((x) => `${x.kind}:${x.sync_state}`)).toEqual(["invoice:cancelled", "cancel:synced"]);
    // a definite rejection (e.g. already cancelled) retries within bounds and then waits for a person
    const d = await mkInvoice(); const g3 = new MockKeepupGateway(); await run(g3); await cancelInvoice(db.app, { invoiceId: d.id, reason: "x-check", actor: user(admin), idempotencyKey: key() });
    g3.enqueueOps({ kind: "rejected", reason: "Keepup rejected the request (HTTP 422): already cancelled" }); await run(g3);
    expect(await op(d.id, "cancel")).toMatchObject({ sync_state: "failed", last_error: expect.stringMatching(/already cancelled/) });
  });

  it("a cancellation waits for every payment operation of the invoice; an unresolved voided payment must be settled by a person first", async () => {
    const a = await mkInvoice(); const gw = new MockKeepupGateway(); const p = await pay(a.id, "25.00"); await run(gw);          // sale + payment sent
    await voidPayment(db.app, { paymentId: p.payment.id, reason: "refund requested", actor: user(admin) });                    // flagged: reverse manually
    await cancelInvoice(db.app, { invoiceId: a.id, reason: "customer cancelled", actor: user(admin), idempotencyKey: key() });
    await run(gw); await run(gw); expect(gw.receivedCancels).toEqual([]);                                                       // blocked behind the unresolved payment row
    await resolveKeepupOperation(db.app, { syncId: (await op(a.id, "payment")).id, outcome: "abandoned", reason: "Payment reversed in Keepup by hand", actor: user(admin) });
    await run(gw); expect(gw.receivedCancels).toHaveLength(1);
  });

  it("lease safety: a call that could outlive its lease is not sent (definite, retryable failure), for sale creation and for operations", async () => {
    let t = 1_000_000; const clock = () => t;
    const invs = [await mkInvoice(), await mkInvoice(), await mkInvoice()];
    const gw = new MockKeepupGateway(); const slow = async () => { t += 40_000; return { kind: "created" as const, saleId: `SLOW-${t}` }; };
    gw.enqueue(slow, slow, slow);
    const r = await run(gw, { clock, leaseSeconds: 60, callTimeoutMs: 20_000 });
    expect(r).toMatchObject({ claimed: 3, synced: 1, notSent: 2, failed: 2 }); expect(gw.received).toHaveLength(1);
    const st = (await db.admin.query("SELECT sync_state, last_error FROM keepup_sync WHERE invoice_id = ANY($1::uuid[]) AND kind = 'invoice' ORDER BY created_at, id", [invs.map((i) => i.id)])).rows;
    expect(st.map((x) => x.sync_state)).toEqual(["synced", "failed", "failed"]); expect(st[1].last_error).toMatch(/not sent/);
    // operations: same guard
    t = 2_000_000; await db.admin.query("UPDATE keepup_sync SET sync_state = 'cancelled' WHERE sync_state = 'failed'");
    const x = await mkInvoice(), y = await mkInvoice(); const g = new MockKeepupGateway(); await run(g); await pay(x.id, "1.00"); await pay(y.id, "2.00");
    g.enqueueOps(async () => { t += 40_000; return { kind: "applied" as const }; });
    const o = await run(g, { clock, leaseSeconds: 60, callTimeoutMs: 20_000 }); expect(o.ops).toMatchObject({ claimed: 2, applied: 1, notSent: 1 }); expect(g.receivedPayments).toHaveLength(1);
  });

  it("authorization and integrity: only the service identity claims/completes, only a super_admin resolves, and the runtime role cannot forge states or sale ids", async () => {
    const inv = await mkInvoice(); await pay(inv.id, "6.00"); const row = await op(inv.id, "payment");
    const as = <T>(a: ActorAssertion, fn: (tx: import("pg").PoolClient) => Promise<T>) => withActorTransaction(db.app, a, fn);
    for (const a of [user(staff), user(admin)]) expect(await sqlstate(as(a, (tx) => tx.query("SELECT * FROM movezz_sec.keepup_op_claim(5, 60, 'x')")))).not.toBe("OK");
    expect(await sqlstate(as(svc, (tx) => tx.query("SELECT movezz_sec.keepup_op_resolve($1, 'applied', 'r')", [row.id])))).not.toBe("OK");   // the worker identity cannot resolve
    expect(await sqlstate(as(user(admin), (tx) => tx.query("SELECT movezz_sec.keepup_op_complete($1, gen_random_uuid(), '{}'::jsonb)", [row.id])))).not.toBe("OK");
    for (const sql of ["UPDATE keepup_sync SET sync_state = 'synced' WHERE id = $1", "UPDATE keepup_sync SET keepup_sale_id = 'FORGED' WHERE id = $1", "UPDATE keepup_sync SET attempt_count = 5 WHERE id = $1", "DELETE FROM keepup_sync WHERE id = $1"])
      expect(await sqlstate(as(user(admin), (tx) => tx.query(sql, [row.id]))), sql).not.toBe("OK");
    expect(await sqlstate(as(user(admin), (tx) => tx.query("INSERT INTO keepup_sync (kind, invoice_id, payment_id, idempotency_key, sync_state, keepup_sale_id) SELECT 'payment', invoice_id, gen_random_uuid(), 'forged:1', 'pending', 'X' FROM keepup_sync WHERE id = $1", [row.id])))).not.toBe("OK");
    // a wrong token completes nothing
    const claim = await as(svc, async (tx) => (await tx.query("SELECT id, lease_token FROM movezz_sec.keepup_op_claim(5, 60, 'auth-test')")).rows);
    if (claim.length) expect(await sqlstate(as(svc, (tx) => tx.query("SELECT movezz_sec.keepup_op_complete($1, gen_random_uuid(), '{}'::jsonb)", [claim[0].id])))).not.toBe("OK");
    // customers cannot see the queue
    const c = await customer(db.admin); const cu = (await db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('uid-kp-c','kpc@example.invalid','customer',$1) RETURNING id", [c])).rows[0].id;
    expect((await as(user(cu), (tx) => tx.query("SELECT count(*)::int AS n FROM keepup_sync"))).rows[0].n).toBe(0);
    const backlog = await keepupBacklog(db.app); expect(backlog.some((b) => b.kind === "payment")).toBe(true);
  });
});

describe("Keepup HTTP adapter: payment and cancel (local stub server)", () => {
  let server: http.Server; let base: string; let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void; const seen: { method?: string; url?: string; auth?: string; body?: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization as string, body: b }); handler(req, res); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2.0`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  beforeEach(() => { seen.length = 0; });
  const gw = (over: object = {}) => new HttpKeepupGateway({ baseUrl: base, apiKey: "sandbox-test-key", environment: "sandbox", timeoutMs: 300, ...over });
  const reply = (status: number, body = "{}") => { handler = (_q, res) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(body); }; };
  const PAY = { saleId: "S-1", amountGhs: "12.50", paidOn: "2026-03-04", reference: "ORD-00001", idempotencyKey: "payment:x" };

  it("uses the live client's paths and bodies (PUT /sales/balance/{id}, PUT /sales/cancel/{id}) and the bearer key", async () => {
    reply(200); expect(await gw().recordPayment(PAY)).toEqual({ kind: "applied" });
    expect(seen[0]).toMatchObject({ method: "PUT", url: "/v2.0/sales/balance/S-1", auth: "Bearer sandbox-test-key" });
    expect(JSON.parse(seen[0].body!)).toEqual({ amount_paid: "12.5", payment_type: "bank_transfer", date: "2026-03-04 00:00", alert_customer: "yes" });
    expect(await gw().cancelSale({ saleId: "S-1", reference: "ORD-1", idempotencyKey: "cancel:x" })).toEqual({ kind: "applied" });
    expect(seen[1]).toMatchObject({ method: "PUT", url: "/v2.0/sales/cancel/S-1" }); expect(JSON.parse(seen[1].body!)).toEqual({ alert_customer: "no" });
  });
  it("classifies: 400/401/403/404/422 rejected; 5xx/429/redirect/timeout/connection loss ambiguous", async () => {
    for (const s of [400, 401, 403, 404, 422]) { reply(s, '{"error":"nope"}'); expect(await gw().recordPayment(PAY), String(s)).toMatchObject({ kind: "rejected" }); }
    for (const s of [429, 500, 502, 503]) { reply(s); expect(await gw().cancelSale({ saleId: "S-1", reference: "r", idempotencyKey: "k" }), String(s)).toMatchObject({ kind: "ambiguous" }); }
    reply(302); expect(await gw().recordPayment(PAY)).toMatchObject({ kind: "ambiguous" });
    handler = () => { /* never answers */ }; expect(await gw({ timeoutMs: 100 }).recordPayment(PAY)).toMatchObject({ kind: "ambiguous" });
    handler = (_q, res) => { res.destroy(); }; expect(await gw().cancelSale({ saleId: "S-1", reference: "r", idempotencyKey: "k" })).toMatchObject({ kind: "ambiguous" });
  });
  it("refuses unusable input BEFORE any request: path-injection sale ids and bad amounts", async () => {
    reply(200);
    for (const saleId of ["../x", "a/b", "S 1", "", "a?b=1", "x".repeat(101)]) { expect(await gw().recordPayment({ ...PAY, saleId })).toMatchObject({ kind: "rejected" }); expect(await gw().cancelSale({ saleId, reference: "r", idempotencyKey: "k" })).toMatchObject({ kind: "rejected" }); }
    for (const amountGhs of ["0", "0.00", "-5", "1.234", "abc", "1e3", ""]) expect(await gw().recordPayment({ ...PAY, amountGhs })).toMatchObject({ kind: "rejected" });
    expect(seen).toEqual([]);
  });
});
