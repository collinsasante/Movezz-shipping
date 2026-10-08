// Phase 7H: operational reliability of the PostgreSQL layer.
//   * Keepup sync state machine, lease, worker, crash recovery        * notification outbox + worker
//   * idempotency ledger integrity                                    * history (audit/status) authority
//   * fail-closed operational writes
// Everything external is a mock (MockKeepupGateway / MockNotificationSender): no network, no real credentials.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { dbDescribe, createTestDb, customer, staffUser, fxRate, packageRates, pricedItem, item, carton, sqlstate, type TestDb } from "./helpers";
import { createInvoice, recordPayment, voidPayment, cancelInvoice } from "../../src/lib/db/invoices";
import { user, withActorTransaction, type ActorAssertion } from "../../src/lib/db/actor";
import { recordAudit, recordStatusEvent } from "../../src/lib/db/audit";
import { DomainError } from "../../src/lib/db/errors";
import { runKeepupWorkerOnce } from "../../src/lib/db/workers/keepup-worker";
import { runOutboxWorkerOnce, MockNotificationSender } from "../../src/lib/db/workers/outbox-worker";
import { MockKeepupGateway } from "../../src/lib/integrations/keepup-gateway";
import { updateCustomerAdmin } from "../../src/lib/db/ownership";
import { resolveKeepupSync, retryKeepupSync, requeueDeadNotification } from "../../src/lib/db/integration-admin";

let kn = 0;
const key = () => `ops-${Date.now()}-${++kn}-abcdefgh`;
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : `RAW:${(e as { code?: string }).code ?? (e as Error).message}`; }
}
const svc: ActorAssertion = { type: "integration" };

interface Env { db: TestDb; admin: string; admin2: string; staff: string; login: string; loginCustomer: string }
async function setup(): Promise<Env> {
  const db = await createTestDb();
  const admin = await staffUser(db.admin, "super_admin"), admin2 = await staffUser(db.admin, "super_admin"), staff = await staffUser(db.admin, "warehouse_staff");
  await packageRates(db.admin); await fxRate(db.admin);
  const loginCustomer = await customer(db.admin);
  const login = (await db.admin.query(`INSERT INTO users (auth_uid, email, role, customer_id) VALUES ('uid-cust-ops','cust-ops@example.invalid','customer',$1) RETURNING id`, [loginCustomer])).rows[0].id as string;
  return { db, admin, admin2, staff, login, loginCustomer };
}
async function mkInvoice(e: Env, usd = "100.00", over: Record<string, unknown> = {}) {
  const c = await customer(e.db.admin); const i = await pricedItem(e.db.admin, c, usd);
  const { invoice } = await createInvoice(e.db.app, { customerId: c, itemIds: [i], actor: user(e.admin), idempotencyKey: key(), ...over });
  return { c, i, invoice };
}
const syncOf = async (e: Env, invoiceId: string) => (await e.db.admin.query("SELECT * FROM keepup_sync WHERE invoice_id=$1", [invoiceId])).rows[0];
const worker = (e: Env, gateway: MockKeepupGateway, over: Partial<Parameters<typeof runKeepupWorkerOnce>[1]> = {}) =>
  runKeepupWorkerOnce(e.db.app, { gateway, owner: "w1", batch: 50, leaseSeconds: 60, callTimeoutMs: 20_000, ...over });
const drain = (e: Env) => e.db.admin.query("UPDATE keepup_sync SET sync_state='cancelled' WHERE sync_state IN ('pending','failed')");
const asAdmin = <T>(e: Env, fn: Parameters<typeof withActorTransaction<T>>[2]) => withActorTransaction(e.db.app, user(e.admin), fn);
const asSvc = <T>(e: Env, fn: Parameters<typeof withActorTransaction<T>>[2]) => withActorTransaction(e.db.app, svc, fn);

