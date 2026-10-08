// Invoice creation (atomic, frozen snapshots), payments (GHS, append-only, no overpayment) and their immutability rules.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbDescribe, createTestDb, customer, item, carton, staffUser, fxRate, packageRates, specialRate, sqlstate, actorQuery, TEST_ACTOR_KEY, pricedItem, type TestDb } from "./helpers";
import { createInvoice, recordPayment, voidPayment, cancelInvoice } from "../../src/lib/db/invoices";
import { priceItem } from "../../src/lib/db/pricing";
import { withActorTransaction, user, beginActor } from "../../src/lib/db/actor";
import { DomainError } from "../../src/lib/db/errors";

async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : `RAW:${(e as Error).message}`; }
}
let keyN = 0;
const key = (p = "k") => `${p}-${Date.now()}-${++keyN}-abcdefgh`;

dbDescribe("invoices and payments (PostgreSQL)", () => {
  let db: TestDb; let actor: string;
  beforeAll(async () => { db = await createTestDb(); actor = await staffUser(db.admin); await packageRates(db.admin); });
  afterAll(async () => { await db?.close(); });

  const invoiceFor = async (opts: { prices?: string[]; discount?: string; rate?: string } = {}) => {
    await fxRate(db.admin, opts.rate ?? "12.50000000");
    const c = await customer(db.admin);
    const itemIds: string[] = [];
    for (const p of opts.prices ?? ["100.00"]) itemIds.push(await pricedItem(db.admin, c, p));
    const r = await createInvoice(db.app, { customerId: c, itemIds, discountUsd: opts.discount, discountReason: opts.discount ? "Approved test discount" : undefined, actor: user(actor), idempotencyKey: key("inv") });
    return { c, itemIds, ...r };
  };

  describe("createInvoice", () => {
    it("freezes USD totals, FX and GHS totals, and creates lines, links, history, audit, Keepup state and outbox in one transaction", async () => {
      const { invoice, itemIds, c } = await invoiceFor({ prices: ["100.00", "50.25"], discount: "10.25" });
      expect(invoice).toMatchObject({ status: "Pending", subtotal_usd: "150.25", discount_usd: "10.25", total_usd: "140.00", fx_rate: "12.50000000", fx_estimated: false,
        total_ghs: "1750.00", amount_paid_ghs: "0.00", balance_ghs: "1750.00" });
      expect(invoice.invoice_ref).toMatch(/^ORD-\d{5}$/);
      const lines = (await db.admin.query("SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no", [invoice.id])).rows;
      expect(lines.map((l) => l.line_total_usd).sort()).toEqual(["100.00", "50.25"]);
      expect(lines.every((l) => l.billing_basis === "tier" && l.package_tier === "basic" && l.rate_usd === "8.0000")).toBe(true);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM items WHERE invoice_id=$1", [invoice.id])).rows[0].n).toBe(itemIds.length);
      expect((await db.admin.query("SELECT new_status FROM status_events WHERE entity_type='invoice' AND entity_id=$1", [invoice.id])).rows).toEqual([{ new_status: "Pending" }]);
      expect((await db.admin.query("SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY id", [invoice.id])).rows).toEqual([{ action: "invoice.create" }, { action: "invoice.discount" }]); // this invoice carries a discount
      expect((await db.admin.query("SELECT sync_state, attempt_count FROM keepup_sync WHERE invoice_id=$1", [invoice.id])).rows).toEqual([{ sync_state: "pending", attempt_count: 0 }]);
      expect((await db.admin.query("SELECT status, recipient FROM notification_outbox WHERE dedupe_key=$1", [`invoice.created:${invoice.id}`])).rows).toHaveLength(1);
      void c;
    });

    it("missing FX is a controlled error and NOTHING is persisted (not even the reference number)", async () => {
      const f = await createTestDb(); // a database that has never had an FX rate
      try {
        const a = await staffUser(f.admin); await packageRates(f.admin);
        const c = await customer(f.admin); const i = await item(f.admin, c);
        const k = key("nofx");
        expect(await code(createInvoice(f.app, { customerId: c, itemIds: [i], actor: user(a), idempotencyKey: k }))).toBe("FX_RATE_MISSING");
        expect((await f.admin.query("SELECT invoice_id FROM items WHERE id=$1", [i])).rows[0].invoice_id).toBeNull();
        expect((await f.admin.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1", [k])).rows[0].n).toBe(0);
        expect((await f.admin.query("SELECT count(*)::int AS n FROM reference_counters WHERE ref_type='invoice'")).rows[0].n).toBe(0);
        await fxRate(f.admin); // once configured, the same request works with the same key
        expect((await createInvoice(f.app, { customerId: c, itemIds: [i], actor: user(a), idempotencyKey: k })).replayed).toBe(false);
        // a deactivated rate is as good as none
        await f.admin.query("UPDATE fx_rates SET is_active = false");
        const i2 = await item(f.admin, c);
        expect(await code(createInvoice(f.app, { customerId: c, itemIds: [i2], actor: user(a), idempotencyKey: key() }))).toBe("FX_RATE_MISSING");
      } finally { await f.close(); }
    });

    it("later FX, package-rate, customer-tier and item changes never change an existing invoice or its lines", async () => {
      const { invoice, itemIds, c } = await invoiceFor({ prices: ["100.00"] });
      const snap = async () => ({
        inv: (await db.admin.query("SELECT subtotal_usd, total_usd, fx_rate, total_ghs, balance_ghs FROM invoices WHERE id=$1", [invoice.id])).rows[0],
        lines: (await db.admin.query("SELECT line_total_usd, rate_usd, package_tier, billing_basis, description FROM invoice_lines WHERE invoice_id=$1", [invoice.id])).rows,
      });
      const before = await snap();
      await fxRate(db.admin, "99.00000000");
      await db.admin.query("UPDATE package_rates SET rate_usd = 999 WHERE tier='basic'");
      await db.admin.query("UPDATE customers SET package_tier='enterprise' WHERE id=$1", [c]);
      await db.admin.query("UPDATE items SET description='renamed', weight_kg=9 WHERE id=$1", [itemIds[0]]);
      expect(await snap()).toEqual(before);
      // restore the shared fixtures: later tests price against the real rates (prices are recomputed at invoicing)
      await db.admin.query("UPDATE package_rates SET rate_usd = CASE freight_type WHEN 'sea' THEN 350 ELSE 8 END WHERE tier='basic'");
      await db.admin.query("UPDATE customers SET package_tier='basic' WHERE id=$1", [c]);
      await fxRate(db.admin, "12.50000000");
    });

    it("FX history is reconstructable: the invoice points at the rate row it used, and an older rate is picked for an older instant", async () => {
      const f = await createTestDb();
      try {
        const a = await staffUser(f.admin); await packageRates(f.admin);
        await fxRate(f.admin, "10.00000000", "2026-01-01T00:00:00Z");
        const second = await fxRate(f.admin, "12.00000000", "2026-03-01T00:00:00Z");
        const { rows } = await f.admin.query("SELECT rate::text FROM current_fx_rate('USD','GHS','2026-02-01T00:00:00Z')");
        expect(rows[0].rate).toBe("10.00000000");
        const c = await customer(f.admin); const i = await item(f.admin, c);
        const { invoice } = await createInvoice(f.app, { customerId: c, itemIds: [i], actor: user(a), idempotencyKey: key() });
        expect((await f.admin.query("SELECT fx_rate_id FROM invoices WHERE id=$1", [invoice.id])).rows[0].fx_rate_id).toBe(second);
        expect(invoice.total_ghs).toBe("4200.00"); // 350 USD x 12
      } finally { await f.close(); }
    });

    it("bills special-basis items at the special price and keeps both snapshots on the line", async () => {
      await fxRate(db.admin);
      const c = await customer(db.admin);
      const i = await item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null });
      const card = await specialRate(db.admin, { name: "Bulk Lagos", sea_rate_usd: 300 });
      await withActorTransaction(db.app, user(actor), (tx) => priceItem(tx, i, { specialRateId: card }));
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() });
      expect(invoice.subtotal_usd).toBe("300.00");
      const l = (await db.admin.query("SELECT * FROM invoice_lines WHERE invoice_id=$1", [invoice.id])).rows[0];
      expect(l).toMatchObject({ billing_basis: "special", special_rate_id: card, special_rate_name: "Bulk Lagos", unit_price_usd: "300.00", rate_usd: "300.0000" });
      await db.admin.query("UPDATE special_rates SET sea_rate_usd = 1 WHERE id=$1", [card]);
      expect((await db.admin.query("SELECT line_total_usd FROM invoice_lines WHERE id=$1", [l.id])).rows[0].line_total_usd).toBe("300.00");
    });

    it("an invoiced carton becomes one line, its members are linked, and the carton is frozen", async () => {
      await fxRate(db.admin);
      const c = await customer(db.admin);
      const ct = await carton(db.admin, c, { price_usd: "175.00" });
      const member = await item(db.admin, c, { carton_id: ct });
      const { invoice } = await createInvoice(db.app, { customerId: c, cartonIds: [ct], actor: user(actor), idempotencyKey: key() });
      expect(invoice.subtotal_usd).toBe("175.00");
      expect((await db.admin.query("SELECT carton_id, item_id FROM invoice_lines WHERE invoice_id=$1", [invoice.id])).rows).toEqual([{ carton_id: ct, item_id: null }]);
      expect((await db.admin.query("SELECT invoice_id FROM items WHERE id=$1", [member])).rows[0].invoice_id).toBe(invoice.id);
      expect((await db.admin.query("SELECT status FROM cartons WHERE id=$1", [ct])).rows[0].status).toBe("invoiced");
      expect(await sqlstate(db.admin.query("UPDATE cartons SET price_usd = 1 WHERE id=$1", [ct]))).toBe("MV004");
      expect(await sqlstate(db.admin.query("UPDATE cartons SET length = 1 WHERE id=$1", [ct]))).toBe("MV004");
      expect(await sqlstate(db.admin.query("UPDATE cartons SET status='dissolved', dissolved_at=now() WHERE id=$1", [ct]))).toBe("MV004");
      expect(await sqlstate(db.admin.query("UPDATE items SET tier_price_usd = 1 WHERE id=$1", [member]))).toBe("MV004");
      await db.admin.query("UPDATE items SET status='Completed', description='ok' WHERE id=$1", [member]); // operational fields still editable
    });

    it("rejects: other customer's item, already invoiced item, unpriced item, discount above subtotal, empty invoice", async () => {
      await fxRate(db.admin);
      const a = await customer(db.admin), b = await customer(db.admin);
      const ib = await item(db.admin, b);
      expect(await code(createInvoice(db.app, { customerId: a, itemIds: [ib], actor: user(actor), idempotencyKey: key() }))).toBe("INVALID_INPUT");
      const unpriced = await item(db.admin, a, { tier_price_usd: null });
      expect(await code(createInvoice(db.app, { customerId: a, itemIds: [unpriced], actor: user(actor), idempotencyKey: key() }))).toBe("ITEM_UNPRICED");
      const ia = await item(db.admin, a);
      await createInvoice(db.app, { customerId: a, itemIds: [ia], actor: user(actor), idempotencyKey: key() });
      expect(await code(createInvoice(db.app, { customerId: a, itemIds: [ia], actor: user(actor), idempotencyKey: key() }))).toBe("INVALID_INPUT");
      const ia2 = await item(db.admin, a);
      expect(await code(createInvoice(db.app, { customerId: a, itemIds: [ia2], discountUsd: "400.00", actor: user(actor), idempotencyKey: key() }))).toBe("DISCOUNT_INVALID");
      expect(await code(createInvoice(db.app, { customerId: a, actor: user(actor), idempotencyKey: key() }))).toBe("INVALID_INPUT");
      expect((await db.admin.query("SELECT invoice_id FROM items WHERE id=$1", [ia2])).rows[0].invoice_id).toBeNull();
    });

    it("idempotency: the same key replays the stored invoice; the same key with a different body is a conflict", async () => {
      await fxRate(db.admin);
      const c = await customer(db.admin); const i = await item(db.admin, c); const i2 = await item(db.admin, c);
      const k = key("idem");
      const first = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: k });
      const again = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: k });
      expect(again.replayed).toBe(true);
      expect(again.invoice.id).toBe(first.invoice.id);
      expect(await code(createInvoice(db.app, { customerId: c, itemIds: [i2], actor: user(actor), idempotencyKey: k }))).toBe("IDEMPOTENCY_CONFLICT");
      expect((await db.admin.query("SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1", [c])).rows[0].n).toBe(1);
    });
  });

  describe("invoice immutability and lines", () => {
    it("financial snapshot columns cannot be edited; amount_paid and status cannot be set directly", async () => {
      const { invoice } = await invoiceFor();
      for (const set of ["subtotal_usd = 1", "discount_usd = 1", "fx_rate = 1", "total_ghs = 1", "customer_id = (SELECT id FROM customers LIMIT 1 OFFSET 1)", "invoice_ref = 'ORD-99999'"]) {
        expect(await sqlstate(db.admin.query(`UPDATE invoices SET ${set} WHERE id=$1`, [invoice.id])), set).toMatch(/MV004|23/);
      }
      expect(await sqlstate(db.admin.query("UPDATE invoices SET amount_paid_ghs = 10 WHERE id=$1", [invoice.id]))).toBe("MV004");
      expect(await sqlstate(actorQuery(db.admin).query("UPDATE invoices SET status = 'Paid' WHERE id=$1", [invoice.id]))).toBe("MV004");
      expect(await sqlstate(db.admin.query("UPDATE invoices SET balance_ghs = 0 WHERE id=$1", [invoice.id]))).toBe("428C9");
      await db.admin.query("UPDATE invoices SET notes='fine', keepup_link='https://x.invalid/s' WHERE id=$1", [invoice.id]); // non-financial fields stay editable
    });
    it("invoice lines are append-only", async () => {
      const { invoice } = await invoiceFor();
      expect(await sqlstate(db.admin.query("UPDATE invoice_lines SET unit_price_usd = 1 WHERE invoice_id=$1", [invoice.id]))).toBe("MV004");
      expect(await sqlstate(db.admin.query("DELETE FROM invoice_lines WHERE invoice_id=$1", [invoice.id]))).toBe("MV004");
      expect(await sqlstate(db.admin.query("TRUNCATE invoice_lines"))).toBe("MV004");
    });
    it("lines must add up to the subtotal at commit, and the GHS total must equal round(USD total x rate)", async () => {
      await fxRate(db.admin);
      const c = await customer(db.admin);
      const lineItem = await pricedItem(db.admin, c, "60.00");   // an authoritative USD 60 line under a USD 100 header
      const bad = db.admin.connect().then(async (cl) => {
        try {
          await cl.query("BEGIN");
          await beginActor(cl, { type: "import" }, TEST_ACTOR_KEY);
          const inv = (await cl.query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs) VALUES ('ORD-X1',$1, (SELECT id FROM current_fx_rate()),100,12.5,1250) RETURNING id`, [c])).rows[0];
          await cl.query(`INSERT INTO invoice_lines (invoice_id, line_no, item_id, description, unit_price_usd, line_total_usd, billing_basis, package_tier, rate_usd) VALUES ($1,1,$2,'x',60,60,'tier','basic',8)`, [inv.id, lineItem]);
          await cl.query("COMMIT");
        } finally { cl.release(); }
      });
      await expect(bad).rejects.toMatchObject({ code: "MV006" });
      expect(await sqlstate(actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs) VALUES ('ORD-X2',$1, (SELECT id FROM current_fx_rate()),100,12.5,1249.99)`, [c]))).toBe("23514");
      // an estimated (reconstructed) legacy invoice is exempt from the exact-GHS rule, and may have no lines
      await actorQuery(db.admin).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, fx_estimated, total_ghs, legacy_airtable_id, provenance, provenance_note) VALUES ('ORD-X3',$1, (SELECT id FROM current_fx_rate()),100,12.5,true,1300,'recLEG1','estimated','historic rate unknown')`, [c]);
    });
    it("a line cannot reference another customer's item", async () => {
      const { invoice } = await invoiceFor();
      const other = await customer(db.admin); const oi = await item(db.admin, other);
      expect(await sqlstate(db.admin.query(`INSERT INTO invoice_lines (invoice_id, line_no, item_id, description, unit_price_usd, line_total_usd, billing_basis) VALUES ($1,9,$2,'x',1,1,'tier')`, [invoice.id, oi]))).toBe("MV004");
    });
    it("the runtime role cannot delete invoices, items or customers, run DDL or truncate", async () => {
      const { invoice } = await invoiceFor();
      expect(await sqlstate(db.app.query("DELETE FROM invoices WHERE id=$1", [invoice.id]))).toBe("42501");
      expect(await sqlstate(db.app.query("DELETE FROM items"))).toBe("42501");
      expect(await sqlstate(db.app.query("DELETE FROM customers"))).toBe("42501");
      expect(await sqlstate(db.app.query("TRUNCATE invoices"))).toBe("42501");
      expect(await sqlstate(db.app.query("CREATE TABLE evil (id int)"))).toBe("42501");
      expect(await sqlstate(db.app.query("ALTER TABLE invoices ADD COLUMN x int"))).toBe("42501");
      expect((await db.app.query("SELECT rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolbypassrls: false });
    });
  });

  describe("payments", () => {
    const pay = (invoiceId: string, amount: string, over: Record<string, unknown> = {}) =>
      recordPayment(db.app, { invoiceId, amountGhs: amount, actor: user(actor), idempotencyKey: key("pay"), ...over });

    it("partial then full payment: exact NUMERIC arithmetic, derived paid/balance/status, status events", async () => {
      const { invoice } = await invoiceFor({ prices: ["100.00"] });        // GHS 1250.00
      const p1 = await pay(invoice.id, "0.10"); const p2 = await pay(invoice.id, "0.20");
      expect(p2.invoice).toMatchObject({ amount_paid_ghs: "0.30", balance_ghs: "1249.70", status: "Partial" });  // 0.1 + 0.2 is exactly 0.30
      const p3 = await pay(invoice.id, "1249.70");
      expect(p3.invoice).toMatchObject({ amount_paid_ghs: "1250.00", balance_ghs: "0.00", status: "Paid" });
      expect((await db.admin.query("SELECT old_status, new_status FROM status_events WHERE entity_type='invoice' AND entity_id=$1 ORDER BY id", [invoice.id])).rows)
        .toEqual([{ old_status: null, new_status: "Pending" }, { old_status: "Pending", new_status: "Partial" }, { old_status: "Partial", new_status: "Paid" }]);
      expect(p1.payment.amount_ghs).toBe("0.10");
    });
    it("overpayment is refused, even by one pesewa, and leaves the invoice untouched", async () => {
      const { invoice } = await invoiceFor({ prices: ["100.00"] });
      await pay(invoice.id, "1000.00");
      expect(await code(pay(invoice.id, "250.01"))).toBe("OVERPAYMENT");
      expect((await db.admin.query("SELECT amount_paid_ghs, status FROM invoices WHERE id=$1", [invoice.id])).rows[0]).toEqual({ amount_paid_ghs: "1000.00", status: "Partial" });
      expect((await pay(invoice.id, "250.00")).invoice.status).toBe("Paid");
    });
    it("USD is never compared with GHS: a payment of 100 is GHS 100 against a GHS 1250 invoice, not a settled USD 100 invoice", async () => {
      const { invoice } = await invoiceFor({ prices: ["100.00"] });
      expect((await pay(invoice.id, "100.00", { usdEquivalent: "8.00" })).invoice).toMatchObject({ status: "Partial", balance_ghs: "1150.00" });
      expect((await db.admin.query("SELECT amount_ghs, usd_equivalent FROM payments WHERE invoice_id=$1", [invoice.id])).rows[0]).toEqual({ amount_ghs: "100.00", usd_equivalent: "8.00" });
    });
    it("rejects non-positive and over-precise amounts (service) and non-positive amounts (database)", async () => {
      const { invoice } = await invoiceFor();
      for (const bad of ["0", "-5", "1.005", "abc"]) expect(await code(pay(invoice.id, bad)), bad).toBe("INVALID_INPUT");
      expect(await sqlstate(actorQuery(db.admin).query("INSERT INTO payments (invoice_id, amount_ghs) VALUES ($1, 0)", [invoice.id]))).toBe("23514");
    });
    it("payments are append-only: no delete, no truncate, no edits; a void is the only correction and restores the balance", async () => {
      const { invoice } = await invoiceFor({ prices: ["100.00"] });
      const { payment } = await pay(invoice.id, "1250.00");
      expect(await sqlstate(db.admin.query("DELETE FROM payments WHERE id=$1", [payment.id]))).toBe("MV004");
      expect(await sqlstate(db.admin.query("TRUNCATE payments"))).toMatch(/MV004|0A000/); // blocked by the trigger, and by the FK from keepup_sync
      expect(await sqlstate(actorQuery(db.admin).query("UPDATE payments SET amount_ghs = 1 WHERE id=$1", [payment.id]))).toBe("MV005");
      expect(await sqlstate(actorQuery(db.admin).query("UPDATE payments SET status='voided', voided_at=now(), void_reason='r', amount_ghs=1 WHERE id=$1", [payment.id]))).toBe("MV004");
      expect(await sqlstate(db.app.query("DELETE FROM payments WHERE id=$1", [payment.id]))).toBe("42501");
      const v = await voidPayment(db.app, { paymentId: payment.id, reason: "entered twice", actor: user(actor) });
      expect(v.invoice).toMatchObject({ amount_paid_ghs: "0.00", balance_ghs: "1250.00", status: "Pending" });
      expect((await db.admin.query("SELECT status, void_reason FROM payments WHERE id=$1", [payment.id])).rows[0]).toEqual({ status: "voided", void_reason: "entered twice" });
      expect(await code(voidPayment(db.app, { paymentId: payment.id, reason: "again", actor: user(actor) }))).toBe("INVALID_STATE");
      expect(await sqlstate(actorQuery(db.admin).query("UPDATE payments SET status='completed', voided_at=NULL, void_reason=NULL WHERE id=$1", [payment.id]))).toBe("MV005");
    });
    it("a voided payment frees its amount: the balance can be paid again", async () => {
      const { invoice } = await invoiceFor({ prices: ["100.00"] });
      const { payment } = await pay(invoice.id, "1250.00");
      await voidPayment(db.app, { paymentId: payment.id, reason: "bounced", actor: user(actor) });
      expect((await pay(invoice.id, "1250.00")).invoice.status).toBe("Paid");
    });
    it("cancelled invoices accept no payments; an invoice with completed payments cannot be cancelled; cancelled is terminal", async () => {
      const a = await invoiceFor({ prices: ["100.00"] });
      await pay(a.invoice.id, "10.00");
      expect(await code(cancelInvoice(db.app, { invoiceId: a.invoice.id, reason: "x", actor: user(actor) }))).toBe("INVALID_STATE");
      const b = await invoiceFor({ prices: ["100.00"] });
      const cancelled = await cancelInvoice(db.app, { invoiceId: b.invoice.id, reason: "customer cancelled", actor: user(actor) });
      expect(cancelled.status).toBe("Cancelled");
      expect(await code(pay(b.invoice.id, "5.00"))).toBe("INVALID_STATE");
      expect(await sqlstate(db.admin.query("UPDATE invoices SET notes='x' WHERE id=$1", [b.invoice.id]))).toBe("MV004");
      // cancelling releases the freeze on its items (re-pricing/re-invoicing is a service decision for a later phase)
      await db.admin.query("UPDATE items SET tier_price_usd = 1 WHERE id = ANY($1)", [b.itemIds]);
    });
    it("a payment on an unknown invoice is a controlled error", async () => {
      expect(await code(pay("00000000-0000-0000-0000-00000000dead", "1.00"))).toBe("INVALID_STATE");
    });
    it("idempotent payment: replaying the key returns the same payment and records nothing twice", async () => {
      const { invoice } = await invoiceFor({ prices: ["100.00"] });
      const k = key("pay-idem");
      const a = await pay(invoice.id, "100.00", { idempotencyKey: k });
      const b = await pay(invoice.id, "100.00", { idempotencyKey: k });
      expect(b.replayed).toBe(true);
      expect(b.payment.id).toBe(a.payment.id);
      expect(await code(pay(invoice.id, "200.00", { idempotencyKey: k }))).toBe("IDEMPOTENCY_CONFLICT");
      expect((await db.admin.query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoice.id])).rows[0].n).toBe(1);
    });
    it("a Keepup payment reference can be recorded once", async () => {
      const { invoice } = await invoiceFor({ prices: ["100.00"] });
      await pay(invoice.id, "10.00", { source: "keepup", keepupReference: "KU-PAY-1" });
      expect(await code(pay(invoice.id, "10.00", { source: "keepup", keepupReference: "KU-PAY-1" }))).toBe("DUPLICATE");
    });
  });
});
