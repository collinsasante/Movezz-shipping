// Phase 7E: invoice cancellation, item/carton release and re-invoicing - against real PostgreSQL and the real runtime role.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dbDescribe, createTestDb, customer, item, carton, pricedItem, staffUser, fxRate, packageRates, specialRate, sqlstate, actorQuery,
  type TestDb,
} from "./helpers";
import { createInvoice, cancelInvoice, recordPayment, voidPayment } from "../../src/lib/db/invoices";
import { priceItem } from "../../src/lib/db/pricing";
import { user, withActorTransaction } from "../../src/lib/db/actor";
import { DomainError } from "../../src/lib/db/errors";

let kn = 0;
const key = () => `cx-${Date.now()}-${++kn}-abcdefgh`;
const code = async (p: Promise<unknown>) => {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : ((e as { code?: string }).code ?? `RAW:${(e as Error).message}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

dbDescribe("invoice cancellation, release and re-invoicing (PostgreSQL)", () => {
  let db: TestDb; let admin: string; let staff: string; let custLogin: string;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const make = (c: string, extra: Record<string, unknown> & { itemIds: string[] }, who = admin) =>
    createInvoice(db.app, { customerId: c, actor: user(who), idempotencyKey: key(), ...extra } as Parameters<typeof createInvoice>[1]);
  const cancel = (id: string, extra: Record<string, unknown> = {}, who = admin) =>
    cancelInvoice(db.app, { invoiceId: id, reason: "customer asked to cancel", actor: user(who), ...extra } as Parameters<typeof cancelInvoice>[1]);
  const price = (id: string, card?: string | null) => withActorTransaction(db.app, user(staff), (tx) => priceItem(tx, id, { specialRateId: card }));
  const unpriced = (c: string, over: Record<string, unknown> = {}) =>
    item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null, length: 100, width: 100, height: 100, ...over });
  const slowRelease = async (ms = 700) => {            // makes the release step slow, so a competitor can be started mid-cancellation
    await q(`CREATE OR REPLACE FUNCTION test_slow_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(${ms / 1000}); RETURN NEW; END $$`);
    await q("CREATE TRIGGER test_slow_release BEFORE UPDATE OF invoice_id ON items FOR EACH ROW WHEN (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NULL) EXECUTE FUNCTION test_slow_release()");
  };
  const normal = () => q("DROP TRIGGER IF EXISTS test_slow_release ON items");

  beforeAll(async () => {
    db = await createTestDb();
    admin = await staffUser(db.admin, "super_admin"); staff = await staffUser(db.admin, "warehouse_staff");
    await packageRates(db.admin, "basic", "350", "8");
    await fxRate(db.admin, "12.50000000");
    const c0 = await customer(db.admin);
    custLogin = (await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('uc','uc@example.invalid','customer',$1) RETURNING id`, [c0]))[0].id;
  });
  afterAll(async () => { await db?.close(); });

  describe("lifecycle and historical preservation", () => {
    it("cancels, releases loose items, the carton and its members, and keeps every historical snapshot", async () => {
      const c = await customer(db.admin);
      const loose = await pricedItem(db.admin, c, "100.00");
      const ct = await carton(db.admin, c, { price_usd: "175.00", rate_usd: "350.0000" });
      const member = await item(db.admin, c, { carton_id: ct });
      const { invoice } = await make(c, { itemIds: [loose], cartonIds: [ct], discountUsd: "25.00", discountReason: "Approved loyalty discount" });
      await recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "10.00", actor: user(admin), idempotencyKey: key() }).then(async (p) => {
        await voidPayment(db.app, { paymentId: p.payment.id, reason: "entered in error", actor: user(admin) });
      });
      const snap = async () => ({
        inv: (await q("SELECT invoice_ref, status, subtotal_usd, discount_usd, discount_reason, total_usd, fx_rate, fx_rate_id, total_ghs, amount_paid_ghs, balance_ghs, provenance FROM invoices WHERE id=$1", [invoice.id]))[0],
        lines: await q("SELECT line_no, item_id, carton_id, unit_price_usd, line_total_usd, billing_basis, rate_usd, package_tier FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no", [invoice.id]),
        items: await q("SELECT item_ref, tier_rate_usd, tier_price_usd, billing_basis, special_price_usd, package_tier, status, weight_kg, length, quantity, customer_id, freight_type FROM items WHERE id = ANY($1) ORDER BY item_ref", [[loose, member]]),
        carton: (await q("SELECT carton_ref, price_usd, rate_usd, package_tier, pricing_basis, length, width, height, cbm, customer_id FROM cartons WHERE id=$1", [ct]))[0],
        payments: await q("SELECT amount_ghs, status, void_reason, voided_by, created_by, source FROM payments WHERE invoice_id=$1", [invoice.id]),
      });
      const before = await snap();
      const r = await cancel(invoice.id, { reason: "customer changed their mind" });
      expect(r).toMatchObject({ replayed: false });
      expect(r.invoice.status).toBe("Cancelled");
      expect(r.releasedItemIds.sort()).toEqual([loose, member].sort());
      expect(r.releasedCartonIds).toEqual([ct]);
      const after = await snap();
      const { status: _s, ...invBefore } = before.inv; const { status: _t, ...invAfter } = after.inv; void _s; void _t;
      expect(invAfter).toEqual(invBefore);                                   // money, FX, discount, reason, paid, balance: unchanged
      expect(after.lines).toEqual(before.lines);                             // the historical lines
      expect(after.items).toEqual(before.items);                             // live items keep their snapshots and operational data
      expect(after.carton).toEqual(before.carton);                           // price, rate, tier, basis, dims, CBM survive
      expect(after.payments).toEqual(before.payments);
      expect(after.payments).toHaveLength(1);
      expect(after.payments[0]).toMatchObject({ status: "voided", void_reason: "entered in error", voided_by: admin, created_by: admin });
      // released: no live link, carton open again, members stay in the carton
      expect(await q("SELECT id FROM items WHERE invoice_id=$1", [invoice.id])).toEqual([]);
      expect((await q("SELECT status, invoice_id, dissolved_at FROM cartons WHERE id=$1", [ct]))[0]).toEqual({ status: "open", invoice_id: null, dissolved_at: null });
      expect((await q("SELECT carton_id, invoice_id FROM items WHERE id=$1", [member]))[0]).toEqual({ carton_id: ct, invoice_id: null });
      // the cancelled invoice still owns its lines (historical owner of the old pricing)
      expect((await q("SELECT cancelled_by, cancel_reason, cancelled_at IS NOT NULL AS at FROM invoices WHERE id=$1", [invoice.id]))[0]).toEqual({ cancelled_by: admin, cancel_reason: "customer changed their mind", at: true });
    });

    it("writes status events (invoice, carton, items) and ONE audit record naming actor, statuses, reason and released ids", async () => {
      const c = await customer(db.admin);
      const a = await pricedItem(db.admin, c, "40.00"); const ct = await carton(db.admin, c, { price_usd: "175.00" }); const m = await item(db.admin, c, { carton_id: ct });
      const { invoice } = await make(c, { itemIds: [a], cartonIds: [ct] });
      const r = await cancel(invoice.id, { reason: "duplicate order", request: { ip: "203.0.113.9", userAgent: "vitest" } }, admin);
      const ev = await q("SELECT entity_type, entity_id, old_status, new_status, reason, actor_user_id, metadata FROM status_events WHERE (metadata->>'previous_invoice_id' = $1::text OR (entity_type='invoice' AND entity_id=$1::uuid AND new_status='Cancelled')) ORDER BY id", [invoice.id]);
      expect(ev.filter((e) => e.entity_type === "invoice")).toEqual([{ entity_type: "invoice", entity_id: invoice.id, old_status: "Pending", new_status: "Cancelled", reason: "duplicate order", actor_user_id: admin, metadata: null }]);
      expect(ev.filter((e) => e.entity_type === "carton")).toMatchObject([{ entity_id: ct, old_status: "invoiced", new_status: "open", actor_user_id: admin, metadata: { event: "invoice_released", previous_invoice_id: invoice.id } }]);
      expect(ev.filter((e) => e.entity_type === "item").map((e) => e.entity_id).sort()).toEqual([a, m].sort());
      expect(ev.filter((e) => e.entity_type === "item").every((e) => e.old_status === e.new_status && e.metadata.previous_invoice_ref === invoice.invoice_ref)).toBe(true);   // no invented item status
      const au = await q("SELECT actor_user_id, actor_type, before_data, after_data, host(ip_address) AS ip, created_at IS NOT NULL AS ts FROM audit_logs WHERE entity_id=$1 AND action='invoice.cancel'", [invoice.id]);
      expect(au).toHaveLength(1);
      expect(au[0]).toMatchObject({ actor_user_id: admin, actor_type: "user", ip: "203.0.113.9", ts: true, before_data: { status: "Pending" },
        after_data: { status: "Cancelled", reason: "duplicate order", released_carton_ids: [ct] } });
      expect(au[0].after_data.released_item_ids.sort()).toEqual(r.releasedItemIds.sort());
      expect(JSON.stringify(au[0])).not.toMatch(/password|token|secret|signature/i);
    });

    it("the spelling is 'Cancelled' everywhere; no other spelling can be stored", async () => {
      const c = await customer(db.admin);
      for (const bad of ["Canceled", "cancelled", "CANCELLED"]) {                       // a legacy-style insert is the only way to name a status directly
        expect(await sqlstate(actorQuery(db.admin, { type: "import" }).query(
          `INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, total_ghs, status, cancelled_at, cancel_reason, provenance, legacy_airtable_id)
           VALUES ($1,$2,10,12.5,125,$3,now(),'x','legacy_known',$1)`, [`ORD-SP${++kn}`, c, bad])), bad).toBe("23514");
      }
      expect(await sqlstate(actorQuery(db.admin, { type: "import" }).query(
        `INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, total_ghs, status, cancelled_at, cancel_reason, provenance, legacy_airtable_id)
         VALUES ($1,$2,10,12.5,125,'Cancelled',now(),'x','legacy_known',$1)`, [`ORD-SP${++kn}`, c]))).toBe("OK");
    });

    it("a blank reason (empty, spaces, tab, newline) is refused and nothing changes", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "40.00");
      const { invoice } = await make(c, { itemIds: [i] });
      for (const reason of ["", "   ", "\t", "\n", " \n\t "]) expect(await code(cancel(invoice.id, { reason })), JSON.stringify(reason)).toBe("INVALID_INPUT");
      expect(await sqlstate(actorQuery(db.admin, user(admin)).query("UPDATE invoices SET status='Cancelled', cancelled_at=now(), cancel_reason='  ' WHERE id=$1", [invoice.id]))).toBe("23514");
      expect((await q("SELECT status FROM invoices WHERE id=$1", [invoice.id]))[0].status).toBe("Pending");
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [i]))[0].invoice_id).toBe(invoice.id);
    });

    it("an unknown invoice is INVOICE_NOT_FOUND", async () => {
      expect(await code(cancel("00000000-0000-4000-8000-000000000000"))).toBe("INVOICE_NOT_FOUND");
    });

    it("a zero-value invoice (Paid, no payment) can be cancelled; Keepup stays not_required", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "40.00");
      const { invoice } = await make(c, { itemIds: [i], discountUsd: "40.00", discountReason: "waiver" });
      expect(invoice.status).toBe("Paid");
      const r = await cancel(invoice.id);
      expect(r.invoice.status).toBe("Cancelled");
      expect((await q("SELECT sync_state FROM keepup_sync WHERE invoice_id=$1", [invoice.id]))[0].sync_state).toBe("not_required");
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [i]))[0].invoice_id).toBeNull();
    });
  });

  describe("authorization boundary (final Phase 7F matrix: cancellation is super_admin only)", () => {
    it("customers, warehouse staff and service actors cannot cancel; only a super_admin can; the actor comes from the verified context only", async () => {
      const c = await customer(db.admin);
      const mk = async () => (await make(c, { itemIds: [await pricedItem(db.admin, c, "40.00")] })).invoice;
      const inv = await mk();
      expect(await code(cancel(inv.id, {}, custLogin))).toBe("NOT_AUTHORIZED");
      expect(await code(cancel(inv.id, {}, staff))).toBe("NOT_AUTHORIZED");
      expect(await code(cancelInvoice(db.app, { invoiceId: inv.id, reason: "x", actor: { type: "system" } }))).toBe("NOT_AUTHORIZED");
      expect(await code(cancelInvoice(db.app, { invoiceId: inv.id, reason: "x", actor: { type: "import" } }))).toBe("NOT_AUTHORIZED");
      expect((await q("SELECT status FROM invoices WHERE id=$1", [inv.id]))[0].status).toBe("Pending");
      expect(await code(cancelInvoice(db.app, { invoiceId: inv.id, reason: "x", actor: user(admin), actorUserId: staff } as never))).toBe("OK");   // an unknown field is not an actor
      expect((await q("SELECT cancelled_by FROM invoices WHERE id=$1", [inv.id]))[0].cancelled_by).toBe(admin);
      // SQL path: the invoice trigger refuses staff, customers and service actors too
      const inv3 = await mk();
      // a customer actor cannot even see the row (row-level security): the UPDATE matches nothing
      expect(await code(withActorTransaction(db.app, user(custLogin), (tx) => tx.query("UPDATE invoices SET status='Cancelled', cancelled_at=now(), cancel_reason='x' WHERE id=$1", [inv3.id])))).toBe("OK");
      for (const who of [user(staff), { type: "system" as const }]) {
        expect(await code(withActorTransaction(db.app, who, (tx) => tx.query("UPDATE invoices SET status='Cancelled', cancelled_at=now(), cancel_reason='x' WHERE id=$1", [inv3.id])))).toBe("NOT_AUTHORIZED");
      }
      expect((await q("SELECT status FROM invoices WHERE id=$1", [inv3.id]))[0].status).toBe("Pending");
    });
  });

  describe("payment prerequisite", () => {
    it("an invoice with a completed payment cannot be cancelled and nothing changes; after an explicit void it can", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const { invoice } = await make(c, { itemIds: [i] });
      const p = await recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "50.00", method: "cash", source: "manual", externalReference: "EXT-1", actor: user(admin), idempotencyKey: key() });
      const events = (await q("SELECT count(*)::int AS n FROM status_events"))[0].n, audits = (await q("SELECT count(*)::int AS n FROM audit_logs"))[0].n;
      expect(await code(cancel(invoice.id))).toBe("ACTIVE_PAYMENT_EXISTS");
      expect((await q("SELECT status, amount_paid_ghs FROM invoices WHERE id=$1", [invoice.id]))[0]).toEqual({ status: "Partial", amount_paid_ghs: "50.00" });
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [i]))[0].invoice_id).toBe(invoice.id);
      expect([(await q("SELECT count(*)::int AS n FROM status_events"))[0].n, (await q("SELECT count(*)::int AS n FROM audit_logs"))[0].n]).toEqual([events, audits]);
      expect((await q("SELECT status FROM payments WHERE id=$1", [p.payment.id]))[0].status).toBe("completed");   // not silently voided
      // fully paid: also refused
      await recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "1200.00", actor: user(admin), idempotencyKey: key() });
      expect(await code(cancel(invoice.id))).toBe("ACTIVE_PAYMENT_EXISTS");
      for (const pid of (await q("SELECT id FROM payments WHERE invoice_id=$1", [invoice.id])).map((r) => r.id)) await voidPayment(db.app, { paymentId: pid, reason: "refunded", actor: user(admin) });
      expect((await cancel(invoice.id)).invoice.status).toBe("Cancelled");
    });
    it("payments are never deleted or rewritten; voided payments stay as history; a cancelled invoice accepts no payment; overpayment protection is intact", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const { invoice } = await make(c, { itemIds: [i] });
      const p = await recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "300.00", method: "momo", externalReference: "MOMO-77", actor: user(admin), idempotencyKey: key() });
      expect(await code(recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "1000.00", actor: user(admin), idempotencyKey: key() }))).toBe("OVERPAYMENT");
      await voidPayment(db.app, { paymentId: p.payment.id, reason: "wrong invoice", actor: user(admin) });
      expect(await code(voidPayment(db.app, { paymentId: p.payment.id, reason: "again", actor: user(admin) }))).toBe("INVALID_STATE");
      await cancel(invoice.id);
      expect(await code(recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "1.00", actor: user(admin), idempotencyKey: key() }))).toBe("INVALID_STATE");
      expect(await sqlstate(db.admin.query("DELETE FROM payments WHERE id=$1", [p.payment.id]))).toBe("MV004");
      expect(await sqlstate(db.app.query("DELETE FROM payments WHERE id=$1", [p.payment.id]))).toBe("42501");
      expect(await sqlstate(actorQuery(db.admin, user(admin)).query("UPDATE payments SET status='completed', voided_at=NULL, void_reason=NULL WHERE id=$1", [p.payment.id]))).toBe("MV005");   // a voided payment is not reusable
      expect((await q("SELECT amount_ghs, status, method, external_reference, void_reason, voided_by, created_by FROM payments WHERE id=$1", [p.payment.id]))[0])
        .toEqual({ amount_ghs: "300.00", status: "voided", method: "momo", external_reference: "MOMO-77", void_reason: "wrong invoice", voided_by: admin, created_by: admin });
      expect((await q("SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY id", [p.payment.id])).map((r) => r.action)).toEqual(["payment.create", "payment.void"]);
      expect((await q("SELECT old_status, new_status FROM status_events WHERE entity_type='payment' AND entity_id=$1", [p.payment.id]))).toEqual([{ old_status: "completed", new_status: "voided" }]);
    });
  });

  describe("idempotency and repetition", () => {
    it("the same key replays the same logical result with no extra side effects; a different payload with the same key conflicts", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "40.00"); const ct = await carton(db.admin, c, { price_usd: "175.00" });
      const { invoice } = await make(c, { itemIds: [i], cartonIds: [ct] });
      const k = key();
      const first = await cancel(invoice.id, { idempotencyKey: k });
      const counts = async () => ({
        ev: (await q("SELECT count(*)::int AS n FROM status_events WHERE entity_id = ANY($1) OR metadata->>'previous_invoice_id' = $2", [[invoice.id, i, ct], invoice.id]))[0].n,
        au: (await q("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='invoice.cancel'", [invoice.id]))[0].n,
      });
      const c1 = await counts();
      const again = await cancel(invoice.id, { idempotencyKey: k });
      expect(again.replayed).toBe(true);
      expect(again.releasedItemIds).toEqual(first.releasedItemIds);
      expect(again.releasedCartonIds).toEqual(first.releasedCartonIds);
      expect(again.invoice.id).toBe(first.invoice.id);
      expect(await counts()).toEqual(c1);
      expect(await code(cancel(invoice.id, { idempotencyKey: k, reason: "a different reason" }))).toBe("IDEMPOTENCY_CONFLICT");
      expect(c1).toEqual({ ev: 5, au: 1 });   // creation: invoice + carton; cancellation: invoice + carton + item
    });
    it("without a key a repeat is INVOICE_ALREADY_CANCELLED and changes nothing (no second release, event or audit)", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "40.00");
      const { invoice } = await make(c, { itemIds: [i] });
      await cancel(invoice.id);
      // meanwhile the item is invoiced again: a stale repeat must not release it from the NEW invoice
      const second = (await make(c, { itemIds: [i] })).invoice;
      const events = (await q("SELECT count(*)::int AS n FROM status_events"))[0].n, audits = (await q("SELECT count(*)::int AS n FROM audit_logs"))[0].n;
      expect(await code(cancel(invoice.id))).toBe("INVOICE_ALREADY_CANCELLED");
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [i]))[0].invoice_id).toBe(second.id);
      expect([(await q("SELECT count(*)::int AS n FROM status_events"))[0].n, (await q("SELECT count(*)::int AS n FROM audit_logs"))[0].n]).toEqual([events, audits]);
    });
  });

  describe("re-invoicing uses current authoritative pricing", () => {
    it("rate change: the old invoice keeps the old price, the new invoice uses the new rate; nothing is copied", async () => {
      const c = await customer(db.admin); const i = await unpriced(c); await price(i);
      const a = (await make(c, { itemIds: [i] })).invoice;
      expect(a.subtotal_usd).toBe("350.00");
      await cancel(a.id);
      await q("UPDATE package_rates SET rate_usd = 400 WHERE tier='basic' AND freight_type='sea'");
      try {
        const b = (await make(c, { itemIds: [i] })).invoice;
        expect(b.subtotal_usd).toBe("400.00");
        expect(b.id).not.toBe(a.id);
        expect(b.invoice_ref).not.toBe(a.invoice_ref);
        expect((await q("SELECT unit_price_usd, rate_usd FROM invoice_lines WHERE invoice_id=$1", [b.id]))).toEqual([{ unit_price_usd: "400.00", rate_usd: "400.0000" }]);
        expect((await q("SELECT unit_price_usd, rate_usd FROM invoice_lines WHERE invoice_id=$1", [a.id]))).toEqual([{ unit_price_usd: "350.00", rate_usd: "350.0000" }]);
        expect((await q("SELECT subtotal_usd, total_ghs, status FROM invoices WHERE id=$1", [a.id]))[0]).toEqual({ subtotal_usd: "350.00", total_ghs: "4375.00", status: "Cancelled" });
      } finally { await q("UPDATE package_rates SET rate_usd = 350 WHERE tier='basic' AND freight_type='sea'"); }
    });
    it("special rate: a changed card is resolved afresh; an expired card is NOT silently replaced (explicit failure) until staff re-price", async () => {
      const c = await customer(db.admin); const i = await unpriced(c);
      const card = await specialRate(db.admin, { name: "Promo", sea_rate_usd: 300 });
      await price(i, card);
      const a = (await make(c, { itemIds: [i] })).invoice;
      expect(a.subtotal_usd).toBe("300.00");
      await cancel(a.id);
      await q("UPDATE special_rates SET sea_rate_usd = 280 WHERE id=$1", [card]);
      const b = (await make(c, { itemIds: [i] })).invoice;
      expect(b.subtotal_usd).toBe("280.00");                                       // current card, not the cancelled invoice's 300
      expect((await q("SELECT unit_price_usd FROM invoice_lines WHERE invoice_id=$1", [a.id]))[0].unit_price_usd).toBe("300.00");
      await cancel(b.id);
      await q("UPDATE special_rates SET effective_from = now() - interval '2 days', effective_to = now() - interval '1 minute' WHERE id=$1", [card]);
      expect(await code(make(c, { itemIds: [i] }))).toBe("SPECIAL_RATE_NOT_APPLICABLE");   // 7D: no silent fallback to tier
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [i]))[0].invoice_id).toBeNull();
      await price(i);                                                              // staff re-price without a card
      expect((await make(c, { itemIds: [i] })).invoice.subtotal_usd).toBe("350.00");
    });
    it("FX change: the old invoice stays frozen at the old rate, the new invoice freezes the current one", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const a = (await make(c, { itemIds: [i] })).invoice;
      const oldRate = a.fx_rate;
      await cancel(a.id);
      await fxRate(db.admin, "14.00000000");
      try {
        const b = (await make(c, { itemIds: [i] })).invoice;
        expect(b).toMatchObject({ fx_rate: "14.00000000", total_ghs: "1400.00" });
        expect((await q("SELECT fx_rate, total_ghs, fx_rate_id FROM invoices WHERE id=$1", [a.id]))[0]).toMatchObject({ fx_rate: oldRate, total_ghs: a.total_ghs });
        expect((await q("SELECT fx_rate_id FROM invoices WHERE id=$1", [b.id]))[0].fx_rate_id).not.toBe((await q("SELECT fx_rate_id FROM invoices WHERE id=$1", [a.id]))[0].fx_rate_id);
      } finally { await fxRate(db.admin, "12.50000000"); }
    });
    it("discounts are not carried over: the new invoice has none unless a super_admin newly grants one (with a reason and its own audit)", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const a = (await make(c, { itemIds: [i], discountUsd: "50.00", discountReason: "First deal" })).invoice;
      await cancel(a.id);
      const b = (await make(c, { itemIds: [i] }, admin)).invoice;
      expect((await q("SELECT discount_usd, discount_reason FROM invoices WHERE id=$1", [b.id]))[0]).toEqual({ discount_usd: "0.00", discount_reason: null });
      await cancel(b.id);
      expect(await code(make(c, { itemIds: [i], discountUsd: "50.00", discountReason: "First deal" }, staff))).toBe("NOT_AUTHORIZED");
      expect(await code(make(c, { itemIds: [i], discountUsd: "50.00" }, admin))).toBe("DISCOUNT_INVALID");
      const d = (await make(c, { itemIds: [i], discountUsd: "20.00", discountReason: "Second deal" }, admin)).invoice;
      expect((await q("SELECT discount_usd, discount_reason FROM invoices WHERE id=$1", [d.id]))[0]).toEqual({ discount_usd: "20.00", discount_reason: "Second deal" });
      expect((await q("SELECT discount_usd, discount_reason FROM invoices WHERE id=$1", [a.id]))[0]).toEqual({ discount_usd: "50.00", discount_reason: "First deal" });
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action='invoice.discount' AND entity_id = ANY($1)", [[a.id, d.id]]))[0].n).toBe(2);
    });
    it("a released carton is re-invoiced at its stored carton price and basis through the same flow; its history survives", async () => {
      const c = await customer(db.admin);
      const ct = await carton(db.admin, c, { price_usd: "175.00", rate_usd: "350.0000" }); const m = await item(db.admin, c, { carton_id: ct });
      const a = (await make(c, { itemIds: [], cartonIds: [ct] })).invoice;
      await cancel(a.id);
      const b = (await make(c, { itemIds: [], cartonIds: [ct] })).invoice;
      expect(b.subtotal_usd).toBe("175.00");
      expect((await q("SELECT status, invoice_id FROM cartons WHERE id=$1", [ct]))[0]).toEqual({ status: "invoiced", invoice_id: b.id });
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [m]))[0].invoice_id).toBe(b.id);
      expect((await q("SELECT carton_id FROM invoice_lines WHERE invoice_id=$1", [a.id]))[0].carton_id).toBe(ct);
    });
  });

  describe("Keepup", () => {
    it("records the cancellation locally without claiming a Keepup cancellation", async () => {
      const c = await customer(db.admin);
      const mk = async () => (await make(c, { itemIds: [await pricedItem(db.admin, c, "40.00")] })).invoice;
      const unsent = await mk(); await cancel(unsent.id);
      expect((await q("SELECT sync_state, keepup_sale_id, last_error FROM keepup_sync WHERE invoice_id=$1", [unsent.id]))[0]).toMatchObject({ sync_state: "cancelled", keepup_sale_id: null });
      const sold = await mk();
      await q("UPDATE keepup_sync SET sync_state='synced', keepup_sale_id='KU-555', external_status='open' WHERE invoice_id=$1", [sold.id]);
      await cancel(sold.id);
      const k = (await q("SELECT sync_state, keepup_sale_id, external_status, last_error FROM keepup_sync WHERE invoice_id=$1", [sold.id]))[0];
      expect(k).toMatchObject({ sync_state: "needs_reconciliation", keepup_sale_id: "KU-555", external_status: "open" });
      expect(k.last_error).toMatch(/NOT been cancelled in Keepup/);
      const unknown = await mk();
      await q("UPDATE keepup_sync SET sync_state='creating' WHERE invoice_id=$1", [unknown.id]);
      await cancel(unknown.id);
      expect((await q("SELECT sync_state FROM keepup_sync WHERE invoice_id=$1", [unknown.id]))[0].sync_state).toBe("needs_reconciliation");
    });
  });

  describe("direct-SQL protection", () => {
    it("cancelling an invoice by SQL without releasing its items and cartons cannot commit", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "40.00"); const ct = await carton(db.admin, c, { price_usd: "175.00" });
      const { invoice } = await make(c, { itemIds: [i], cartonIds: [ct] });
      const sql = "UPDATE invoices SET status='Cancelled', cancelled_at=now(), cancel_reason='sql only' WHERE id=$1";
      expect(await sqlstate(actorQuery(db.admin, user(admin)).query(sql, [invoice.id]))).toBe("MV005");
      expect((await q("SELECT status FROM invoices WHERE id=$1", [invoice.id]))[0].status).toBe("Pending");
      // through the runtime role as well
      expect(await code(withActorTransaction(db.app, user(admin), (tx) => tx.query(sql, [invoice.id])))).toBe("INVALID_STATE");
      expect((await q("SELECT status FROM invoices WHERE id=$1", [invoice.id]))[0].status).toBe("Pending");
    });
    it("nothing can be attached to a cancelled invoice, double-cancellation edits are blocked, and a cancelled invoice cannot take a payment", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "40.00"); const ct = await carton(db.admin, c, { price_usd: "175.00" });
      const { invoice } = await make(c, { itemIds: [i] });
      await cancel(invoice.id);
      const loose = await pricedItem(db.admin, c, "40.00");
      expect(await sqlstate(db.admin.query("UPDATE items SET invoice_id=$2 WHERE id=$1", [loose, invoice.id]))).toBe("MV005");
      expect(await sqlstate(actorQuery(db.app, user(admin)).query("UPDATE items SET invoice_id=$2 WHERE id=$1", [i, invoice.id]))).toBe("MV005");
      expect(await sqlstate(db.admin.query("UPDATE cartons SET status='invoiced', invoice_id=$2 WHERE id=$1", [ct, invoice.id]))).toBe("MV005");
      expect(await sqlstate(actorQuery(db.admin, user(admin)).query("UPDATE invoices SET cancel_reason='rewritten' WHERE id=$1", [invoice.id]))).toBe("MV004");
      expect(await sqlstate(actorQuery(db.admin, user(admin)).query("UPDATE invoices SET status='Pending', cancelled_at=NULL WHERE id=$1", [invoice.id]))).toBe("MV004");
      expect(await sqlstate(actorQuery(db.admin, user(admin)).query("INSERT INTO payments (invoice_id, amount_ghs) VALUES ($1, 1)", [invoice.id]))).toBe("MV005");
      // a released item can be invoiced again
      expect((await make(c, { itemIds: [i] })).invoice.status).toBe("Pending");
    });
    it("the legacy import actor may still record historical links to cancelled invoices", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "40.00");
      const { invoice } = await make(c, { itemIds: [i] });
      await cancel(invoice.id);
      const h = await pricedItem(db.admin, c, "40.00");
      expect(await sqlstate(actorQuery(db.admin, { type: "import" }).query("UPDATE items SET invoice_id=$2 WHERE id=$1", [h, invoice.id]))).toBe("OK");
    });
    it("a carton with member items cannot be dissolved and no item can enter a dissolved carton", async () => {
      const c = await customer(db.admin);
      const ct = await carton(db.admin, c, { price_usd: "175.00" }); const m = await item(db.admin, c, { carton_id: ct });
      expect(await sqlstate(db.admin.query("UPDATE cartons SET status='dissolved', dissolved_at=now() WHERE id=$1", [ct]))).toBe("MV005");
      await db.admin.query("UPDATE items SET carton_id=NULL WHERE id=$1", [m]);
      expect(await sqlstate(db.admin.query("UPDATE cartons SET status='dissolved', dissolved_at=now() WHERE id=$1", [ct]))).toBe("OK");
      expect(await sqlstate(db.admin.query("UPDATE items SET carton_id=$2 WHERE id=$1", [m, ct]))).toBe("MV005");
      expect(await sqlstate(item(db.admin, c, { carton_id: ct }))).toBe("MV005");
    });
  });

  describe("concurrency and rollback", () => {
    it("cancellation vs payment [payment wins]: the payment is accepted first, the cancellation then fails", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const { invoice } = await make(c, { itemIds: [i] });
      const holder = await db.admin.connect();
      try {
        await holder.query("BEGIN");
        const { beginActor } = await import("../../src/lib/db/actor");
        const { TEST_ACTOR_KEY } = await import("./helpers");
        await beginActor(holder, user(admin), TEST_ACTOR_KEY);
        await holder.query("INSERT INTO payments (invoice_id, amount_ghs) VALUES ($1, 100)", [invoice.id]);   // holds the invoice lock, uncommitted
        const c1 = code(cancel(invoice.id));
        await sleep(300);
        await holder.query("COMMIT");
        expect(await c1).toBe("ACTIVE_PAYMENT_EXISTS");
      } finally { await holder.query("ROLLBACK").catch(() => {}); holder.release(); }
      expect((await q("SELECT status, amount_paid_ghs FROM invoices WHERE id=$1", [invoice.id]))[0]).toEqual({ status: "Partial", amount_paid_ghs: "100.00" });
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [i]))[0].invoice_id).toBe(invoice.id);
    });
    it("cancellation vs payment [cancellation wins]: the payment is refused and nothing is recorded against the cancelled invoice", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const { invoice } = await make(c, { itemIds: [i] });
      await slowRelease(800);
      try {
        const cx = code(cancel(invoice.id));
        await sleep(300);                                   // the cancellation now holds the invoice lock
        const pay = code(recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "10.00", actor: user(admin), idempotencyKey: key() }));
        expect(await cx).toBe("OK");
        expect(await pay).toBe("INVALID_STATE");
      } finally { await normal(); }
      expect((await q("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoice.id]))[0].n).toBe(0);
      expect((await q("SELECT status, amount_paid_ghs FROM invoices WHERE id=$1", [invoice.id]))[0]).toEqual({ status: "Cancelled", amount_paid_ghs: "0.00" });
    });
    it("cancellation vs payment [20 random races]: never both a completed payment and a Cancelled invoice", async () => {
      const c = await customer(db.admin);
      const outcomes: string[] = [];
      for (let n = 0; n < 20; n++) {
        const { invoice } = await make(c, { itemIds: [await pricedItem(db.admin, c, "8.00")] });
        const [x, y] = await Promise.all([code(cancel(invoice.id)), code(recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "10.00", actor: user(admin), idempotencyKey: key() }))]);
        const st = (await q("SELECT status FROM invoices WHERE id=$1", [invoice.id]))[0].status;
        const pays = (await q("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1 AND status='completed'", [invoice.id]))[0].n;
        expect(st === "Cancelled" && pays > 0, `${x}/${y}`).toBe(false);
        expect([x, y].filter((r) => r === "OK").length, `${x}/${y}`).toBe(1);
        outcomes.push(`${x}/${y}`);
      }
      expect(outcomes.length).toBe(20);
    });
    it("cancellation vs re-invoice: a re-invoice started during the cancellation waits, then succeeds on the released item with CURRENT pricing; two competing re-invoices yield exactly one", async () => {
      const c = await customer(db.admin); const i = await unpriced(c); await price(i);
      const a = (await make(c, { itemIds: [i] })).invoice;
      await q("UPDATE package_rates SET rate_usd = 360 WHERE tier='basic' AND freight_type='sea'");
      await slowRelease(800);
      try {
        const cx = code(cancel(a.id));
        await sleep(300);
        // started while the cancellation is still in flight: the item is still invoiced as far as anyone else can see,
        // so both attempts fail cleanly (nothing partial) and are simply retried after the cancellation commits
        const early = [code(make(c, { itemIds: [i] })), code(make(c, { itemIds: [i] }))];
        expect(await cx).toBe("OK");
        expect(await Promise.all(early)).toEqual(["ITEM_ALREADY_INVOICED", "ITEM_ALREADY_INVOICED"]);
        expect((await q("SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1 AND status <> 'Cancelled'", [c]))[0].n).toBe(0);
        const res = [await code(make(c, { itemIds: [i] })), await code(make(c, { itemIds: [i] }))];   // sequential would be trivial: race them below
        expect(res).toEqual(["OK", "ITEM_ALREADY_INVOICED"]);
        const j = await pricedItem(db.admin, c, "40.00");
        const k2 = (await make(c, { itemIds: [j] })).invoice; await cancel(k2.id);
        const race = (await Promise.all([code(make(c, { itemIds: [j] })), code(make(c, { itemIds: [j] })), code(make(c, { itemIds: [j] }))])).sort();
        expect(race).toEqual(["ITEM_ALREADY_INVOICED", "ITEM_ALREADY_INVOICED", "OK"]);
      } finally { await normal(); await q("UPDATE package_rates SET rate_usd = 350 WHERE tier='basic' AND freight_type='sea'"); }
      const live = (await q("SELECT i.invoice_id, v.subtotal_usd FROM items i JOIN invoices v ON v.id = i.invoice_id WHERE i.id=$1", [i]))[0];
      expect(live.subtotal_usd).toBe("360.00");   // the rate in force at the re-invoice, not the cancelled invoice's 350
      expect((await q("SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1 AND status <> 'Cancelled'", [c]))[0].n).toBe(2);   // item i and item j each on exactly one live invoice
    });
    it("double cancellation: concurrent cancellations produce one logical cancellation (one release, one event set, one audit)", async () => {
      const c = await customer(db.admin);
      const a = await pricedItem(db.admin, c, "40.00"); const ct = await carton(db.admin, c, { price_usd: "175.00" }); const m = await item(db.admin, c, { carton_id: ct });
      const { invoice } = await make(c, { itemIds: [a], cartonIds: [ct] });
      const res = await Promise.all(Array.from({ length: 8 }, () => code(cancel(invoice.id))));
      expect(res.filter((r) => r === "OK")).toHaveLength(1);
      expect(res.filter((r) => r === "INVOICE_ALREADY_CANCELLED")).toHaveLength(7);
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='invoice.cancel'", [invoice.id]))[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM status_events WHERE entity_type='invoice' AND entity_id=$1 AND new_status='Cancelled'", [invoice.id]))[0].n).toBe(1);
      expect((await q("SELECT entity_id FROM status_events WHERE metadata->>'previous_invoice_id'=$1 ORDER BY entity_id", [invoice.id])).map((r) => r.entity_id).sort()).toEqual([a, m, ct].sort());
      // same idempotency key, in parallel: everyone gets the same answer, still one cancellation
      const d = await pricedItem(db.admin, c, "40.00");
      const inv2 = (await make(c, { itemIds: [d] })).invoice;
      const k = key();
      const res2 = await Promise.all(Array.from({ length: 8 }, () => cancel(inv2.id, { idempotencyKey: k })));
      expect(res2.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(res2.map((r) => r.releasedItemIds.join())).size).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='invoice.cancel'", [inv2.id]))[0].n).toBe(1);
    });
    it("cancellation vs carton mutation: a competing carton edit/dissolve waits for the cancellation and then sees a consistent released carton", async () => {
      const c = await customer(db.admin);
      const ct = await carton(db.admin, c, { price_usd: "175.00" }); const m = await item(db.admin, c, { carton_id: ct });
      const { invoice } = await make(c, { itemIds: [], cartonIds: [ct] });
      await slowRelease(800);
      try {
        const cx = code(cancel(invoice.id));
        await sleep(300);
        const edit = sqlstate(actorQuery(db.app, user(admin)).query("UPDATE cartons SET length = 120 WHERE id=$1", [ct]));                       // frozen while invoiced; legal once released
        const dissolve = sqlstate(actorQuery(db.app, user(admin)).query("UPDATE cartons SET status='dissolved', dissolved_at=now() WHERE id=$1", [ct]));
        expect(await cx).toBe("OK");
        const [e, d] = [await edit, await dissolve];
        expect(e).toBe("OK");
        expect(d).toBe("MV005");                                                                                          // members must leave the carton first
      } finally { await normal(); }
      expect((await q("SELECT status, invoice_id, length FROM cartons WHERE id=$1", [ct]))[0]).toEqual({ status: "open", invoice_id: null, length: "120.00" });
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [m]))[0].invoice_id).toBeNull();
      expect((await q("SELECT status FROM invoices WHERE id=$1", [invoice.id]))[0].status).toBe("Cancelled");
    });
    it("rollback: a failure after the invoice is cancelled and the carton released, before the items are released, undoes EVERYTHING", async () => {
      const c = await customer(db.admin);
      const a = await pricedItem(db.admin, c, "40.00"); const ct = await carton(db.admin, c, { price_usd: "175.00" }); const m = await item(db.admin, c, { carton_id: ct });
      const { invoice } = await make(c, { itemIds: [a], cartonIds: [ct] });
      const k = key();
      const cnt = async () => ({
        ev: (await q("SELECT count(*)::int AS n FROM status_events"))[0].n, au: (await q("SELECT count(*)::int AS n FROM audit_logs"))[0].n,
        keepup: (await q("SELECT sync_state FROM keepup_sync WHERE invoice_id=$1", [invoice.id]))[0].sync_state,
      });
      const before = await cnt();
      await q("CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END $$");
      await q("CREATE TRIGGER test_boom BEFORE UPDATE OF invoice_id ON items FOR EACH ROW WHEN (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NULL) EXECUTE FUNCTION test_boom()");
      try {
        const err = await cancel(invoice.id, { idempotencyKey: k }).catch((e) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect(String((err as Error).message)).toMatch(/injected failure/);
      } finally { await q("DROP TRIGGER test_boom ON items"); }
      expect((await q("SELECT status, cancelled_at, cancelled_by, cancel_reason FROM invoices WHERE id=$1", [invoice.id]))[0]).toEqual({ status: "Pending", cancelled_at: null, cancelled_by: null, cancel_reason: null });
      expect((await q("SELECT status, invoice_id FROM cartons WHERE id=$1", [ct]))[0]).toEqual({ status: "invoiced", invoice_id: invoice.id });
      expect((await q("SELECT id FROM items WHERE invoice_id=$1 ORDER BY id", [invoice.id])).map((r) => r.id).sort()).toEqual([a, m].sort());
      expect(await cnt()).toEqual(before);
      expect((await q("SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1", [k]))[0].n).toBe(0);
      // and the same request now works from a clean state
      expect((await cancel(invoice.id, { idempotencyKey: k })).replayed).toBe(false);
    });
    it("lock order: concurrent cancellations of invoices that share nothing, mixed with invoice creation over cartons and items, never deadlock", async () => {
      const c = await customer(db.admin);
      const invs = [];
      for (let n = 0; n < 6; n++) {
        const ct = await carton(db.admin, c, { price_usd: "175.00" }); await item(db.admin, c, { carton_id: ct });
        invs.push((await make(c, { itemIds: [await pricedItem(db.admin, c, "40.00")], cartonIds: [ct] })).invoice);
      }
      const spare = await Promise.all(Array.from({ length: 6 }, async () => {
        const ct = await carton(db.admin, c, { price_usd: "175.00" }); await item(db.admin, c, { carton_id: ct });
        return { i: await pricedItem(db.admin, c, "40.00"), ct };
      }));
      const results = await Promise.all([
        ...invs.map((v) => code(cancel(v.id))),
        ...spare.map((s) => code(make(c, { itemIds: [s.i], cartonIds: [s.ct] }))),
      ]);
      expect(results.every((r) => r === "OK"), results.join()).toBe(true);     // no deadlock (40P01), no lock timeout
    });
  });
});