// =====================================================================================================================
dbDescribe("Keepup sync state machine and worker (PostgreSQL, mock gateway)", () => {
  let e: Env;
  beforeAll(async () => { e = await setup(); });
  afterAll(async () => { await e?.db.close(); });
  beforeEach(async () => { await drain(e); });

  describe("worker identity and authorization", () => {
    it("only the integration/system identity can claim: staff, super_admin, customer, import and a session with no actor cannot", async () => {
      const sql = "SELECT * FROM movezz_sec.keepup_claim(5, 60, 'x')";
      await mkInvoice(e);
      expect(await code(withActorTransaction(e.db.app, user(e.staff), (tx) => tx.query(sql)))).toBe("NOT_AUTHORIZED");
      expect(await code(asAdmin(e, (tx) => tx.query(sql)))).toBe("NOT_AUTHORIZED");
      expect(await code(withActorTransaction(e.db.app, user(e.login), (tx) => tx.query(sql)))).toBe("NOT_AUTHORIZED");
      expect(await code(withActorTransaction(e.db.app, { type: "import" }, (tx) => tx.query(sql)))).toBe("NOT_AUTHORIZED");
      expect(await sqlstate(e.db.app.query(sql))).toBe("MV012");
      expect(await code(asSvc(e, (tx) => tx.query(sql)))).toBe("OK");
      expect(await code(withActorTransaction(e.db.app, { type: "system" }, (tx) => tx.query("SELECT * FROM movezz_sec.keepup_claim(5, 60, 'sys')")))).toBe("OK");
    });
    it("claim parameters are validated (no unbounded batch, no absurd lease, no unnamed owner)", async () => {
      for (const sql of ["SELECT * FROM movezz_sec.keepup_claim(0, 60, 'x')", "SELECT * FROM movezz_sec.keepup_claim(1000, 60, 'x')", "SELECT * FROM movezz_sec.keepup_claim(5, 1, 'x')",
                         "SELECT * FROM movezz_sec.keepup_claim(5, 60, NULL)", "SELECT * FROM movezz_sec.keepup_claim(5, 60, 'has space')"]) {
        expect(await code(asSvc(e, (tx) => tx.query(sql))), sql).toBe("INVALID_INPUT");
      }
    });
    it("the completion/failure functions are closed to everyone but the worker identity", async () => {
      const { invoice } = await mkInvoice(e);
      const row = await syncOf(e, invoice.id);
      const fake = "00000000-0000-4000-8000-000000000000";
      for (const sql of [`SELECT movezz_sec.keepup_complete('${row.id}', '${fake}', 'KU-1')`, `SELECT movezz_sec.keepup_fail('${row.id}', '${fake}', 'x')`,
                         `SELECT movezz_sec.keepup_ambiguous('${row.id}', '${fake}', 'x')`, "SELECT movezz_sec.keepup_reap_expired(10)"]) {
        expect(await code(asAdmin(e, (tx) => tx.query(sql))), sql).toBe("NOT_AUTHORIZED");
        expect(await code(withActorTransaction(e.db.app, user(e.staff), (tx) => tx.query(sql))), sql).toBe("NOT_AUTHORIZED");
      }
    });
  });

  describe("happy path and bookkeeping", () => {
    it("claims, calls the gateway once, records the sale id on the sync row AND the invoice, and never reports success twice", async () => {
      const { invoice } = await mkInvoice(e, "100.00");
      const gw = new MockKeepupGateway();
      const r = await worker(e, gw);
      expect(r).toMatchObject({ claimed: 1, synced: 1, failed: 0, ambiguous: 0 });
      expect(gw.received).toHaveLength(1);
      expect(gw.received[0]).toMatchObject({ reference: invoice.invoice_ref, idempotencyKey: `invoice:${invoice.id}` });
      const s = await syncOf(e, invoice.id);
      expect(s).toMatchObject({ sync_state: "synced", keepup_sale_id: expect.stringMatching(/^MOCK-\d+$/), attempt_count: 1, lease_token: null, last_error: null });
      expect(s.last_success_at).not.toBeNull();
      expect((await e.db.admin.query("SELECT keepup_sale_id, keepup_link FROM invoices WHERE id=$1", [invoice.id])).rows[0]).toEqual({ keepup_sale_id: s.keepup_sale_id, keepup_link: `https://sandbox.keepup.invalid/s/${s.keepup_sale_id}` });
      // running again is a no-op: a synced row is never claimed
      expect(await worker(e, gw)).toMatchObject({ claimed: 0 });
      expect(gw.received).toHaveLength(1);
      // history: claim and completion are status events attributed to the integration identity
      const ev = (await e.db.admin.query("SELECT old_status, new_status, actor_type FROM status_events WHERE entity_type='keepup_sync' AND entity_id=$1 ORDER BY id", [s.id])).rows;
      expect(ev).toEqual([{ old_status: "pending", new_status: "creating", actor_type: "integration" }, { old_status: "creating", new_status: "synced", actor_type: "integration" }]);
    });
    it("the request sent to Keepup carries the frozen GHS total split exactly across the lines (discount never makes a line negative)", async () => {
      const c = await customer(e.db.admin); const a = await pricedItem(e.db.admin, c, "100.00"); const b = await pricedItem(e.db.admin, c, "50.00");
      const { invoice } = await createInvoice(e.db.app, { customerId: c, itemIds: [a, b], discountUsd: "30.00", discountReason: "promo", actor: user(e.admin), idempotencyKey: key() });
      const gw = new MockKeepupGateway();
      await worker(e, gw);
      const req = gw.received.find((r) => r.reference === invoice.invoice_ref)!;
      const sum = Math.round(req.items.reduce((s, i) => s + i.price * 100, 0));
      expect(sum).toBe(Math.round(Number(invoice.total_ghs) * 100));
      expect(req.items.every((i) => i.price > 0)).toBe(true);
    });
    it("a zero-total invoice is never sent to Keepup (not_required) and a cancelled invoice's pending row is not claimed", async () => {
      const zero = await mkInvoice(e, "100.00", { discountUsd: "100.00", discountReason: "approved waiver" });
      expect((await syncOf(e, zero.invoice.id)).sync_state).toBe("not_required");
      const cancelled = await mkInvoice(e, "80.00");
      await cancelInvoice(e.db.app, { invoiceId: cancelled.invoice.id, reason: "wrong", actor: user(e.admin) });
      const gw = new MockKeepupGateway();
      expect(await worker(e, gw)).toMatchObject({ claimed: 0 });
      expect(gw.received).toHaveLength(0);
      expect((await syncOf(e, cancelled.invoice.id)).sync_state).toBe("cancelled");
    });
  });

  describe("definite rejection: failed, back-off, bounded retries, manual retry", () => {
    it("a rejection fails the row with a future retry time; it is not claimed again until due; the retry then succeeds (attempt_count 2, one sale)", async () => {
      const { invoice } = await mkInvoice(e);
      const gw = new MockKeepupGateway().enqueue({ kind: "rejected", reason: "Keepup rejected the request (HTTP 422)" });
      expect(await worker(e, gw)).toMatchObject({ claimed: 1, failed: 1, synced: 0 });
      let s = await syncOf(e, invoice.id);
      expect(s).toMatchObject({ sync_state: "failed", attempt_count: 1, lease_token: null, keepup_sale_id: null });
      expect(s.last_error).toContain("422");
      expect(new Date(s.next_retry_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
      expect(await worker(e, gw)).toMatchObject({ claimed: 0 });                         // not due yet
      await e.db.admin.query("UPDATE keepup_sync SET next_retry_at = now() - interval '1 second' WHERE invoice_id=$1", [invoice.id]);
      expect(await worker(e, gw)).toMatchObject({ claimed: 1, synced: 1 });
      s = await syncOf(e, invoice.id);
      expect(s).toMatchObject({ sync_state: "synced", attempt_count: 2 });
      expect(gw.received).toHaveLength(2);
    });
    it("retries are bounded; after the last attempt the row waits (no schedule) until a super_admin retries it; staff cannot", async () => {
      const { invoice } = await mkInvoice(e);
      await e.db.admin.query("UPDATE keepup_sync SET max_attempts = 2 WHERE invoice_id=$1", [invoice.id]);
      const gw = new MockKeepupGateway().enqueue({ kind: "rejected", reason: "r1" }, { kind: "rejected", reason: "r2" });
      await worker(e, gw);
      await e.db.admin.query("UPDATE keepup_sync SET next_retry_at = now() - interval '1 second' WHERE invoice_id=$1", [invoice.id]);
      await worker(e, gw);
      const s = await syncOf(e, invoice.id);
      expect(s).toMatchObject({ sync_state: "failed", attempt_count: 2, next_retry_at: null, last_error: "r2" });
      expect(await worker(e, gw)).toMatchObject({ claimed: 0 });
      expect(await code(retryKeepupSync(e.db.app, { syncId: s.id, reason: "fixed customer phone", actor: user(e.staff) }))).toBe("NOT_AUTHORIZED");
      expect(await code(retryKeepupSync(e.db.app, { syncId: s.id, reason: "  ", actor: user(e.admin) }))).toBe("INVALID_INPUT");
      expect(await code(retryKeepupSync(e.db.app, { syncId: s.id, reason: "fixed customer phone", actor: user(e.admin) }))).toBe("OK");
      expect(await syncOf(e, invoice.id)).toMatchObject({ sync_state: "pending", resolved_by: e.admin });
      expect(await worker(e, gw)).toMatchObject({ claimed: 1, synced: 1 });
      expect((await e.db.admin.query("SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY id", [s.id])).rows).toEqual([{ action: "keepup.retry" }]);
    });
    it("a manual retry is refused for a row whose outcome is unknown, and for a pending/synced row", async () => {
      const { invoice } = await mkInvoice(e);
      const s = await syncOf(e, invoice.id);
      expect(await code(retryKeepupSync(e.db.app, { syncId: s.id, reason: "r", actor: user(e.admin) }))).toBe("INVALID_STATE");   // pending
      await worker(e, new MockKeepupGateway().enqueue({ kind: "ambiguous", reason: "timeout" }));
      expect(await code(retryKeepupSync(e.db.app, { syncId: s.id, reason: "r", actor: user(e.admin) }))).toBe("INVALID_STATE");   // needs_reconciliation
    });
  });

  describe("ambiguous outcomes are never retried automatically", () => {
    const ambiguous: [string, ConstructorParameters<typeof Object>[0]][] = [
      ["a timeout / network error reported by the gateway", { kind: "ambiguous", reason: "request failed after it may have been sent: TimeoutError" }],
      ["an exception thrown by the gateway", new Error("socket hang up")],
      ["a success without a sale id", { kind: "created", saleId: "  " }],
    ];
    for (const [name, outcome] of ambiguous) {
      it(`${name}: needs_reconciliation, exactly one external call, never claimed again`, async () => {
        const { invoice } = await mkInvoice(e);
        const gw = new MockKeepupGateway().enqueue(outcome as never);
        const r = await worker(e, gw);
        expect(r).toMatchObject({ claimed: 1, ambiguous: 1, synced: 0, failed: 0 });
        const s = await syncOf(e, invoice.id);
        expect(s).toMatchObject({ sync_state: "needs_reconciliation", keepup_sale_id: null, next_retry_at: null });
        expect(s.last_error).toBeTruthy();
        expect(await worker(e, gw)).toMatchObject({ claimed: 0 });
        expect(await worker(e, gw)).toMatchObject({ claimed: 0 });
        expect(gw.received).toHaveLength(1);                                           // NO duplicate sale attempt
        expect((await e.db.admin.query("SELECT invoice_id FROM keepup_sync WHERE keepup_sale_id IS NOT NULL AND invoice_id=$1", [invoice.id])).rows).toHaveLength(0);
      });
    }
    it("resolution is a super_admin decision with a reason: created (sale id verified) -> synced; not_created -> pending and re-sent once", async () => {
      const a = await mkInvoice(e), b = await mkInvoice(e);
      const gw = new MockKeepupGateway().enqueue({ kind: "ambiguous", reason: "t" }, { kind: "ambiguous", reason: "t" });
      await worker(e, gw);
      const sa = await syncOf(e, a.invoice.id), sb = await syncOf(e, b.invoice.id);
      expect(await code(resolveKeepupSync(e.db.app, { syncId: sa.id, outcome: "created", saleId: "KU-77", reason: "seen in dashboard", actor: user(e.staff) }))).toBe("NOT_AUTHORIZED");
      expect(await code(resolveKeepupSync(e.db.app, { syncId: sa.id, outcome: "created", reason: "seen", actor: user(e.admin) }))).toBe("INVALID_INPUT");       // sale id required
      expect(await code(resolveKeepupSync(e.db.app, { syncId: sa.id, outcome: "created", saleId: "KU-77", reason: " ", actor: user(e.admin) }))).toBe("INVALID_INPUT");
      expect(await code(resolveKeepupSync(e.db.app, { syncId: sa.id, outcome: "created", saleId: "KU-77", reason: "seen in dashboard", actor: user(e.admin) }))).toBe("OK");
      expect(await syncOf(e, a.invoice.id)).toMatchObject({ sync_state: "synced", keepup_sale_id: "KU-77", resolved_by: e.admin, lease_token: null });
      expect((await e.db.admin.query("SELECT keepup_sale_id FROM invoices WHERE id=$1", [a.invoice.id])).rows[0].keepup_sale_id).toBe("KU-77");
      expect(await code(resolveKeepupSync(e.db.app, { syncId: sa.id, outcome: "not_created", reason: "again", actor: user(e.admin) }))).toBe("INVALID_STATE");  // already resolved
      expect(await code(resolveKeepupSync(e.db.app, { syncId: sb.id, outcome: "not_created", reason: "checked Keepup: nothing", actor: user(e.admin2) }))).toBe("OK");
      expect(await worker(e, gw)).toMatchObject({ claimed: 1, synced: 1 });
      expect(gw.received).toHaveLength(3);
      expect((await e.db.admin.query("SELECT action FROM audit_logs WHERE action LIKE 'keepup.%' AND entity_id = ANY($1) ORDER BY id", [[sa.id, sb.id]])).rows.map((r) => r.action)).toEqual(["keepup.resolve", "keepup.resolve"]);
    });
    it("a sale id already attached to another invoice is never attached twice", async () => {
      const a = await mkInvoice(e), b = await mkInvoice(e);
      const gw = new MockKeepupGateway().enqueue({ kind: "created", saleId: "DUP-1" }, { kind: "created", saleId: "DUP-1" });
      const r = await worker(e, gw);
      expect(r.synced).toBe(1);
      expect(r.needsReconciliation).toBe(1);
      const rows = [await syncOf(e, a.invoice.id), await syncOf(e, b.invoice.id)];
      expect(rows.filter((x) => x.sync_state === "synced")).toHaveLength(1);
      const loser = rows.find((x) => x.sync_state !== "synced")!;
      expect(loser).toMatchObject({ sync_state: "needs_reconciliation", keepup_sale_id: null });
      expect(loser.last_error).toContain("already attached");
    });
  });

  describe("lease, stale attempts and crash recovery", () => {
    it("a stale or wrong lease token can never complete, fail or park a row", async () => {
      const { invoice } = await mkInvoice(e);
      const [c] = (await asSvc(e, (tx) => tx.query("SELECT * FROM movezz_sec.keepup_claim(5, 60, 'w-stale')"))).rows.filter((r) => r.invoice_id === invoice.id);
      const wrong = "11111111-1111-4111-8111-111111111111";
      for (const sql of [`SELECT movezz_sec.keepup_complete('${c.id}', '${wrong}', 'KU-X')`, `SELECT movezz_sec.keepup_fail('${c.id}', '${wrong}', 'x')`, `SELECT movezz_sec.keepup_ambiguous('${c.id}', '${wrong}', 'x')`]) {
        expect(await code(asSvc(e, (tx) => tx.query(sql))), sql).toBe("INVALID_STATE");
      }
      expect(await code(asSvc(e, (tx) => tx.query("SELECT movezz_sec.keepup_complete($1, NULL, 'KU-X')", [c.id])))).toBe("INVALID_STATE");
      expect((await syncOf(e, invoice.id)).sync_state).toBe("creating");
      expect(await code(asSvc(e, (tx) => tx.query("SELECT movezz_sec.keepup_complete($1, $2, '')", [c.id, c.lease_token])))).toBe("INVALID_INPUT");
      expect(await code(asSvc(e, (tx) => tx.query("SELECT movezz_sec.keepup_complete($1, $2, 'KU-OK')", [c.id, c.lease_token])))).toBe("OK");
      expect(await code(asSvc(e, (tx) => tx.query("SELECT movezz_sec.keepup_complete($1, $2, 'KU-OK2')", [c.id, c.lease_token])))).toBe("INVALID_STATE");   // no second completion
      expect((await syncOf(e, invoice.id)).keepup_sale_id).toBe("KU-OK");
    });
    it("CRASH before the claim commits: the transaction rolls back and the row is still pending, untouched", async () => {
      const { invoice } = await mkInvoice(e);
      await expect(asSvc(e, async (tx) => { await tx.query("SELECT * FROM movezz_sec.keepup_claim(5, 60, 'crash-1')"); throw new Error("process died"); })).rejects.toThrow("process died");
      expect(await syncOf(e, invoice.id)).toMatchObject({ sync_state: "pending", attempt_count: 0, lease_token: null });
    });
    it("CRASH after the claim committed but before the request was sent: lease expires -> needs_reconciliation (unknown), no automatic re-send", async () => {
      const { invoice } = await mkInvoice(e);
      await asSvc(e, (tx) => tx.query("SELECT * FROM movezz_sec.keepup_claim(5, 60, 'crash-2')"));       // the worker "dies" here
      expect(await syncOf(e, invoice.id)).toMatchObject({ sync_state: "creating", attempt_count: 1, lease_owner: "crash-2" });
      const gw = new MockKeepupGateway();
      expect(await worker(e, gw)).toMatchObject({ reaped: 0, claimed: 0 });                              // lease still valid: another worker must wait
      await e.db.admin.query("UPDATE keepup_sync SET lease_expires_at = now() - interval '1 second' WHERE invoice_id=$1", [invoice.id]);
      expect(await worker(e, gw)).toMatchObject({ reaped: 1, claimed: 0 });
      expect(await syncOf(e, invoice.id)).toMatchObject({ sync_state: "needs_reconciliation", keepup_sale_id: null });
      expect(gw.received).toHaveLength(0);
    });
    it("CRASH after the request was sent but before the outcome was recorded: reconciliation, and the sale is NOT created a second time", async () => {
      const { invoice } = await mkInvoice(e);
      const gw = new MockKeepupGateway();
      // simulate "Keepup accepted the request, the worker process died": claim, call, no record
      const [c] = (await asSvc(e, (tx) => tx.query("SELECT * FROM movezz_sec.keepup_claim(5, 60, 'crash-3')"))).rows.filter((r) => r.invoice_id === invoice.id);
      await gw.createSale({ reference: invoice.invoice_ref, idempotencyKey: c.idempotency_key, items: [] });
      await e.db.admin.query("UPDATE keepup_sync SET lease_expires_at = now() - interval '1 second' WHERE invoice_id=$1", [invoice.id]);
      expect(await worker(e, gw)).toMatchObject({ reaped: 1, claimed: 0 });
      expect(await worker(e, gw)).toMatchObject({ claimed: 0 });
      expect(gw.received).toHaveLength(1);                                                                  // one sale in "Keepup", none re-sent
      expect((await syncOf(e, invoice.id)).sync_state).toBe("needs_reconciliation");
    });
    it("the outcome cannot be recorded (database error after the call): the row stays 'creating' and is reaped, never reported as success", async () => {
      const { invoice } = await mkInvoice(e);
      const gw = new MockKeepupGateway().enqueue(async () => {
        await e.db.admin.query("UPDATE keepup_sync SET lease_token = gen_random_uuid() WHERE invoice_id=$1", [invoice.id]);   // the lease is lost while the call is in flight
        return { kind: "created", saleId: "KU-LOST" };
      });
      const r = await worker(e, gw);
      expect(r).toMatchObject({ claimed: 1, synced: 0, needsReconciliation: 1 });
      expect(await syncOf(e, invoice.id)).toMatchObject({ sync_state: "creating", keepup_sale_id: null });
      await e.db.admin.query("UPDATE keepup_sync SET lease_expires_at = now() - interval '1 second' WHERE invoice_id=$1", [invoice.id]);
      await worker(e, gw);
      expect(await syncOf(e, invoice.id)).toMatchObject({ sync_state: "needs_reconciliation", keepup_sale_id: null });
    });
    it("a LATE success from the same attempt (lease reaped meanwhile) is recorded - the worker holds the real response", async () => {
      const { invoice } = await mkInvoice(e);
      const gw = new MockKeepupGateway().enqueue(async () => {
        await e.db.admin.query("UPDATE keepup_sync SET lease_expires_at = now() - interval '1 second' WHERE invoice_id=$1", [invoice.id]);
        await asSvc(e, (tx) => tx.query("SELECT movezz_sec.keepup_reap_expired(10)"));
        expect((await syncOf(e, invoice.id)).sync_state).toBe("needs_reconciliation");
        return { kind: "created", saleId: "KU-LATE" };
      });
      expect(await worker(e, gw)).toMatchObject({ synced: 1 });
      expect(await syncOf(e, invoice.id)).toMatchObject({ sync_state: "synced", keepup_sale_id: "KU-LATE" });
    });
    it("a late result after an operator resolved the row is rejected; and 'not_created' cannot be asserted while the original call may be in flight", async () => {
      const { invoice } = await mkInvoice(e);
      let blocked = "";
      const gw = new MockKeepupGateway().enqueue(async () => {
        await e.db.admin.query("UPDATE keepup_sync SET lease_expires_at = now() - interval '1 second' WHERE invoice_id=$1", [invoice.id]);
        await asSvc(e, (tx) => tx.query("SELECT movezz_sec.keepup_reap_expired(10)"));
        const id = (await syncOf(e, invoice.id)).id;
        blocked = await code(resolveKeepupSync(e.db.app, { syncId: id, outcome: "not_created", reason: "looked", actor: user(e.admin) }));   // inside the grace period
        await e.db.admin.query("UPDATE keepup_sync SET lease_expires_at = now() - interval '10 minutes' WHERE invoice_id=$1", [invoice.id]);
        await resolveKeepupSync(e.db.app, { syncId: id, outcome: "cancelled", reason: "customer withdrew", actor: user(e.admin) });
        return { kind: "created", saleId: "KU-TOO-LATE" };
      });
      expect(await worker(e, gw)).toMatchObject({ synced: 0 });
      expect(blocked).toBe("INVALID_STATE");
      expect(await syncOf(e, invoice.id)).toMatchObject({ sync_state: "cancelled", keepup_sale_id: null });
    });
    it("cancellation while the request is in flight: the late sale is kept as evidence in needs_reconciliation - never 'synced' for a cancelled invoice", async () => {
      const { invoice } = await mkInvoice(e);
      const gw = new MockKeepupGateway().enqueue(async () => {
        await cancelInvoice(e.db.app, { invoiceId: invoice.id, reason: "customer cancelled", actor: user(e.admin) });
        return { kind: "created", saleId: "KU-AFTER-CANCEL" };
      });
      expect(await worker(e, gw)).toMatchObject({ synced: 0, needsReconciliation: 1 });
      const s = await syncOf(e, invoice.id);
      expect(s).toMatchObject({ sync_state: "needs_reconciliation", keepup_sale_id: "KU-AFTER-CANCEL" });
      expect(s.last_error).toContain("cancel it in Keepup manually");
      expect((await e.db.admin.query("SELECT status, keepup_sale_id FROM invoices WHERE id=$1", [invoice.id])).rows[0]).toEqual({ status: "Cancelled", keepup_sale_id: null });
      // 'created' cannot be resolved for a cancelled invoice; the operator cancels it in Keepup, then records that
      expect(await code(resolveKeepupSync(e.db.app, { syncId: s.id, outcome: "created", saleId: "KU-AFTER-CANCEL", reason: "x", actor: user(e.admin) }))).toBe("INVALID_STATE");
      expect(await code(resolveKeepupSync(e.db.app, { syncId: s.id, outcome: "cancelled", reason: "cancelled in the Keepup dashboard", actor: user(e.admin) }))).toBe("OK");
      expect((await syncOf(e, invoice.id)).sync_state).toBe("cancelled");
    });
    it("a request that cannot be built (no request was sent) is a definite, retryable failure - not an unknown outcome", async () => {
      const { invoice } = await mkInvoice(e);
      const gw = new MockKeepupGateway();
      const r = await worker(e, gw, { buildRequest: async () => { throw new Error("invoice has no lines"); } });
      expect(r).toMatchObject({ claimed: 1, failed: 1, ambiguous: 0 });
      expect(gw.received).toHaveLength(0);
      const s = await syncOf(e, invoice.id);
      expect(s).toMatchObject({ sync_state: "failed", lease_token: null, attempt_count: 1 });
      expect(s.last_error).toContain("could not build the request");
      expect(s.next_retry_at).not.toBeNull();
    });
  });

  describe("state-machine integrity against direct SQL (even from a super_admin or the worker identity)", () => {
    it("cannot fake success, skip states, rewrite attempts/lease/sale id, or re-open a reconciled row", async () => {
      const { invoice } = await mkInvoice(e);
      const id = (await syncOf(e, invoice.id)).id;
      const attempt = async (sql: string, as: "admin" | "svc" = "admin") => code((as === "admin" ? asAdmin : asSvc)(e, (tx) => tx.query(sql, [id])));
      expect(await attempt("UPDATE keepup_sync SET sync_state='synced', keepup_sale_id='KU-FAKE' WHERE id=$1")).toBe("IMMUTABLE_RECORD");        // sale id is function-managed
      expect(await attempt("UPDATE keepup_sync SET sync_state='synced' WHERE id=$1")).toBe("INVALID_STATE");                                  // pending -> synced
      expect(await attempt("UPDATE keepup_sync SET sync_state='synced', keepup_sale_id='KU-FAKE' WHERE id=$1", "svc")).toBe("IMMUTABLE_RECORD");
      expect(await attempt("UPDATE keepup_sync SET sync_state='creating' WHERE id=$1", "svc")).toBe("INVALID_STATE");                          // only keepup_claim may start an attempt
      expect(await attempt("UPDATE keepup_sync SET keepup_sale_id='KU-FAKE' WHERE id=$1")).toBe("IMMUTABLE_RECORD");
      expect(await attempt("UPDATE keepup_sync SET attempt_count=7 WHERE id=$1")).toBe("IMMUTABLE_RECORD");
      expect(await attempt("UPDATE keepup_sync SET max_attempts=20 WHERE id=$1")).toBe("IMMUTABLE_RECORD");
      expect(await attempt("UPDATE keepup_sync SET lease_token=gen_random_uuid() WHERE id=$1", "svc")).toBe("IMMUTABLE_RECORD");
      expect(await attempt("UPDATE keepup_sync SET idempotency_key='other-key-123' WHERE id=$1")).toBe("IMMUTABLE_RECORD");
      expect(await attempt("UPDATE keepup_sync SET last_success_at=now() WHERE id=$1")).toBe("IMMUTABLE_RECORD");
      expect(await attempt("UPDATE keepup_sync SET resolved_by=NULL, resolution_note='x' WHERE id=$1")).toBe("OK");  // descriptive column: allowed (resolved_by unchanged)
      // flag uncertainty is allowed; but a reconciled row cannot be pushed back by a plain UPDATE
      expect(await attempt("UPDATE keepup_sync SET sync_state='needs_reconciliation', last_error='checked by hand' WHERE id=$1")).toBe("OK");
      expect(await attempt("UPDATE keepup_sync SET sync_state='pending' WHERE id=$1")).toBe("INVALID_STATE");
      expect(await attempt("UPDATE keepup_sync SET sync_state='synced' WHERE id=$1")).toBe("INVALID_STATE");
      expect(await attempt("UPDATE keepup_sync SET sync_state='failed' WHERE id=$1", "svc")).toBe("INVALID_STATE");
      expect((await syncOf(e, invoice.id)).sync_state).toBe("needs_reconciliation");
    });
    it("a new sync row cannot be created already synced / with attempts / with a sale id, and a payment-less row for a payment kind is rejected", async () => {
      const { invoice } = await mkInvoice(e);
      const other = await mkInvoice(e);
      await e.db.admin.query("DELETE FROM keepup_sync WHERE invoice_id=$1", [other.invoice.id]).catch(() => {});   // (operator housekeeping in the test only)
      for (const cols of ["sync_state, keepup_sale_id", "attempt_count", "sync_state"] as const) {
        const vals = cols === "sync_state, keepup_sale_id" ? "'synced','KU-1'" : cols === "attempt_count" ? "3" : "'creating'";
        expect(await code(asAdmin(e, (tx) => tx.query(`INSERT INTO keepup_sync (kind, invoice_id, idempotency_key, ${cols}) VALUES ('invoice', $1, $2, ${vals})`, [other.invoice.id, `bad-${key()}`]))), cols).toBe("INVALID_STATE");
      }
      expect(invoice.id).not.toBe(other.invoice.id);
    });
    it("the database refuses 'synced' without a sale id even for the table owner", async () => {
      const { invoice } = await mkInvoice(e);
      expect(await sqlstate(e.db.admin.query("UPDATE keepup_sync SET sync_state='synced' WHERE invoice_id=$1", [invoice.id]))).toBe("23514");
    });
  });

  describe("several workers at once", () => {
    it("5 workers race over 25 invoices: every invoice is sent to Keepup exactly once and ends synced", async () => {
      const invs = [];
      for (let i = 0; i < 25; i++) invs.push((await mkInvoice(e, "10.00")).invoice);
      const gw = new MockKeepupGateway();
      const results = await Promise.all(Array.from({ length: 5 }, (_, n) => worker(e, gw, { owner: `race-${n}`, batch: 10 })));
      for (let pass = 0; pass < 3; pass++) await Promise.all(Array.from({ length: 5 }, (_, n) => worker(e, gw, { owner: `race-${n}`, batch: 10 })));
      expect(results.reduce((s, r) => s + r.claimed, 0)).toBeLessThanOrEqual(25);
      const refs = gw.received.map((r) => r.reference);
      expect(new Set(refs).size).toBe(refs.length);                                                       // no invoice sent twice
      expect(refs.sort()).toEqual(invs.map((i) => i.invoice_ref).sort());
      expect((await e.db.admin.query("SELECT count(*)::int AS n FROM keepup_sync WHERE sync_state='synced' AND invoice_id = ANY($1)", [invs.map((i) => i.id)])).rows[0].n).toBe(25);
      expect((await e.db.admin.query("SELECT count(DISTINCT keepup_sale_id)::int AS n FROM keepup_sync WHERE invoice_id = ANY($1)", [invs.map((i) => i.id)])).rows[0].n).toBe(25);
    });
    it("raw concurrent claims never hand the same row to two workers", async () => {
      for (let i = 0; i < 12; i++) await mkInvoice(e, "10.00");
      const claims = await Promise.all(Array.from({ length: 6 }, (_, n) => asSvc(e, (tx) => tx.query("SELECT id FROM movezz_sec.keepup_claim(4, 60, $1)", [`c${n}`]))));
      const ids = claims.flatMap((c) => c.rows.map((r) => r.id as string));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(12);
    });
    it("cancel racing a claim: the invoice ends cancelled and a Keepup sale is never reported as 'synced' for it (20 random races)", async () => {
      for (let n = 0; n < 20; n++) {
        const { invoice } = await mkInvoice(e, "10.00");
        const gw = new MockKeepupGateway();
        const jobs = [cancelInvoice(e.db.app, { invoiceId: invoice.id, reason: "race", actor: user(e.admin) }), worker(e, gw, { owner: `r${n}` })];
        if (n % 2) jobs.reverse();
        await Promise.all(jobs);
        const s = await syncOf(e, invoice.id);
        expect(["cancelled", "needs_reconciliation"]).toContain(s.sync_state);
        expect(s.sync_state).not.toBe("synced");
        expect((await e.db.admin.query("SELECT status FROM invoices WHERE id=$1", [invoice.id])).rows[0].status).toBe("Cancelled");
      }
    });
  });
});

// =====================================================================================================================
dbDescribe("notification outbox and worker (PostgreSQL, mock sender)", () => {
  let e: Env;
  beforeAll(async () => { e = await setup(); });
  afterAll(async () => { await e?.db.close(); });
  beforeEach(async () => { await e.db.admin.query("UPDATE notification_outbox SET status='cancelled' WHERE status IN ('pending','failed')"); });
  const enqueue = (to = "a@example.invalid", dedupe: string | null = key(), actor: ActorAssertion = user(e.admin)) =>
    withActorTransaction(e.db.app, actor, async (tx) => (await tx.query("INSERT INTO notification_outbox (event_type, channel, recipient, payload, dedupe_key) VALUES ('t.event','email',$1,'{\"n\":1}',$2) RETURNING id", [to, dedupe])).rows[0].id as string);
  const ow = (sender: MockNotificationSender, over: Partial<Parameters<typeof runOutboxWorkerOnce>[1]> = {}) => runOutboxWorkerOnce(e.db.app, { sender, owner: "o1", batch: 50, leaseSeconds: 60, sendTimeoutMs: 20_000, ...over });
  const row = async (id: string) => (await e.db.admin.query("SELECT * FROM notification_outbox WHERE id=$1", [id])).rows[0];

  it("enqueue is transactional with the business change: a failed invoice leaves no outbox row, a successful one exactly one (de-duplicated)", async () => {
    const before = (await e.db.admin.query("SELECT count(*)::int AS n FROM notification_outbox")).rows[0].n;
    const c = await customer(e.db.admin); const i = await pricedItem(e.db.admin, c, "10.00");
    await expect(createInvoice(e.db.app, { customerId: c, itemIds: [i], discountUsd: "999.00", discountReason: "too big", actor: user(e.admin), idempotencyKey: key() })).rejects.toBeInstanceOf(DomainError);
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM notification_outbox")).rows[0].n).toBe(before);
    const { invoice } = await createInvoice(e.db.app, { customerId: c, itemIds: [i], actor: user(e.admin), idempotencyKey: key() });
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE dedupe_key=$1", [`invoice.created:${invoice.id}`])).rows[0].n).toBe(1);
  });
  it("direct writes are limited to enqueue: no actor, a customer, a forged status/attempt count, update and delete are all refused", async () => {
    const ins = "INSERT INTO notification_outbox (event_type, channel, recipient, payload, dedupe_key) VALUES ('t','email','z@example.invalid','{}',$1)";
    expect(await sqlstate(e.db.app.query(ins, [key()]))).toBe("MV007");                                                        // no verified actor
    expect(await code(withActorTransaction(e.db.app, user(e.login), (tx) => tx.query(ins, [key()])))).toBe("NOT_AUTHORIZED");
    expect(await code(withActorTransaction(e.db.app, user(e.staff), (tx) => tx.query(ins, [key()])))).toBe("OK");              // staff may enqueue
    for (const bad of ["status, attempts", "status", "attempts"]) {
      const v = bad === "status, attempts" ? "'sent', 5" : bad === "status" ? "'sending'" : "9";
      expect(await code(asAdmin(e, (tx) => tx.query(`INSERT INTO notification_outbox (event_type, channel, recipient, ${bad}) VALUES ('t','email','z@example.invalid', ${v})`))), bad).toMatch(/INVALID_STATE|INTEGRITY/);
    }
    expect(await code(asAdmin(e, (tx) => tx.query("INSERT INTO notification_outbox (event_type, channel, recipient) VALUES ('t','email','not-an-address')")))).toBe("INVALID_INPUT");
    expect(await code(asAdmin(e, (tx) => tx.query("INSERT INTO notification_outbox (event_type, channel, recipient, payload) VALUES ('t','email','a@b.invalid',$1::jsonb)", [JSON.stringify({ x: "y".repeat(20000) })])))).toBe("INVALID_INPUT");
    const id = await enqueue();
    for (const sql of ["UPDATE notification_outbox SET status='sent', sent_at=now() WHERE id=$1", "UPDATE notification_outbox SET recipient='evil@example.invalid' WHERE id=$1",
                       "UPDATE notification_outbox SET attempts=0, status='pending' WHERE id=$1", "UPDATE notification_outbox SET payload='{}' WHERE id=$1"]) {
      expect(await code(asAdmin(e, (tx) => tx.query(sql, [id]))), sql).toBe("IMMUTABLE_RECORD");
    }
    expect(await sqlstate(e.db.app.query("DELETE FROM notification_outbox WHERE id=$1", [id]))).toBe("42501");
    // cancelling something not yet sent is allowed (admin), and only that
    expect(await code(asAdmin(e, (tx) => tx.query("UPDATE notification_outbox SET status='cancelled' WHERE id=$1", [id])))).toBe("OK");
    expect(await code(withActorTransaction(e.db.app, user(e.staff), (tx) => tx.query("UPDATE notification_outbox SET status='cancelled' WHERE id=$1", [id])))).toBe("IMMUTABLE_RECORD");
  });
  it("only the worker identity can claim, complete, fail or reap", async () => {
    const id = await enqueue();
    for (const sql of ["SELECT * FROM movezz_sec.outbox_claim(5, 60, 'x')", "SELECT movezz_sec.outbox_reap_expired(5)",
                       `SELECT movezz_sec.outbox_complete('${id}', gen_random_uuid())`, `SELECT movezz_sec.outbox_fail('${id}', gen_random_uuid(), 'x')`]) {
      expect(await code(asAdmin(e, (tx) => tx.query(sql))), sql).toBe("NOT_AUTHORIZED");
      expect(await code(withActorTransaction(e.db.app, user(e.login), (tx) => tx.query(sql))), sql).toBe("NOT_AUTHORIZED");
      expect(await sqlstate(e.db.app.query(sql)), sql).toBe("MV012");
    }
  });
  it("sends once, records sent_at and the provider reference, and never re-sends", async () => {
    const id = await enqueue();
    const s = new MockNotificationSender();
    expect(await ow(s)).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 1, last_error: null, provider_ref: "mock-1" });
    expect((await row(id)).sent_at).not.toBeNull();
    expect(await ow(s)).toMatchObject({ claimed: 0 });
    expect(s.accepted).toHaveLength(1);
    expect(s.accepted[0]).toMatchObject({ id, recipient: "a@example.invalid", idempotencyKey: `outbox:${id}`, attempt: 1 });
  });
  it("transient failure -> retry with back-off -> success; permanent failure -> dead letter; retries exhausted -> dead letter", async () => {
    const t = await enqueue(), p = await enqueue("p@example.invalid"), x = await enqueue("x@example.invalid");
    await e.db.admin.query("UPDATE notification_outbox SET max_attempts = 2 WHERE id = $1", [x]);
    const s = new MockNotificationSender().enqueue({ kind: "retry", reason: "HTTP 503" }, { kind: "permanent", reason: "invalid address" }, { kind: "retry", reason: "HTTP 503 again" });
    expect(await ow(s)).toMatchObject({ claimed: 3, retried: 2, dead: 1 });
    expect(await row(t)).toMatchObject({ status: "failed", attempts: 1, last_error: "HTTP 503" });
    expect(new Date((await row(t)).next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await row(p)).toMatchObject({ status: "dead", last_error: "invalid address" });
    expect(await ow(s)).toMatchObject({ claimed: 0 });                                                                          // nothing due yet
    await e.db.admin.query("UPDATE notification_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = ANY($1)", [[t, x]]);
    s.enqueue((m) => (m.recipient === "x@example.invalid" ? { kind: "retry", reason: "HTTP 503 again" } : { kind: "sent", providerRef: "ok" }),
              (m) => (m.recipient === "x@example.invalid" ? { kind: "retry", reason: "HTTP 503 again" } : { kind: "sent", providerRef: "ok" }));
    expect(await ow(s)).toMatchObject({ claimed: 2, sent: 1, dead: 1 });                                                         // t succeeds; x exhausted (2/2)
    expect(await row(t)).toMatchObject({ status: "sent", attempts: 2 });
    expect(await row(x)).toMatchObject({ status: "dead", attempts: 2 });
    expect(await ow(s)).toMatchObject({ claimed: 0 });
  });
  it("a dead notification is requeued only by a super_admin, with a reason, and is audited", async () => {
    const id = await enqueue("d@example.invalid");
    await ow(new MockNotificationSender().enqueue({ kind: "permanent", reason: "bounced" }));
    expect(await code(requeueDeadNotification(e.db.app, { outboxId: id, reason: "address fixed", actor: user(e.staff) }))).toBe("NOT_AUTHORIZED");
    expect(await code(requeueDeadNotification(e.db.app, { outboxId: id, reason: " ", actor: user(e.admin) }))).toBe("INVALID_INPUT");
    expect(await code(requeueDeadNotification(e.db.app, { outboxId: id, reason: "address fixed", actor: user(e.admin) }))).toBe("OK");
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 0, last_error: null });
    expect(await code(requeueDeadNotification(e.db.app, { outboxId: id, reason: "again", actor: user(e.admin) }))).toBe("INVALID_STATE");
    expect(await ow(new MockNotificationSender())).toMatchObject({ sent: 1 });
    expect((await e.db.admin.query("SELECT action FROM audit_logs WHERE entity_id=$1", [id])).rows).toEqual([{ action: "notification.requeue" }]);
  });
  it("CRASH after claim: the lease expires, the reaper schedules a retry (at-least-once); a stale token cannot complete the new attempt", async () => {
    const id = await enqueue("c@example.invalid");
    const [claim] = (await asSvc(e, (tx) => tx.query("SELECT * FROM movezz_sec.outbox_claim(50, 60, 'dead-worker')"))).rows.filter((r) => r.id === id);
    expect(await row(id)).toMatchObject({ status: "sending", attempts: 1 });
    const s = new MockNotificationSender();
    expect(await ow(s)).toMatchObject({ claimed: 0, reaped: 0 });                                                                // lease valid
    await e.db.admin.query("UPDATE notification_outbox SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [id]);
    expect(await ow(s)).toMatchObject({ reaped: 1, claimed: 1, sent: 1 });                                                       // reaped -> failed -> due -> sent by the new worker
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2 });
    expect(await code(asSvc(e, (tx) => tx.query("SELECT movezz_sec.outbox_complete($1, $2, 'late')", [id, claim.lease_token])))).toBe("INVALID_STATE");   // old attempt lost
    expect(s.accepted).toHaveLength(1);
  });
  it("CRASH after the provider accepted but before 'sent' was recorded: retried with the SAME idempotency key (the provider can de-duplicate)", async () => {
    const id = await enqueue("dup@example.invalid");
    const s = new MockNotificationSender();
    const [claim] = (await asSvc(e, (tx) => tx.query("SELECT * FROM movezz_sec.outbox_claim(50, 60, 'dies-after-send')"))).rows.filter((r) => r.id === id);
    await s.send({ id, eventType: "t.event", channel: "email", recipient: "dup@example.invalid", payload: {}, attempt: 1, idempotencyKey: `outbox:${id}` });   // accepted, then the process dies
    await e.db.admin.query("UPDATE notification_outbox SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [id]);
    await ow(s);
    expect(s.accepted).toHaveLength(2);                                                                                          // documented at-least-once duplicate ...
    expect(new Set(s.accepted.map((m) => m.idempotencyKey)).size).toBe(1);                                                       // ... carrying one idempotency key
    expect(claim.id).toBe(id);
  });
  it("a late success after the lease was reaped is accepted (no needless duplicate)", async () => {
    const id = await enqueue("late@example.invalid");
    const [claim] = (await asSvc(e, (tx) => tx.query("SELECT * FROM movezz_sec.outbox_claim(50, 60, 'slow')"))).rows.filter((r) => r.id === id);
    await e.db.admin.query("UPDATE notification_outbox SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [id]);
    await asSvc(e, (tx) => tx.query("SELECT movezz_sec.outbox_reap_expired(10)"));
    expect((await row(id)).status).toBe("failed");
    expect(await code(asSvc(e, (tx) => tx.query("SELECT movezz_sec.outbox_complete($1, $2, 'p-1')", [id, claim.lease_token])))).toBe("OK");
    expect(await row(id)).toMatchObject({ status: "sent", provider_ref: "p-1" });
    expect(await ow(new MockNotificationSender())).toMatchObject({ claimed: 0 });
  });
  it("a sender that throws is a retryable failure, never a lost message or a crash of the worker", async () => {
    const id = await enqueue("thr@example.invalid");
    const s = new MockNotificationSender().enqueue(new Error("ECONNRESET"));
    expect(await ow(s)).toMatchObject({ claimed: 1, retried: 1 });
    expect(await row(id)).toMatchObject({ status: "failed", last_error: "sender error: ECONNRESET" });
  });
  it("4 workers race over 40 messages: each message is handed to the provider exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await enqueue(`r${i}@example.invalid`));
    const s = new MockNotificationSender();
    await Promise.all(Array.from({ length: 4 }, (_, n) => ow(s, { owner: `ow${n}`, batch: 12 })));
    for (let pass = 0; pass < 3; pass++) await Promise.all(Array.from({ length: 4 }, (_, n) => ow(s, { owner: `ow${n}`, batch: 12 })));
    const sentIds = s.accepted.map((m) => m.id);
    expect(new Set(sentIds).size).toBe(sentIds.length);
    expect(sentIds.sort()).toEqual([...ids].sort());
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE id = ANY($1) AND status='sent'", [ids])).rows[0].n).toBe(40);
  });
  it("duplicate prevention: the same dedupe key cannot be enqueued twice, even concurrently", async () => {
    const k = key();
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => enqueue("same@example.invalid", k)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE dedupe_key=$1", [k])).rows[0].n).toBe(1);
  });
});

