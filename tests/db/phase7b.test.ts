// Phase 7B: database enforcement of the locked business rules (docs/DECISIONS.md D1-D25 + Addendum A).
// Service-level behavior (authorization, friendly errors, release workflow) is NOT tested here; it is Phase 7C-7G.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dbDescribe, createTestDb, createBareTestDb, customer, item, carton, staffUser, fxRate, packageRates, specialRate, sqlstate, actorQuery, pricedItem, type TestDb,
} from "./helpers";
import { createInvoice, recordPayment, cancelInvoice } from "../../src/lib/db/invoices";
import { priceItem } from "../../src/lib/db/pricing";
import { allocateContainerReference } from "../../src/lib/db/references";
import { withActorTransaction, user } from "../../src/lib/db/actor";
import { DomainError } from "../../src/lib/db/errors";
import { migrate, loadMigrations } from "../../scripts/lib/migrate.mjs";

let kn = 0;
const key = () => `p7b-${Date.now()}-${++kn}-abcdefgh`;
async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : `RAW:${(e as Error).message}`; }
}

dbDescribe("Phase 7B schema rules (PostgreSQL)", () => {
  let db: TestDb; let actor: string;
  beforeAll(async () => { db = await createTestDb(); actor = await staffUser(db.admin); await packageRates(db.admin); await fxRate(db.admin); });
  afterAll(async () => { await db?.close(); });

  describe("D1 container numbering is global and monotonic", () => {
    it("never resets across years, and the year printed is the creation year", async () => {
      const f = await createTestDb();
      try {
        const refs = [await allocateContainerReference(f.app, 2026), await allocateContainerReference(f.app, 2026),
          await allocateContainerReference(f.app, 2027), await allocateContainerReference(f.app, 2027), await allocateContainerReference(f.app, 2028)];
        expect(refs).toEqual(["PMX-CON-2026-001", "PMX-CON-2026-002", "PMX-CON-2027-003", "PMX-CON-2027-004", "PMX-CON-2028-005"]);
        expect((await f.admin.query("SELECT scope, last_value FROM reference_counters WHERE ref_type='container'")).rows).toEqual([{ scope: "", last_value: "5" }]);
        expect(await allocateContainerReference(f.app)).toMatch(/^PMX-CON-\d{4}-006$/); // default year = now
      } finally { await f.close(); }
    });
    it("is unique under concurrency, also when allocations straddle a year boundary", async () => {
      const f = await createTestDb();
      try {
        const refs = await Promise.all(Array.from({ length: 40 }, (_, i) => allocateContainerReference(f.app, i % 2 ? 2026 : 2027)));
        expect(new Set(refs).size).toBe(40);
        expect(refs.map((r) => Number(r.slice(-3))).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      } finally { await f.close(); }
    });
    it("padding never truncates and the counter is independent of row counts", async () => {
      const f = await createTestDb();
      try {
        await f.admin.query("SELECT seed_reference_counter('container','2026',999)");
        expect(await allocateContainerReference(f.app, 2026)).toBe("PMX-CON-2026-1000");
        await f.admin.query("INSERT INTO containers (container_ref) VALUES ('PMX-CON-2026-001')"); // a stray row changes nothing
        expect(await allocateContainerReference(f.app, 2026)).toBe("PMX-CON-2026-1001");
      } finally { await f.close(); }
    });
  });

  describe("counter hardening", () => {
    it("the runtime role cannot read, rewind, insert or delete counters, nor call the seeding/grant functions", async () => {
      for (const sql of ["SELECT * FROM reference_counters", "UPDATE reference_counters SET last_value = 0", "DELETE FROM reference_counters",
        "INSERT INTO reference_counters (ref_type, scope, last_value) VALUES ('item','',0)", "SELECT seed_reference_counter('item','',0)", "SELECT apply_runtime_grants('movezz_app')"]) {
        expect(await sqlstate(db.app.query(sql)), sql).toBe("42501");
      }
      const a = (await db.app.query("SELECT allocate_reference('item') AS r")).rows[0].r;
      const b = (await db.app.query("SELECT allocate_reference('item') AS r")).rows[0].r;
      expect(b).not.toBe(a);
    });
    it("a counter cannot be given a per-year container scope or a negative value", async () => {
      expect(await sqlstate(db.admin.query("INSERT INTO reference_counters (ref_type, scope, last_value) VALUES ('container','2031',1)"))).toBe("23514");
      expect(await sqlstate(db.admin.query("UPDATE reference_counters SET last_value = -1 WHERE ref_type='item'"))).toBe("23514");
    });
  });

  describe("D5 zero is never a price or a rate", () => {
    it("rejects zero item prices and rates", async () => {
      const c = await customer(db.admin);
      for (const col of ["tier_price_usd", "tier_rate_usd", "special_price_usd", "special_rate_usd"]) {
        expect(await sqlstate(item(db.admin, c, { [col]: 0 })), col).toBe("23514");
      }
      expect(await sqlstate(item(db.admin, c, { tier_price_usd: null }))).toBe("OK"); // NULL = not priced yet (cannot be invoiced)
    });
    it("rejects zero carton prices and rates, zero package rates and zero invoice-line prices", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(carton(db.admin, c, { price_usd: 0 }))).toBe("23514");
      expect(await sqlstate(carton(db.admin, c, { rate_usd: 0 }))).toBe("23514");
      expect(await sqlstate(db.admin.query("INSERT INTO package_rates (tier, freight_type, rate_usd, is_active) VALUES ('enterprise','air',0,false)"))).toBe("23514");
      const { invoice } = await (async () => { const i = await item(db.admin, c); return createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() }); })();
      // on a native invoice the pricing guard refuses it first; the CHECK constraint itself is exercised on a historical (import) invoice
      expect(await sqlstate(db.admin.query(`INSERT INTO invoice_lines (invoice_id, line_no, description, unit_price_usd, line_total_usd, billing_basis) VALUES ($1,9,'x',0,0,'tier')`, [invoice.id]))).toBe("MV010");
      const legacy = (await actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, total_ghs, provenance, legacy_airtable_id) VALUES ('ORD-ZL1',$1,10,12.5,125,'legacy_known','recZL1') RETURNING id`, [c])).rows[0].id;
      expect(await sqlstate(actorQuery(db.admin).query(`INSERT INTO invoice_lines (invoice_id, line_no, description, unit_price_usd, line_total_usd, billing_basis, provenance) VALUES ($1,1,'x',0,0,'tier','legacy_known')`, [legacy]))).toBe("23514");
    });
    it("a native invoice needs a positive subtotal; imported (non-native) history may carry zero with provenance", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs) VALUES ('ORD-Z1',$1, (SELECT id FROM current_fx_rate()),0,12.5,0)`, [c]))).toBe("23514");
      await actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs, provenance, legacy_airtable_id) VALUES ('ORD-Z2',$1, (SELECT id FROM current_fx_rate()),0,12.5,0,'legacy_known','recZ2')`, [c]);
    });
    it("pricing an item that evaluates to zero is refused with PRICING_INVALID and writes nothing", async () => {
      const c = await customer(db.admin);
      const zero = await item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null, length: 0, width: 0, height: 0 });
      expect(await code(withActorTransaction(db.app, user(actor), (tx) => priceItem(tx, zero)))).toBe("PRICING_INVALID");
      expect((await db.admin.query("SELECT tier_price_usd FROM items WHERE id=$1", [zero])).rows[0].tier_price_usd).toBeNull();
    });
  });

  describe("D10 special-rate cards: no zero rates, rate context required", () => {
    it("rejects zero rates, a card with no rate at all, and missing rates are NULL not 0", async () => {
      expect(await sqlstate(specialRate(db.admin, { sea_rate_usd: 0 }))).toBe("23514");
      expect(await sqlstate(specialRate(db.admin, { air_rate_usd: 0 }))).toBe("23514");
      expect(await sqlstate(specialRate(db.admin, { sea_rate_usd: null, air_rate_usd: null }))).toBe("23514");
      expect(await sqlstate(db.admin.query("INSERT INTO special_rates (name) VALUES ('Defaulted to nothing')"))).toBe("23514"); // no silent 0 default any more
      expect(await sqlstate(specialRate(db.admin, { sea_rate_usd: 250, air_rate_usd: null }))).toBe("OK");
    });
    it("a sea-only card cannot be applied to an air item (and vice versa); the matching freight works", async () => {
      const c = await customer(db.admin);
      const seaOnly = await specialRate(db.admin, { name: "Sea only", sea_rate_usd: 280, air_rate_usd: null });
      const airOnly = await specialRate(db.admin, { name: "Air only", sea_rate_usd: null, air_rate_usd: 5 });
      const airItem = await item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null, freight_type: "air", weight_kg: 10, length: null, width: null, height: null });
      const seaItem = await item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null });
      expect(await code(withActorTransaction(db.app, user(actor), (tx) => priceItem(tx, airItem, { specialRateId: seaOnly })))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
      expect(await code(withActorTransaction(db.app, user(actor), (tx) => priceItem(tx, seaItem, { specialRateId: airOnly })))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
      expect(await withActorTransaction(db.app, user(actor), (tx) => priceItem(tx, airItem, { specialRateId: airOnly }))).toMatchObject({ billingBasis: "special", specialRateUsd: "5.0000", specialPriceUsd: "50.00" });
      expect(await withActorTransaction(db.app, user(actor), (tx) => priceItem(tx, seaItem, { specialRateId: seaOnly }))).toMatchObject({ billingBasis: "special", specialPriceUsd: "280.00" });
    });
    it("the database itself refuses a card attached to an item of the wrong freight, or to an item with no freight type", async () => {
      const c = await customer(db.admin);
      const airOnly = await specialRate(db.admin, { name: "Air only 2", sea_rate_usd: null, air_rate_usd: 5 });
      expect(await sqlstate(item(db.admin, c, { billing_basis: "special", special_rate_id: airOnly, special_rate_name: "x", special_price_usd: 1, freight_type: "sea" }))).toBe("MV002");
      expect(await sqlstate(item(db.admin, c, { billing_basis: "special", special_rate_id: airOnly, special_rate_name: "x", special_price_usd: 1, freight_type: null }))).toBe("MV002");
      const seaItem = await item(db.admin, c);
      expect(await sqlstate(db.admin.query("UPDATE items SET billing_basis='special', special_rate_id=$2, special_rate_name='x', special_price_usd=1 WHERE id=$1", [seaItem, airOnly]))).toBe("MV002");
      expect(await sqlstate(db.admin.query("UPDATE items SET freight_type='air' WHERE id=$1", [seaItem]))).toBe("OK"); // no card attached, free to change
    });
    it("valid explicit special pricing still works end to end, then bills at the special price", async () => {
      const c = await customer(db.admin);
      const card = await specialRate(db.admin, { name: "Valid 7B", sea_rate_usd: 300, air_rate_usd: 6 });
      const i = await item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null });
      await withActorTransaction(db.app, user(actor), (tx) => priceItem(tx, i, { specialRateId: card }));
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() });
      expect(invoice.subtotal_usd).toBe("300.00");
    });
  });

  describe("D16 / A3 discount reason (required only when the discount is above zero)", () => {
    const insert = (c: string, ref: string, discount: number, reason: string | null) =>
      // discounts are a super_admin-only act (Phase 7D): the raw insert runs under a verified super_admin actor
      actorQuery(db.admin, user(actor)).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, discount_usd, discount_reason, fx_rate, total_ghs) VALUES ($1,$2,(SELECT id FROM current_fx_rate()),100,$3::numeric,$4,12.5,round((100-$3::numeric)*12.5,2))`, [ref, c, discount, reason]);
    it("accepts discount 0 with NULL reason, and a positive discount with a real reason", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(insert(c, "ORD-R1", 0, null))).toBe("OK");
      expect(await sqlstate(insert(c, "ORD-R2", 50, "Approved promotional discount"))).toBe("OK");
    });
    it("rejects a positive discount with a NULL, empty or whitespace-only reason", async () => {
      const c = await customer(db.admin);
      for (const [n, r] of [[3, null], [4, ""], [5, "   "], [6, "\n\t"]] as const) expect(await sqlstate(insert(c, `ORD-R${n}`, 50, r)), String(r)).toBe("23514");
    });
    it("rejects a whitespace-only reason even when the discount is 0, and a discount above the subtotal or negative", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(insert(c, "ORD-R7", 0, "  "))).toBe("23514");
      expect(await sqlstate(insert(c, "ORD-R8", 150, "too much"))).toBe("23514");
      expect(await sqlstate(insert(c, "ORD-R9", -5, "negative"))).toBe("23514");
    });
    it("the reason is frozen with the rest of the invoice snapshot", async () => {
      const c = await customer(db.admin);
      await insert(c, "ORD-R10", 50, "Original reason");
      expect(await sqlstate(db.admin.query("UPDATE invoices SET discount_reason='changed' WHERE invoice_ref='ORD-R10'"))).toBe("MV004");
      expect(await sqlstate(db.admin.query("UPDATE invoices SET discount_usd=0, discount_reason=NULL WHERE invoice_ref='ORD-R10'"))).toBe("MV004");
    });
    it("createInvoice stores the reason; the database refuses a discount without one", async () => {
      const c = await customer(db.admin); const i = await item(db.admin, c); const i2 = await item(db.admin, c);
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], discountUsd: "50.00", discountReason: "Approved promotional discount", actor: user(actor), idempotencyKey: key() });
      expect((await db.admin.query("SELECT discount_reason FROM invoices WHERE id=$1", [invoice.id])).rows[0].discount_reason).toBe("Approved promotional discount");
      expect(await code(createInvoice(db.app, { customerId: c, itemIds: [i2], discountUsd: "50.00", actor: user(actor), idempotencyKey: key() }))).toBe("DISCOUNT_INVALID");
    });
  });

  describe("D4 / A2 zero-value invoices", () => {
    it("a 100% discount gives a zero-value invoice that is Paid, has no payment, keeps its lines and history, and is Movezz-only", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], discountUsd: "100.00", discountReason: "Approved promotional waiver by management", actor: user(actor), idempotencyKey: key() });
      expect(invoice).toMatchObject({ status: "Paid", subtotal_usd: "100.00", discount_usd: "100.00", total_usd: "0.00", total_ghs: "0.00", amount_paid_ghs: "0.00", balance_ghs: "0.00", fx_rate: "12.50000000" });
      expect(invoice.invoice_ref).toMatch(/^ORD-\d{5}$/);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoice.id])).rows[0].n).toBe(0);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM invoice_lines WHERE invoice_id=$1", [invoice.id])).rows[0].n).toBe(1);
      expect((await db.admin.query("SELECT old_status, new_status FROM status_events WHERE entity_type='invoice' AND entity_id=$1", [invoice.id])).rows).toEqual([{ old_status: null, new_status: "Paid" }]);
      expect((await db.admin.query("SELECT action, after_data->>'total_ghs' AS t FROM audit_logs WHERE entity_id=$1 AND action='invoice.create'", [invoice.id])).rows).toEqual([{ action: "invoice.create", t: "0.00" }]);
      expect((await db.admin.query("SELECT sync_state, kind FROM keepup_sync WHERE invoice_id=$1", [invoice.id])).rows).toEqual([{ sync_state: "not_required", kind: "invoice" }]);
    });
    it("no payment can be recorded on it (no fake or real payment: it is already settled)", async () => {
      const c = await customer(db.admin); const i = await item(db.admin, c);
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], discountUsd: "350.00", discountReason: "waiver", actor: user(actor), idempotencyKey: key() });
      expect(invoice.status).toBe("Paid");
      expect(await code(recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "1.00", actor: user(actor), idempotencyKey: key() }))).toBe("OVERPAYMENT");
      expect(await sqlstate(actorQuery(db.admin).query("INSERT INTO payments (invoice_id, amount_ghs) VALUES ($1, 0)", [invoice.id]))).toBe("23514");
    });
    it("the database settles any zero-total invoice itself and refuses a zero-total invoice that is Pending/Partial", async () => {
      const c = await customer(db.admin);
      await actorQuery(db.admin, user(actor)).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, discount_usd, discount_reason, fx_rate, total_ghs) VALUES ('ORD-ZV1',$1, (SELECT id FROM current_fx_rate()),100,100,'waiver',12.5,0)`, [c]);
      expect((await db.admin.query("SELECT status FROM invoices WHERE invoice_ref='ORD-ZV1'")).rows[0].status).toBe("Paid");
      expect(await sqlstate(actorQuery(db.admin, user(actor)).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, discount_usd, discount_reason, fx_rate, total_ghs, status) VALUES ('ORD-ZV2',$1, (SELECT id FROM current_fx_rate()),100,100,'waiver',12.5,0,'Partial')`, [c]))).toBe("23514");
    });
    it("Keepup state: not_required is valid only for zero-total invoices, and a zero-total invoice cannot be queued for Keepup", async () => {
      const c = await customer(db.admin);
      const zero = (await actorQuery(db.admin, user(actor)).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, discount_usd, discount_reason, fx_rate, total_ghs) VALUES ('ORD-ZV3',$1, (SELECT id FROM current_fx_rate()),100,100,'waiver',12.5,0) RETURNING id`, [c])).rows[0].id;
      const paid = (await actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs) VALUES ('ORD-ZV4',$1, (SELECT id FROM current_fx_rate()),100,12.5,1250) RETURNING id`, [c])).rows[0].id;
      expect(await sqlstate(db.admin.query(`INSERT INTO keepup_sync (kind, invoice_id, idempotency_key) VALUES ('invoice',$1,'k-zero-1')`, [zero]))).toBe("MV005");
      expect(await sqlstate(db.admin.query(`INSERT INTO keepup_sync (kind, invoice_id, idempotency_key, sync_state) VALUES ('invoice',$1,'k-pos-1','not_required')`, [paid]))).toBe("MV005");
      expect(await sqlstate(db.admin.query(`INSERT INTO keepup_sync (kind, invoice_id, idempotency_key, sync_state) VALUES ('invoice',$1,'k-zero-2','not_required')`, [zero]))).toBe("OK");
    });
    it("a zero-value invoice can still be cancelled (history kept); a normal invoice is unaffected (Pending until paid)", async () => {
      const c = await customer(db.admin); const i = await item(db.admin, c); const j = await item(db.admin, c);
      const z = await createInvoice(db.app, { customerId: c, itemIds: [i], discountUsd: "350.00", discountReason: "waiver", actor: user(actor), idempotencyKey: key() });
      expect((await cancelInvoice(db.app, { invoiceId: z.invoice.id, reason: "issued by mistake", actor: user(actor) })).invoice.status).toBe("Cancelled");
      const n = await createInvoice(db.app, { customerId: c, itemIds: [j], actor: user(actor), idempotencyKey: key() });
      expect(n.invoice.status).toBe("Pending");
    });
  });

  describe("D9 registration activation", () => {
    const reg = async (email: string) => (await db.admin.query("INSERT INTO registration_requests (email, name, phone) VALUES ($1,'N',$2) RETURNING id", [email, `024${Math.floor(Math.random() * 1e7)}`])).rows[0].id as string;
    it("walks pending -> approved -> activated with the required links and timestamps", async () => {
      const id = await reg("flow@example.invalid");
      const c = await customer(db.admin);
      const u = (await db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('uid-reg','flowuser@example.invalid','customer',$1) RETURNING id", [c])).rows[0].id;
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET status='activated', activated_at=now(), reviewed_at=now() WHERE id=$1", [id]))).toBe("MV005"); // cannot skip approval
      await db.admin.query("UPDATE registration_requests SET status='approved', reviewed_by=$2, reviewed_at=now(), resulting_customer_id=$3 WHERE id=$1", [id, actor, c]);
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET status='activated', activated_at=now() WHERE id=$1", [id]))).toBe("23514"); // needs the login link
      await db.admin.query("UPDATE registration_requests SET status='activated', activated_at=now(), resulting_user_id=$2 WHERE id=$1", [id, u]);
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET status='pending' WHERE id=$1", [id]))).toBe("MV005"); // terminal
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET status='cancelled' WHERE id=$1", [id]))).toBe("MV005");
    });
    it("activated_at and status agree; rejected and cancelled are terminal", async () => {
      const id = await reg("terminal@example.invalid");
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET activated_at=now() WHERE id=$1", [id]))).toBe("23514");
      await db.admin.query("UPDATE registration_requests SET status='rejected', reviewed_at=now(), rejection_reason='duplicate account' WHERE id=$1", [id]);
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET status='approved' WHERE id=$1", [id]))).toBe("MV005");
    });
    it("an approved-but-not-activated request still blocks a second request for the same e-mail or phone", async () => {
      const c = await customer(db.admin);
      const id = (await db.admin.query("INSERT INTO registration_requests (email,name,phone) VALUES ('blocked@example.invalid','B','0244555666') RETURNING id")).rows[0].id;
      await db.admin.query("UPDATE registration_requests SET status='approved', reviewed_at=now(), resulting_customer_id=$2 WHERE id=$1", [id, c]);
      expect(await sqlstate(db.admin.query("INSERT INTO registration_requests (email,name) VALUES ('BLOCKED@example.invalid','again')"))).toBe("23505");
      expect(await sqlstate(db.admin.query("INSERT INTO registration_requests (email,name,phone) VALUES ('other@example.invalid','again','(024) 455-5666')"))).toBe("23505");
    });
  });

  describe("D12 FX bounds", () => {
    it("USD->GHS rates must be within 0.1 and 1000 (boundaries inclusive)", async () => {
      const ins = (r: string) => db.admin.query(`INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at, is_active) VALUES ('USD','GHS',$1,'bounds-test', now() - interval '1 day' + ($1::numeric * interval '1 second'), false)`, [r]);
      for (const bad of ["0.09999999", "0.00000001", "1000.00000001", "5000"]) expect(await sqlstate(ins(bad)), bad).toBe("23514");
      for (const ok of ["0.1", "12.5", "1000"]) expect(await sqlstate(ins(ok)), ok).toBe("OK");
    });
    it("a frozen invoice rate outside the bounds is refused, estimated or not", async () => {
      const c = await customer(db.admin);
      for (const rate of [0.05, 2000]) {
        expect(await sqlstate(actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs, fx_estimated, provenance, provenance_note) VALUES ('ORD-F1',$1, (SELECT id FROM current_fx_rate()),100,$2::numeric,round(100*$2::numeric,2),true,'estimated','x')`, [c, rate])), String(rate)).toBe("23514");
      }
    });
  });

  describe("D11 provenance and ambiguity marking", () => {
    it("estimated/ambiguous values need an explanation; fx_estimated requires a non-native provenance", async () => {
      const c = await customer(db.admin);
      const inv = (prov: string, note: string | null, est: boolean, ref: string) =>
        actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs, fx_estimated, provenance, provenance_note) VALUES ($1,$2, (SELECT id FROM current_fx_rate()),100,12.5,1250,$3,$4,$5)`, [ref, c, est, prov, note]);
      expect(await sqlstate(inv("estimated", null, true, "ORD-P1"))).toBe("23514");
      expect(await sqlstate(inv("estimated", "   ", true, "ORD-P2"))).toBe("23514");
      expect(await sqlstate(inv("native", null, true, "ORD-P3"))).toBe("23514");
      expect(await sqlstate(inv("legacy_ambiguous", "customer link unprovable", false, "ORD-P4"))).toBe("OK");
      expect(await sqlstate(inv("legacy_known", null, false, "ORD-P5"))).toBe("OK");
      expect(await sqlstate(inv("invented", null, false, "ORD-P6"))).toBe("23514");
    });
    it("items, lines and special rates carry the same markers; a legacy name-only special snapshot is representable", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(item(db.admin, c, { provenance: "legacy_ambiguous" }))).toBe("23514");
      expect(await sqlstate(item(db.admin, c, { provenance: "legacy_ambiguous", provenance_note: "card owner unknown", billing_basis: "special", special_rate_name: "Old", special_price_usd: 80 }))).toBe("OK");
      expect(await sqlstate(specialRate(db.admin, { provenance: "legacy_ambiguous" }))).toBe("23514");
      expect(await sqlstate(specialRate(db.admin, { provenance: "legacy_ambiguous", provenance_note: "customer scope unknown" }))).toBe("OK");
    });
    it("the provenance of an invoice cannot be edited afterwards", async () => {
      const c = await customer(db.admin);
      await actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs, provenance) VALUES ('ORD-P7',$1, (SELECT id FROM current_fx_rate()),100,12.5,1250,'legacy_known')`, [c]);
      expect(await sqlstate(db.admin.query("UPDATE invoices SET provenance='native' WHERE invoice_ref='ORD-P7'"))).toBe("MV004");
    });
  });

  describe("D8 user / customer active-state consistency", () => {
    it("an active login cannot be created or re-activated for an inactive or archived customer", async () => {
      const inactive = await customer(db.admin);
      await db.admin.query("UPDATE customers SET status='inactive' WHERE id=$1", [inactive]);
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('u-in1','in1@example.invalid','customer',$1)", [inactive]))).toBe("MV005");
      const archived = await customer(db.admin);
      await db.admin.query("UPDATE customers SET status='inactive', archived_at=now() WHERE id=$1", [archived]);
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('u-in2','in2@example.invalid','customer',$1)", [archived]))).toBe("MV005");
      // a deactivated login for an inactive customer is fine (history)
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id,is_active,deactivated_at) VALUES ('u-in3','in3@example.invalid','customer',$1,false,now())", [inactive]))).toBe("OK");
    });
    it("deactivating or archiving a customer deactivates its login with a status event; history stays intact", async () => {
      for (const how of ["status='inactive'", "status='inactive', archived_at=now()"]) {
        const c = await customer(db.admin); const i = await item(db.admin, c);
        const uid = (await db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id) VALUES ($1,$2,'customer',$3) RETURNING id", [`u-${Math.random()}`, `x${Math.random()}@example.invalid`, c])).rows[0].id;
        await db.admin.query(`UPDATE customers SET ${how} WHERE id=$1`, [c]);
        const u = (await db.admin.query("SELECT is_active, deactivated_at IS NOT NULL AS stamped FROM users WHERE id=$1", [uid])).rows[0];
        expect(u).toEqual({ is_active: false, stamped: true });
        expect((await db.admin.query("SELECT old_status, new_status, actor_type FROM status_events WHERE entity_type='user' AND entity_id=$1", [uid])).rows).toEqual([{ old_status: "active", new_status: "inactive", actor_type: "system" }]);
        expect((await db.admin.query("SELECT count(*)::int AS n FROM items WHERE id=$1", [i])).rows[0].n).toBe(1);
      }
    });
    it("reactivating a customer does not silently reactivate the login; that is an explicit second step", async () => {
      const c = await customer(db.admin);
      const uid = (await db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('u-re','re@example.invalid','customer',$1) RETURNING id", [c])).rows[0].id;
      await db.admin.query("UPDATE customers SET status='inactive' WHERE id=$1", [c]);
      await db.admin.query("UPDATE customers SET status='active' WHERE id=$1", [c]);
      expect((await db.admin.query("SELECT is_active FROM users WHERE id=$1", [uid])).rows[0].is_active).toBe(false);
      await db.admin.query("UPDATE users SET is_active=true, deactivated_at=NULL WHERE id=$1", [uid]);
      expect((await db.admin.query("SELECT is_active FROM users WHERE id=$1", [uid])).rows[0].is_active).toBe(true);
    });
    it("staff and admin users are not affected by the customer rule", async () => {
      expect(await staffUser(db.admin, "warehouse_staff")).toBeTruthy();
    });
  });
});

dbDescribe("migration 0009 upgrade path (PostgreSQL)", () => {
  async function dbAt0008() {
    const bare = await createBareTestDb();
    const dir = await mkdtemp(path.join(tmpdir(), "mig8-"));
    for (const f of (await loadMigrations()).filter((m: { version: number }) => m.version <= 8)) await writeFile(path.join(dir, f.name), f.sql);
    await migrate(bare.url, { dir });
    return bare;
  }
  it("refuses to run when existing rows violate the new rules, reports counts, and changes nothing", async () => {
    const old = await dbAt0008();
    try {
      const c = await customer(old.admin);
      // item with a zero price, a discounted invoice, a zero-total pending invoice (all valid under 0001-0008)
      await item(old.admin, c, { tier_price_usd: 0 });
      await old.admin.query(`INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, discount_usd, fx_rate, total_ghs) VALUES ('ORD-O1',$1,100,10,12.5,1125), ('ORD-O2',$1,100,100,12.5,0)`, [c]);
      const err = await migrate(old.url).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).toMatch(/0009_phase7_business_constraints.sql failed and was rolled back/);
      expect(String((err as Error).message)).toMatch(/items with a zero price or rate: 1/);
      expect(String((err as Error).message)).toMatch(/invoices with a discount but no stored reason: 2/);
      expect(String((err as Error).message)).toMatch(/zero-total invoices that are not Paid\/Cancelled: 1/);
      expect((await old.admin.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(8);
      expect((await old.admin.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='invoices' AND column_name='discount_reason'")).rows[0].n).toBe(0);
      expect((await old.admin.query("SELECT tier_price_usd::text AS p FROM items")).rows[0].p).toBe("0.00"); // data untouched, not silently fixed
    } finally { await old.close(); }
  });
  it("upgrades compliant data in place, keeps every row, seeds the global container counter and labels estimated invoices", async () => {
    const old = await dbAt0008();
    try {
      const c = await customer(old.admin);
      const i = await item(old.admin, c);
      await old.admin.query(`INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, fx_estimated, total_ghs) VALUES ('ORD-U1',$1,100,12.5,true,1300), ('ORD-U2',$1,50,12,false,600)`, [c]);
      // per-year container counters as Phase 6 produced them, plus existing containers
      await old.admin.query(`SELECT allocate_reference('container','2026'), allocate_reference('container','2026'), allocate_reference('container','2026'), allocate_reference('container','2027'), allocate_reference('container','2027')`);
      await old.admin.query(`INSERT INTO containers (container_ref) VALUES ('PMX-CON-2026-001'),('PMX-CON-2026-003'),('PMX-CON-2027-002'),('PMX-CON-2027-007')`);
      const before = (await old.admin.query("SELECT (SELECT count(*) FROM items) AS i, (SELECT count(*) FROM invoices) AS v, (SELECT count(*) FROM containers) AS k")).rows[0];
      expect((await migrate(old.url)).applied).toEqual(["0009_phase7_business_constraints.sql", "0010_trusted_actor_context.sql", "0011_authoritative_pricing.sql", "0012_invoice_cancellation_release.sql"]);
      expect((await old.admin.query("SELECT (SELECT count(*) FROM items) AS i, (SELECT count(*) FROM invoices) AS v, (SELECT count(*) FROM containers) AS k")).rows[0]).toEqual(before);
      expect((await old.admin.query("SELECT invoice_ref, provenance FROM invoices ORDER BY invoice_ref")).rows).toEqual([{ invoice_ref: "ORD-U1", provenance: "estimated" }, { invoice_ref: "ORD-U2", provenance: "native" }]);
      expect((await old.admin.query("SELECT total_ghs::text AS t FROM invoices WHERE invoice_ref='ORD-U1'")).rows[0].t).toBe("1300.00"); // money untouched
      // old per-year rows are kept (never deleted); the global counter is above everything ever issued (max suffix 7)
      expect((await old.admin.query("SELECT count(*)::int AS n FROM reference_counters WHERE ref_type='container' AND scope <> ''")).rows[0].n).toBe(2);
      expect((await old.admin.query("SELECT allocate_container_reference(2028) AS r")).rows[0].r).toBe("PMX-CON-2028-008");
      expect(i).toBeTruthy();
    } finally { await old.close(); }
  });
});