// =====================================================================================================================
dbDescribe("idempotency ledger (PostgreSQL)", () => {
  let e: Env;
  beforeAll(async () => { e = await setup(); });
  afterAll(async () => { await e?.db.close(); });

  it("a recorded result cannot be rewritten, re-pointed, re-hashed, expired early or deleted by the application role", async () => {
    const { invoice } = await mkInvoice(e);
    const k = (await e.db.admin.query("SELECT id, key FROM idempotency_keys WHERE result_entity_id=$1", [invoice.id])).rows[0];
    const other = await mkInvoice(e);
    for (const sql of ["UPDATE idempotency_keys SET result_entity_id=$2 WHERE id=$1", "UPDATE idempotency_keys SET request_hash='x' WHERE id=$1", "UPDATE idempotency_keys SET status='in_progress' WHERE id=$1",
                       "UPDATE idempotency_keys SET response='{}' WHERE id=$1", "UPDATE idempotency_keys SET expires_at=now() WHERE id=$1", "UPDATE idempotency_keys SET key='zzzzzzzzzz' WHERE id=$1"]) {
      expect(await code(asAdmin(e, (tx) => tx.query(sql, sql.includes("$2") ? [k.id, other.invoice.id] : [k.id]))), sql).toBe("IMMUTABLE_RECORD");
    }
    expect(await sqlstate(e.db.app.query("DELETE FROM idempotency_keys WHERE id=$1", [k.id]))).toBe("42501");
    expect((await e.db.admin.query("SELECT result_entity_id FROM idempotency_keys WHERE id=$1", [k.id])).rows[0].result_entity_id).toBe(invoice.id);
  });
  it("another actor reusing a payment key cannot create a second payment or learn the first result", async () => {
    const { invoice } = await mkInvoice(e, "100.00");
    const k = key();
    await recordPayment(e.db.app, { invoiceId: invoice.id, amountGhs: "10.00", actor: user(e.admin), idempotencyKey: k });
    const dup = await code(recordPayment(e.db.app, { invoiceId: invoice.id, amountGhs: "10.00", actor: user(e.admin2), idempotencyKey: k }));
    expect(dup).toBe("DUPLICATE");
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoice.id])).rows[0].n).toBe(1);
  });
  it("voidPayment: without a key a repeat is INVALID_STATE; with a key the repeat replays (one status event, one audit), a different request conflicts", async () => {
    const { invoice } = await mkInvoice(e, "100.00");
    const p1 = await recordPayment(e.db.app, { invoiceId: invoice.id, amountGhs: "40.00", actor: user(e.admin), idempotencyKey: key() });
    const k = key();
    const first = await voidPayment(e.db.app, { paymentId: p1.payment.id, reason: "wrong amount", actor: user(e.admin), idempotencyKey: k });
    expect((first as { replayed?: boolean }).replayed).toBe(false);
    const again = await voidPayment(e.db.app, { paymentId: p1.payment.id, reason: "wrong amount", actor: user(e.admin), idempotencyKey: k });
    expect((again as { replayed?: boolean }).replayed).toBe(true);
    expect(await code(voidPayment(e.db.app, { paymentId: p1.payment.id, reason: "a different reason", actor: user(e.admin), idempotencyKey: k }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await code(voidPayment(e.db.app, { paymentId: p1.payment.id, reason: "wrong amount", actor: user(e.admin) }))).toBe("INVALID_STATE");
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='payment.void' AND entity_id=$1", [p1.payment.id])).rows[0].n).toBe(1);
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM status_events WHERE entity_type='payment' AND entity_id=$1 AND new_status='voided'", [p1.payment.id])).rows[0].n).toBe(1);
  });
  it("12 parallel voids with the same key void once; 12 parallel voids WITHOUT a key void once (state guard)", async () => {
    const { invoice } = await mkInvoice(e, "100.00");
    const p = await recordPayment(e.db.app, { invoiceId: invoice.id, amountGhs: "25.00", actor: user(e.admin), idempotencyKey: key() });
    const k = key();
    const a = await Promise.allSettled(Array.from({ length: 12 }, () => voidPayment(e.db.app, { paymentId: p.payment.id, reason: "dup", actor: user(e.admin), idempotencyKey: k })));
    expect(a.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM status_events WHERE entity_type='payment' AND entity_id=$1 AND new_status='voided'", [p.payment.id])).rows[0].n).toBe(1);
    const q = await recordPayment(e.db.app, { invoiceId: invoice.id, amountGhs: "25.00", actor: user(e.admin), idempotencyKey: key() });
    const b = await Promise.allSettled(Array.from({ length: 12 }, () => voidPayment(e.db.app, { paymentId: q.payment.id, reason: "dup", actor: user(e.admin) })));
    expect(b.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("a failed operation does not leave a key behind, so the client can retry with the same key (transaction boundary)", async () => {
    const c = await customer(e.db.admin); const i = await pricedItem(e.db.admin, c, "10.00");
    const k = key();
    expect(await code(createInvoice(e.db.app, { customerId: c, itemIds: [i], discountUsd: "99.00", discountReason: "too much", actor: user(e.admin), idempotencyKey: k }))).toBe("DISCOUNT_INVALID");
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1", [k])).rows[0].n).toBe(0);
    expect(await code(createInvoice(e.db.app, { customerId: c, itemIds: [i], actor: user(e.admin), idempotencyKey: k }))).toBe("OK");
  });
});

// =====================================================================================================================
dbDescribe("history authority and fail-closed operational writes (PostgreSQL)", () => {
  let e: Env; let inv: { id: string };
  beforeAll(async () => { e = await setup(); inv = (await mkInvoice(e)).invoice; });
  afterAll(async () => { await e?.db.close(); });
  const audits = async (action: string) => (await e.db.admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE action=$1", [action])).rows[0].n as number;

  it("a customer cannot forge audit history; it may record only its own profile update", async () => {
    for (const action of ["invoice.cancel", "payment.void", "user.role_change", "keepup.resolve", "invoice.discount"]) {
      expect(await code(withActorTransaction(e.db.app, user(e.login), (tx) => recordAudit(tx, { action, entityType: "invoice", entityId: inv.id }))), action).toBe("NOT_AUTHORIZED");
      expect(await audits(action), action).toBe(0);
    }
    expect(await code(withActorTransaction(e.db.app, user(e.login), (tx) => recordAudit(tx, { action: "customer.update_self", entityType: "customer", entityId: inv.id })))).toBe("NOT_AUTHORIZED");   // not their customer
    expect(await code(withActorTransaction(e.db.app, user(e.login), (tx) => recordAudit(tx, { action: "customer.update_self", entityType: "customer", entityId: e.loginCustomer })))).toBe("OK");
    expect(await code(withActorTransaction(e.db.app, user(e.login), (tx) => recordStatusEvent(tx, { entityType: "invoice", entityId: inv.id, from: "Pending", to: "Paid" })))).toBe("NOT_AUTHORIZED");
    expect((await e.db.admin.query("SELECT count(*)::int AS n FROM status_events WHERE entity_type='invoice' AND entity_id=$1 AND new_status='Paid'", [inv.id])).rows[0].n).toBe(0);
  });
  it("warehouse staff cannot record financial, user or Keepup history, or an invoice/payment status change", async () => {
    for (const [action, entityType] of [["invoice.cancel", "invoice"], ["payment.void", "payment"], ["user.create", "user"], ["keepup.resolve", "keepup_sync"], ["registration.approve", "registration_request"], ["invoice.create", "item"]]) {
      expect(await code(withActorTransaction(e.db.app, user(e.staff), (tx) => recordAudit(tx, { action, entityType, entityId: inv.id }))), action).toBe("NOT_AUTHORIZED");
    }
    for (const entityType of ["invoice", "payment", "user", "keepup_sync", "customer"]) {
      expect(await code(withActorTransaction(e.db.app, user(e.staff), (tx) => recordStatusEvent(tx, { entityType, entityId: inv.id, from: null, to: "x" }))), entityType).toBe("NOT_AUTHORIZED");
    }
    const i = await item(e.db.admin, await customer(e.db.admin));
    expect(await code(withActorTransaction(e.db.app, user(e.staff), async (tx) => {
      await recordAudit(tx, { action: "item.price", entityType: "item", entityId: i });
      await recordStatusEvent(tx, { entityType: "item", entityId: i, from: null, to: "Arrived at Transit Warehouse" });
    }))).toBe("OK");
  });
  it("the integration identity can record only keepup/notification history", async () => {
    expect(await code(withActorTransaction(e.db.app, svc, (tx) => recordAudit(tx, { action: "invoice.cancel", entityType: "invoice", entityId: inv.id })))).toBe("NOT_AUTHORIZED");
    expect(await code(withActorTransaction(e.db.app, svc, (tx) => recordAudit(tx, { action: "user.create", entityType: "user", entityId: inv.id })))).toBe("NOT_AUTHORIZED");
    expect(await code(withActorTransaction(e.db.app, svc, (tx) => recordStatusEvent(tx, { entityType: "payment", entityId: inv.id, from: null, to: "voided" })))).toBe("NOT_AUTHORIZED");
    expect(await code(withActorTransaction(e.db.app, svc, (tx) => recordAudit(tx, { action: "keepup.heartbeat", entityType: "keepup_sync", entityId: inv.id })))).toBe("OK");
  });
  it("a failed (forged) history write rolls the whole business transaction back", async () => {
    const before = await audits("item.price");
    await expect(withActorTransaction(e.db.app, user(e.staff), async (tx) => {
      await recordAudit(tx, { action: "item.price", entityType: "item", entityId: inv.id });
      await recordAudit(tx, { action: "invoice.cancel", entityType: "invoice", entityId: inv.id });      // forbidden -> everything above rolls back
    })).rejects.toBeInstanceOf(DomainError);
    expect(await audits("item.price")).toBe(before);
  });
  it("audit records stay immutable: update, delete and truncate are refused for the application role AND the owner", async () => {
    for (const pool of [e.db.app, e.db.admin]) {
      for (const sql of ["UPDATE audit_logs SET action='x'", "DELETE FROM audit_logs", "TRUNCATE audit_logs", "UPDATE status_events SET new_status='x'", "DELETE FROM status_events", "TRUNCATE status_events"]) {
        expect(["MV004", "42501"]).toContain(await sqlstate(pool.query(sql)));
      }
    }
  });
  it("operational tables reject writes that carry no verified actor (a leaked runtime credential without the signing key changes nothing)", async () => {
    const c = await customer(e.db.admin); const i = await item(e.db.admin, c); const ct = await carton(e.db.admin, c);
    expect(await sqlstate(e.db.app.query("UPDATE items SET description='tampered' WHERE id=$1", [i]))).toBe("MV007");
    expect(await sqlstate(e.db.app.query("INSERT INTO items (item_ref, customer_id) VALUES ('ITM-NOACT', $1)", [c]))).toBe("MV007");
    expect(await sqlstate(e.db.app.query("UPDATE cartons SET length=999 WHERE id=$1", [ct]))).toBe("MV007");
    expect(await sqlstate(e.db.app.query("INSERT INTO containers (container_ref) VALUES ('PMX-CON-2026-777')"))).toBe("MV007");
    expect(await sqlstate(e.db.app.query("INSERT INTO item_photos (item_id, storage_provider, url, public_id) VALUES ($1, 'cloudinary', 'https://res.cloudinary.com/x/y.jpg', 'p1')", [i]))).toBe("MV007");
    expect(await sqlstate(e.db.app.query("UPDATE invoice_lines SET description='x' WHERE invoice_id=$1", [inv.id]))).toMatch(/MV007|42501/);
    expect((await e.db.admin.query("SELECT description FROM items WHERE id=$1", [i])).rows[0].description).not.toBe("tampered");
    // ... and the same write with a verified actor is fine
    expect(await code(withActorTransaction(e.db.app, user(e.staff), (tx) => tx.query("UPDATE items SET description='ok' WHERE id=$1", [i])))).toBe("OK");
  });
  it("mass assignment: inherited object keys ('constructor', '__proto__', 'toString') are not editable customer fields", async () => {
    const c = await customer(e.db.admin);
    for (const bad of ['{"constructor":"x"}', '{"__proto__":"x"}', '{"toString":"x"}', '{"hasOwnProperty":"x"}', '{"id":"00000000-0000-4000-8000-000000000000"}', '{"shipping_mark":"MOVEZZ-HACK"}', '{"archived_at":null}']) {
      expect(await code(withActorTransaction(e.db.app, user(e.admin), (tx) => updateCustomerAdmin(tx, c, JSON.parse(bad)))), bad).toBe("INVALID_INPUT");
    }
    expect(await code(withActorTransaction(e.db.app, user(e.admin), (tx) => updateCustomerAdmin(tx, c, { notes: "ok" })))).toBe("OK");
  });
  it("deactivated and archived-customer actors cannot drive any operational workflow", async () => {
    await e.db.admin.query("UPDATE users SET is_active=false, deactivated_at=now() WHERE id=$1", [e.staff]);
    expect(await code(withActorTransaction(e.db.app, user(e.staff), (tx) => recordAudit(tx, { action: "item.price", entityType: "item", entityId: inv.id })))).toBe("ACTOR_INVALID");
    await e.db.admin.query("UPDATE users SET is_active=true, deactivated_at=NULL WHERE id=$1", [e.staff]);
    await e.db.admin.query("UPDATE customers SET status='inactive' WHERE id=$1", [e.loginCustomer]);
    expect(await code(withActorTransaction(e.db.app, user(e.login), (tx) => tx.query("SELECT 1")))).toBe("ACTOR_INVALID");
  });
});
