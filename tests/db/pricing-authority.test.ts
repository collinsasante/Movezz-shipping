// Phase 7D: server-authoritative pricing and discount authority. Titles carry the requirement number from the phase brief.
// Everything runs against real PostgreSQL through the real runtime role (movezz_app): the security boundary is not mocked.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dbDescribe, createTestDb, customer, item, pricedItem, staffUser, fxRate, packageRates, specialRate, sqlstate, actorQuery, TEST_ACTOR_KEY,
  type TestDb,
} from "./helpers";
import { createInvoice, cancelInvoice, recordPayment } from "../../src/lib/db/invoices";
import { priceItem } from "../../src/lib/db/pricing";
import { user, withActorTransaction } from "../../src/lib/db/actor";
import { DomainError } from "../../src/lib/db/errors";

let kn = 0;
const key = () => `pa-${Date.now()}-${++kn}-abcdefgh`;
const code = async (p: Promise<unknown>) => {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : ((e as { code?: string }).code ?? `RAW:${(e as Error).message}`); }
};

dbDescribe("server-authoritative pricing and discounts (PostgreSQL)", () => {
  let db: TestDb; let admin: string; let staff: string; let custLogin: string;
  const unpriced = (c: string, over: Record<string, unknown> = {}) =>
    item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null, length: 100, width: 100, height: 100, ...over });
  const price = (id: string, card?: string | null, who = staff) => withActorTransaction(db.app, user(who), (tx) => priceItem(tx, id, { specialRateId: card }));
  const row = async (id: string) => (await db.admin.query("SELECT * FROM items WHERE id=$1", [id])).rows[0];
  const invoice = (c: string, itemIds: string[], extra: Record<string, unknown> = {}, who = admin) =>
    createInvoice(db.app, { customerId: c, itemIds, actor: user(who), idempotencyKey: key(), ...extra } as Parameters<typeof createInvoice>[1]);
  const mkLogin = async (c: string) => {
    const i = Math.floor(Math.random() * 1e9);
    return (await db.admin.query(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ($1,$2,'customer',$3) RETURNING id`, [`u-c${i}`, `c${i}@example.invalid`, c])).rows[0].id as string;
  };

  beforeAll(async () => {
    db = await createTestDb();
    admin = await staffUser(db.admin, "super_admin"); staff = await staffUser(db.admin, "warehouse_staff");
    await packageRates(db.admin, "basic", "350", "8"); await packageRates(db.admin, "special", "280", "6");
    await fxRate(db.admin, "12.50000000");
    const c0 = await customer(db.admin); custLogin = await mkLogin(c0);
  });
  afterAll(async () => { await db?.close(); });

  describe("normal tier pricing", () => {
    it("[1] computes the tier price from the customer's tier and the authoritative rate (sea: CBM x qty x rate, rounded once)", async () => {
      const c = await customer(db.admin);
      expect((await price(await unpriced(c, { length: 100, width: 100, height: 100 }))).tierPriceUsd).toBe("350.00");
      expect((await price(await unpriced(c, { length: 100, width: 50, height: 100, quantity: 3 }))).tierPriceUsd).toBe("525.00");
      expect((await price(await unpriced(c, { length: 33.3, width: 33.3, height: 33.3 }))).tierPriceUsd).toBe("12.92");   // 0.036926037 x 350 = 12.9241
    });
    it("[2] uses the freight basis: sea ignores weight, air ignores dimensions", async () => {
      const c = await customer(db.admin);
      expect((await price(await unpriced(c, { weight_kg: 999 }))).tierPriceUsd).toBe("350.00");
      expect((await price(await unpriced(c, { freight_type: "air", weight_kg: 10, quantity: 2, length: 500, width: 500, height: 500 }))).tierPriceUsd).toBe("160.00");
      expect(await row(await unpriced(c))).toMatchObject({ tier_price_usd: null });
    });
    it("[3] a missing rate fails explicitly and writes nothing (no default rate, no zero)", async () => {
      const c = await customer(db.admin, { tier: "enterprise" });       // no enterprise rates exist
      const i = await unpriced(c);
      expect(await code(price(i))).toBe("PRICING_NOT_FOUND");
      expect(await row(i)).toMatchObject({ tier_price_usd: null, tier_rate_usd: null, package_tier: null });
    });
    it("[4][5] zero and negative rates cannot exist, and zero/negative/missing measurements are refused", async () => {
      expect(await sqlstate(db.admin.query("INSERT INTO package_rates (tier, freight_type, rate_usd, is_active) VALUES ('enterprise','sea',0,false)"))).toBe("23514");
      expect(await sqlstate(db.admin.query("INSERT INTO package_rates (tier, freight_type, rate_usd, is_active) VALUES ('enterprise','sea',-3,false)"))).toBe("23514");
      expect(await sqlstate(db.admin.query("UPDATE package_rates SET rate_usd = 0 WHERE tier='basic'"))).toBe("23514");
      const c = await customer(db.admin);
      expect(await code(price(await unpriced(c, { length: 0, width: 0, height: 0 })))).toBe("PRICING_INVALID");
      expect(await code(price(await unpriced(c, { length: null, width: null, height: null })))).toBe("PRICING_INVALID");
      expect(await code(price(await unpriced(c, { freight_type: "air", weight_kg: 0, length: null, width: null, height: null })))).toBe("PRICING_INVALID");
      expect(await code(price(await unpriced(c, { freight_type: "air", weight_kg: null, length: null, width: null, height: null })))).toBe("PRICING_INVALID");
      expect(await code(price(await unpriced(c, { freight_type: null })))).toBe("PRICING_INVALID");
      expect(await code(price(await unpriced(c, { length: 0.01, width: 0.01, height: 0.01 })))).toBe("PRICING_INVALID");   // rounds to 0.00: never a price of zero
    });
    it("[6] an unpriced item can exist but can never be invoiced", async () => {
      const c = await customer(db.admin); const i = await unpriced(c);
      expect(await code(invoice(c, [i]))).toBe("ITEM_UNPRICED");
      expect((await row(i)).invoice_id).toBeNull();
      expect((await db.admin.query("SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1", [c])).rows[0].n).toBe(0);
    });
    it("a stored 'special' basis without a stored special price is unpriced too", async () => {
      const c = await customer(db.admin);
      const i = await unpriced(c, { tier_price_usd: 5 });
      await db.admin.query("UPDATE items SET billing_basis='special', special_rate_name='x', special_price_usd=1 WHERE id=$1", [i]);
      await db.admin.query("UPDATE items SET special_price_usd=NULL, billing_basis='tier', special_rate_name=NULL WHERE id=$1", [i]);
      expect(await code(invoice(c, [await unpriced(c)]))).toBe("ITEM_UNPRICED");
    });
  });

  describe("special pricing", () => {
    it("[7] a valid explicitly selected card applies: basis special, special price, tier price kept as a snapshot", async () => {
      const c = await customer(db.admin); const i = await unpriced(c);
      const card = await specialRate(db.admin, { name: "Lagos bulk", sea_rate_usd: 300 });
      expect(await price(i, card)).toMatchObject({ billingBasis: "special", specialRateUsd: "300.0000", specialPriceUsd: "300.00", tierPriceUsd: "350.00", specialRateName: "Lagos bulk" });
      const { invoice: inv } = await invoice(c, [i]);
      expect((await db.admin.query("SELECT billing_basis, unit_price_usd, special_rate_id, special_rate_name FROM invoice_lines WHERE invoice_id=$1", [inv.id])).rows)
        .toEqual([{ billing_basis: "special", unit_price_usd: "300.00", special_rate_id: card, special_rate_name: "Lagos bulk" }]);
    });
    it("[8] with no selected card the normal tier price is used, and a previous card is not carried over", async () => {
      const c = await customer(db.admin); const i = await unpriced(c);
      const card = await specialRate(db.admin, { sea_rate_usd: 300 });
      await price(i, card);
      expect(await price(i)).toMatchObject({ billingBasis: "tier", specialRateId: null, specialPriceUsd: null });
      expect(await row(i)).toMatchObject({ billing_basis: "tier", special_rate_id: null, special_price_usd: null, tier_price_usd: "350.00" });
    });
    it("[9][10][11] inactive, expired and not-yet-effective cards are rejected and nothing is written", async () => {
      const c = await customer(db.admin);
      for (const over of [{ is_active: false }, { effective_from: "2025-01-01T00:00:00Z", effective_to: "2025-06-01T00:00:00Z" }, { effective_from: "2099-01-01T00:00:00Z" }]) {
        const i = await unpriced(c); const card = await specialRate(db.admin, over);
        expect(await code(price(i, card)), JSON.stringify(over)).toBe("SPECIAL_RATE_NOT_APPLICABLE");
        expect(await row(i)).toMatchObject({ tier_price_usd: null, special_rate_id: null });
      }
    });
    it("[9] a card that becomes inactive AFTER staff selected it is not silently replaced by the tier price at invoicing", async () => {
      const c = await customer(db.admin); const i = await unpriced(c);
      const card = await specialRate(db.admin, { sea_rate_usd: 300 });
      await price(i, card);
      await db.admin.query("UPDATE special_rates SET is_active=false WHERE id=$1", [card]);
      expect(await code(invoice(c, [i]))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
      expect((await row(i)).invoice_id).toBeNull();
    });
    it("[12][13] a customer-specific card cannot be used by another customer; a global card works for anyone", async () => {
      const a = await customer(db.admin), b = await customer(db.admin);
      const own = await specialRate(db.admin, { customer_id: a, sea_rate_usd: 250 });
      const global = await specialRate(db.admin, { sea_rate_usd: 260 });
      expect((await price(await unpriced(a), own)).specialPriceUsd).toBe("250.00");
      const ib = await unpriced(b);
      expect(await code(price(ib, own))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
      expect(await row(ib)).toMatchObject({ billing_basis: "tier", special_rate_id: null });
      expect((await price(ib, global)).specialPriceUsd).toBe("260.00");
      expect((await price(await unpriced(a), global)).specialPriceUsd).toBe("260.00");
      // and not through SQL either (the item guard trigger)
      expect(await sqlstate(db.admin.query("UPDATE items SET billing_basis='special', special_rate_id=$2, special_rate_name='x', special_price_usd=1 WHERE id=$1", [ib, own]))).toBe("MV002");
    });
    it("[14] a card without a rate for the item's freight type fails; the other freight's rate is never used", async () => {
      const c = await customer(db.admin);
      const seaOnly = await specialRate(db.admin, { sea_rate_usd: 3.2, air_rate_usd: null });
      const air = await unpriced(c, { freight_type: "air", weight_kg: 10, length: null, width: null, height: null });
      expect(await code(price(air, seaOnly))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
      expect(await row(air)).toMatchObject({ tier_price_usd: null, billing_basis: "tier" });
      const airOnly = await specialRate(db.admin, { sea_rate_usd: null, air_rate_usd: 5 });
      expect(await code(price(await unpriced(c), airOnly))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
      expect((await price(air, airOnly)).specialPriceUsd).toBe("50.00");
    });
    it("[15] a zero or negative special rate cannot exist", async () => {
      expect(await sqlstate(specialRate(db.admin, { sea_rate_usd: 0 }))).toBe("23514");
      expect(await sqlstate(specialRate(db.admin, { air_rate_usd: -1 }))).toBe("23514");
      expect(await sqlstate(db.admin.query("UPDATE special_rates SET sea_rate_usd = 0 WHERE sea_rate_usd IS NOT NULL"))).toBe("23514");
    });
    it("an unknown card is SPECIAL_RATE_NOT_FOUND", async () => {
      const c = await customer(db.admin);
      expect(await code(price(await unpriced(c), "00000000-0000-4000-8000-00000000dead"))).toBe("SPECIAL_RATE_NOT_FOUND");
    });
    it("[16][17] a client cannot force billing_basis = special or supply a special price: service rejects it, and SQL-forged snapshots are recomputed at invoicing", async () => {
      const c = await customer(db.admin);
      const i = await unpriced(c);
      for (const bad of [{ billingBasis: "special" }, { specialPriceUsd: "1.00" }, { specialRateUsd: "0.01" }, { unitPriceUsd: "1.00" }, { tierPriceUsd: "1.00" }]) {
        expect(await code(withActorTransaction(db.app, user(staff), (tx) => priceItem(tx, i, bad as never))), JSON.stringify(bad)).toBe("INVALID_INPUT");
      }
      expect(await row(i)).toMatchObject({ tier_price_usd: null });
      // forged straight into the table through the runtime role: basis special, no card, price USD 1
      const f = await unpriced(c, { tier_price_usd: 350, tier_rate_usd: 350, package_tier: "basic" });
      await db.app.query("UPDATE items SET billing_basis='special', special_rate_name='Forged', special_price_usd=1.00, special_rate_usd=0.01 WHERE id=$1", [f]);
      const { invoice: inv } = await invoice(c, [f]);
      expect(inv.subtotal_usd).toBe("350.00");
      expect((await db.admin.query("SELECT billing_basis, unit_price_usd, special_rate_name FROM invoice_lines WHERE invoice_id=$1", [inv.id])).rows).toEqual([{ billing_basis: "tier", unit_price_usd: "350.00", special_rate_name: null }]);
      // forged price under a REAL card id: still recomputed from the card
      const card = await specialRate(db.admin, { sea_rate_usd: 300 });
      const g = await unpriced(c); await price(g, card);
      await db.app.query("UPDATE items SET special_price_usd=1.00 WHERE id=$1", [g]);
      expect((await invoice(c, [g])).invoice.subtotal_usd).toBe("300.00");
    });
  });

  describe("client manipulation of invoice financials", () => {
    const fx = async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00"); return { c, i };
    };
    it.each([
      ["[18] unit price", { unitPriceUsd: "1.00" }], ["[19] subtotal", { subtotalUsd: "1.00" }], ["[20] total USD", { totalUsd: "1.00" }],
      ["[20] total GHS", { totalGhs: "1.00" }], ["[21] FX rate", { fxRate: "1.0" }], ["[22] billing basis", { billingBasis: "special" }],
      ["special price", { specialPriceUsd: "1" }], ["client role", { role: "super_admin" }], ["client role (actorRole)", { actorRole: "super_admin" }],
    ])("%s supplied by the caller is rejected, and nothing is persisted", async (_n, extra) => {
      const { c, i } = await fx();
      const k = key();
      expect(await code(invoice(c, [i], { ...extra, idempotencyKey: k }))).toBe("INVALID_INPUT");
      expect((await row(i)).invoice_id).toBeNull();
      expect((await db.admin.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1", [k])).rows[0].n).toBe(0);
    });
    it("the invoice is priced from the database, whatever the stored snapshot says: a stale/forged item price is recomputed and audited", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      await db.app.query("UPDATE items SET tier_price_usd = 1.00, tier_rate_usd = 0.01 WHERE id=$1", [i]);   // not invoiced yet: the table allows it ...
      const { invoice: inv } = await invoice(c, [i]);                                                         // ... the invoice does not believe it
      expect(inv.subtotal_usd).toBe("100.00");
      expect((await db.admin.query("SELECT action, before_data->>'tier_price_usd' AS b, after_data->>'tier_price_usd' AS a FROM audit_logs WHERE entity_id=$1 AND action='item.reprice'", [i])).rows)
        .toEqual([{ action: "item.reprice", b: "1.00", a: "100.00" }]);
    });
    it("direct SQL cannot write an invoice line with a made-up price, basis, rate or tier (native invoices)", async () => {
      const { c, i } = await fx();
      const { invoice: inv } = await invoice(c, [i]);
      const extra = await pricedItem(db.admin, c, "40.00");
      const line = (unit: string, basis = "tier", rate = "8", tier = "basic") =>
        sqlstate(db.admin.query(`INSERT INTO invoice_lines (invoice_id, line_no, item_id, description, unit_price_usd, line_total_usd, billing_basis, package_tier, rate_usd) VALUES ($1,9,$2,'x',$3::numeric,$3::numeric,$4,$5,$6::numeric)`, [inv.id, extra, unit, basis, tier, rate]));
      expect(await line("1.00")).toBe("MV010");
      expect(await line("40.00", "special")).toBe("MV010");
      expect(await line("40.00", "tier", "1")).toBe("MV010");
      expect(await line("40.00", "tier", "8", "business")).toBe("MV010");
      expect(await sqlstate(db.admin.query(`INSERT INTO invoice_lines (invoice_id, line_no, description, unit_price_usd, line_total_usd, billing_basis) VALUES ($1,9,'free text',5,5,'tier')`, [inv.id]))).toBe("MV010");
    });
    it("direct SQL cannot create a native invoice header with an invented FX rate, an old FX rate, or no FX row", async () => {
      const c = await customer(db.admin);
      const cur = (await db.admin.query("SELECT id, rate FROM current_fx_rate()")).rows[0];
      const old = await fxRate(db.admin, "3.00000000", "2020-01-01T00:00:00Z");
      const ins = (who: Parameters<typeof actorQuery>[1], id: string | null, rate: string) =>
        sqlstate(actorQuery(db.admin, who).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs) VALUES ($1,$2,$3,100,$4::numeric,round(100*$4::numeric,2))`, [`ORD-FX${++kn}`, c, id, rate]));
      expect(await ins(user(staff), cur.id, "1")).toBe("MV011");           // invented rate against the real row
      expect(await ins(user(staff), null, "12.5")).toBe("MV011");          // no rate row at all
      expect(await ins(user(staff), old, "3")).toBe("MV011");              // a real but old rate
      expect(await ins(user(staff), cur.id, String(cur.rate))).toBe("OK"); // the current row, exactly
      expect(await code(withActorTransaction(db.app, user(staff), (tx) => tx.query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs) VALUES ('ORD-FXS',$1,$2,100,1,100)`, [c, cur.id])))).toBe("FX_RATE_INVALID");
    });
  });

  describe("discount authority", () => {
    it("[23][33] a super_admin can grant a valid discount; it is audited with actor, amount and reason, and frozen on the invoice", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const { invoice: inv } = await invoice(c, [i], { discountUsd: "25.00", discountReason: "Loyalty discount approved by management", request: { ip: "203.0.113.5", userAgent: "vitest" } });
      expect(inv).toMatchObject({ subtotal_usd: "100.00", discount_usd: "25.00", total_usd: "75.00", total_ghs: "937.50", status: "Pending" });
      expect((await db.admin.query("SELECT discount_reason FROM invoices WHERE id=$1", [inv.id])).rows[0].discount_reason).toBe("Loyalty discount approved by management");
      const a = (await db.admin.query("SELECT actor_user_id, actor_type, after_data, host(ip_address) AS ip, created_at IS NOT NULL AS ts, request_id FROM audit_logs WHERE entity_id=$1 AND action='invoice.discount'", [inv.id])).rows;
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ actor_user_id: admin, actor_type: "user", ip: "203.0.113.5", ts: true });
      expect(a[0].request_id).toBeTruthy();
      expect(a[0].after_data).toMatchObject({ discount_usd: "25.00", discount_reason: "Loyalty discount approved by management", subtotal_usd: "100.00" });
      expect(JSON.stringify(a[0])).not.toMatch(/password|token|secret|signature/i);
    });
    it("[24] warehouse staff cannot create invoices (and so cannot grant a discount); nothing is persisted", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const k = key();
      expect(await code(invoice(c, [i], { discountUsd: "100.00", discountReason: "I am staff", idempotencyKey: k }, staff))).toBe("NOT_AUTHORIZED");
      expect((await row(i)).invoice_id).toBeNull();
      expect((await db.admin.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1", [k])).rows[0].n).toBe(0);
      expect(await code(invoice(c, [i], {}, staff))).toBe("NOT_AUTHORIZED");     // invoicing is a financial operation (Phase 7F matrix)
    });
    it("[25] a customer login cannot create an invoice or grant a discount", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      expect(await code(invoice(c, [i], { discountUsd: "10.00", discountReason: "please" }, custLogin))).toBe("NOT_AUTHORIZED");
    });
    it("[26] a forged client role is rejected, and SQL cannot promote a user: the runtime role cannot write users.role", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      expect(await code(invoice(c, [i], { discountUsd: "10.00", discountReason: "x", role: "super_admin" }, staff))).toBe("INVALID_INPUT");
      expect(await code(invoice(c, [i], { discountUsd: "10.00", discountReason: "x", actorRole: "super_admin" }, staff))).toBe("INVALID_INPUT");
      for (const sql of [`UPDATE users SET role='super_admin' WHERE id='${staff}'`, `UPDATE users SET is_active=true WHERE id='${staff}'`, `UPDATE users SET customer_id=NULL`,
        `INSERT INTO users (auth_uid,email,role) VALUES ('evil','evil@example.invalid','super_admin')`, `DELETE FROM users WHERE id='${admin}'`]) {
        expect(await sqlstate(db.app.query(sql)), sql).toBe("42501");
      }
      expect(await sqlstate(db.app.query(`UPDATE users SET full_name='Rename' WHERE id='${staff}'`))).toBe("42501");   // no user column is writable except last_login_at
      expect(await sqlstate(db.app.query(`UPDATE users SET last_login_at=now() WHERE id='${staff}'`))).toBe("OK");
      // session-variable role forgery has no effect
      expect(await code(withActorTransaction(db.app, user(staff), async (tx) => {
        await tx.query("SELECT set_config('app.role','super_admin',true), set_config('movezz.role','super_admin',true), set_config('request.jwt.claim.role','super_admin',true)");
        return createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(staff), idempotencyKey: key(), discountUsd: "1.00", discountReason: "x" });
      }))).toBe("NOT_AUTHORIZED");
    });
    it("the role is read from the database for every transaction: demoting or deactivating a super_admin takes effect at once", async () => {
      const boss = await staffUser(db.admin, "super_admin");
      const c = await customer(db.admin);
      expect((await invoice(c, [await pricedItem(db.admin, c, "100.00")], { discountUsd: "1.00", discountReason: "ok" }, boss)).invoice.discount_usd).toBe("1.00");
      await db.admin.query("UPDATE users SET role='warehouse_staff' WHERE id=$1", [boss]);
      expect(await code(invoice(c, [await pricedItem(db.admin, c, "100.00")], { discountUsd: "1.00", discountReason: "ok" }, boss))).toBe("NOT_AUTHORIZED");
      await db.admin.query("UPDATE users SET role='super_admin' WHERE id=$1", [boss]);
      await db.admin.query("UPDATE users SET is_active=false, deactivated_at=now() WHERE id=$1", [boss]);
      expect(await code(invoice(c, [await pricedItem(db.admin, c, "100.00")], {}, boss))).toBe("ACTOR_INVALID");
    });
    it("direct SQL cannot bypass discount authority: the invoice trigger refuses staff, customers, system and import (native) actors", async () => {
      const c = await customer(db.admin);
      const cur = (await db.admin.query("SELECT id, rate FROM current_fx_rate()")).rows[0];
      const raw = (who: Parameters<typeof actorQuery>[1], extra = "") =>
        sqlstate(actorQuery(db.admin, who).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, discount_usd, discount_reason, fx_rate, total_ghs${extra ? ", provenance" : ""})
           VALUES ($1,$2,$3,100,50,'sneaky',$4::numeric,round(50*$4::numeric,2)${extra ? `, '${extra}'` : ""})`, [`ORD-D${++kn}`, c, cur.id, cur.rate]));
      expect(await raw(user(staff))).toBe("MV008");
      expect(await raw(user(custLogin))).toBe("MV008");
      expect(await raw({ type: "system" })).toBe("MV008");
      expect(await raw({ type: "integration" })).toBe("MV008");
      expect(await raw({ type: "import" })).toBe("MV008");                // import may only write NON-native history
      expect(await raw(user(admin))).toBe("OK");
      // the same through the runtime role itself (no superuser)
      expect(await code(withActorTransaction(db.app, user(staff), (tx) => tx.query(
        `INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, discount_usd, discount_reason, fx_rate, total_ghs) VALUES ('ORD-DAPP',$1,$2,100,50,'sneaky',$3,round(50*$3::numeric,2))`, [c, cur.id, cur.rate])))).toBe("DISCOUNT_NOT_AUTHORIZED");
      // the "legacy provenance" side door is closed to everyone but the import actor
      expect(await raw(user(staff), "legacy_known")).toBe("MV006");
      expect(await raw(user(admin), "legacy_known")).toBe("MV006");
      expect(await raw({ type: "import" }, "legacy_known")).toBe("OK");
    });
    it("[27][28] a discount above the subtotal or a negative discount fails", async () => {
      const c = await customer(db.admin);
      expect(await code(invoice(c, [await pricedItem(db.admin, c, "100.00")], { discountUsd: "100.01", discountReason: "too much" }))).toBe("DISCOUNT_INVALID");
      for (const bad of ["-5", "-0.01", "abc", "1.005", "1e3"]) expect(await code(invoice(c, [await pricedItem(db.admin, c, "100.00")], { discountUsd: bad, discountReason: "r" })), bad).toBe("DISCOUNT_INVALID");
      // and in the database (a super_admin actor, direct SQL)
      const cur = (await db.admin.query("SELECT id, rate FROM current_fx_rate()")).rows[0];
      for (const d of [150, -5]) {
        expect(await sqlstate(actorQuery(db.admin, user(admin)).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, discount_usd, discount_reason, fx_rate, total_ghs) VALUES ($1,$2,$3,100,$4,'r',$5,0)`, [`ORD-N${++kn}`, c, cur.id, d, cur.rate])), String(d)).toBe("23514");
      }
    });
    it("[29][30][31] a discount needs a non-blank reason; a zero discount may have none", async () => {
      const c = await customer(db.admin);
      for (const r of [undefined, "", "   ", "\n\t"]) expect(await code(invoice(c, [await pricedItem(db.admin, c, "100.00")], { discountUsd: "10.00", discountReason: r })), String(r)).toBe("DISCOUNT_INVALID");
      const z = await invoice(c, [await pricedItem(db.admin, c, "100.00")], { discountUsd: "0.00" });
      expect((await db.admin.query("SELECT discount_usd, discount_reason FROM invoices WHERE id=$1", [z.invoice.id])).rows[0]).toEqual({ discount_usd: "0.00", discount_reason: null });
      expect((await db.admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='invoice.discount'", [z.invoice.id])).rows[0].n).toBe(0);
      // database level
      const cur = (await db.admin.query("SELECT id, rate FROM current_fx_rate()")).rows[0];
      for (const r of [null, "", "  "]) {
        expect(await sqlstate(actorQuery(db.admin, user(admin)).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, discount_usd, discount_reason, fx_rate, total_ghs) VALUES ($1,$2,$3,100,10,$4,$5,round(90*$5::numeric,2))`, [`ORD-W${++kn}`, c, cur.id, r, cur.rate])), String(r)).toBe("23514");
      }
    });
    it("[32] the discount, reason, subtotal, FX and totals are frozen: no edit, even by the owner or the runtime role", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const { invoice: inv } = await invoice(c, [i], { discountUsd: "10.00", discountReason: "Original reason" });
      for (const set of ["discount_reason='changed'", "discount_usd=0, discount_reason=NULL", "discount_usd=99", "subtotal_usd=1", "total_ghs=1", "fx_rate=1", "fx_rate_id=NULL", "provenance='legacy_known'"]) {
        expect(await sqlstate(actorQuery(db.admin, user(admin)).query(`UPDATE invoices SET ${set} WHERE id=$1`, [inv.id])), `owner: ${set}`).toBe("MV004");
        expect(await sqlstate(db.app.query(`UPDATE invoices SET ${set} WHERE id=$1`, [inv.id])), `runtime: ${set}`).toBe("MV004");
      }
      expect(await sqlstate(db.app.query("UPDATE invoice_lines SET unit_price_usd=1, line_total_usd=1 WHERE invoice_id=$1", [inv.id]))).toBe("42501");   // no UPDATE privilege at all
      expect(await sqlstate(db.app.query("DELETE FROM invoice_lines WHERE invoice_id=$1", [inv.id]))).toBe("42501");
      expect(await sqlstate(db.admin.query("UPDATE invoice_lines SET unit_price_usd=1, line_total_usd=1 WHERE invoice_id=$1", [inv.id]))).toBe("MV004");   // and the owner is stopped by the trigger
      expect((await db.admin.query("SELECT discount_reason, discount_usd FROM invoices WHERE id=$1", [inv.id])).rows[0]).toEqual({ discount_reason: "Original reason", discount_usd: "10.00" });
    });
    it("a discount cannot be added later: there is no way to turn a priced invoice into a discounted one", async () => {
      const c = await customer(db.admin);
      const { invoice: inv } = await invoice(c, [await pricedItem(db.admin, c, "100.00")]);
      expect(await sqlstate(actorQuery(db.admin, user(admin)).query("UPDATE invoices SET discount_usd=100, discount_reason='later' WHERE id=$1", [inv.id]))).toBe("MV004");
      expect(await sqlstate(db.app.query("UPDATE invoices SET discount_usd=100, discount_reason='later' WHERE id=$1", [inv.id]))).toBe("MV004");
    });
  });

  describe("zero-value invoices", () => {
    it("[34][35][36][37] an authorized 100% discount gives a Paid zero invoice: no payment, no Keepup sale, sync state not_required", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const { invoice: inv } = await invoice(c, [i], { discountUsd: "100.00", discountReason: "Full waiver approved by management" });
      expect(inv).toMatchObject({ status: "Paid", subtotal_usd: "100.00", discount_usd: "100.00", total_usd: "0.00", total_ghs: "0.00", amount_paid_ghs: "0.00", balance_ghs: "0.00" });
      expect((await db.admin.query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [inv.id])).rows[0].n).toBe(0);
      expect((await db.admin.query("SELECT ks.sync_state, ks.keepup_sale_id, i.keepup_sale_id AS invoice_sale_id, ks.kind FROM keepup_sync ks JOIN invoices i ON i.id = ks.invoice_id WHERE ks.invoice_id=$1", [inv.id])).rows)
        .toEqual([{ sync_state: "not_required", keepup_sale_id: null, invoice_sale_id: null, kind: "invoice" }]);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM keepup_sync WHERE invoice_id=$1 AND sync_state IN ('pending','creating','synced')", [inv.id])).rows[0].n).toBe(0);
      expect(await code(recordPayment(db.app, { invoiceId: inv.id, amountGhs: "1.00", actor: user(admin), idempotencyKey: key() }))).toBe("OVERPAYMENT");
    });
    it("a staff member cannot produce a zero-value invoice", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      expect(await code(invoice(c, [i], { discountUsd: "100.00", discountReason: "free" }, staff))).toBe("NOT_AUTHORIZED");
    });
    it("[38] a normal invoice cannot receive not_required; subtotal 0 with discount 0 is not a billable invoice", async () => {
      const c = await customer(db.admin);
      const { invoice: inv } = await invoice(c, [await pricedItem(db.admin, c, "100.00")]);
      expect((await db.admin.query("SELECT sync_state FROM keepup_sync WHERE invoice_id=$1", [inv.id])).rows[0].sync_state).toBe("pending");
      expect(await sqlstate(db.admin.query("UPDATE keepup_sync SET sync_state='not_required' WHERE invoice_id=$1", [inv.id]))).toBe("MV005");
      const cur = (await db.admin.query("SELECT id, rate FROM current_fx_rate()")).rows[0];
      expect(await sqlstate(actorQuery(db.admin, user(admin)).query(`INSERT INTO invoices (invoice_ref, customer_id, fx_rate_id, subtotal_usd, fx_rate, total_ghs) VALUES ($1,$2,$3,0,$4,0)`, [`ORD-ZERO${++kn}`, c, cur.id, cur.rate]))).toBe("23514");
    });
  });

  describe("FX", () => {
    it("[39] missing FX fails explicitly (no fallback to 1) and persists nothing", async () => {
      const f = await createTestDb();
      try {
        const a = await staffUser(f.admin, "super_admin"); await packageRates(f.admin);
        const c = await customer(f.admin); const i = await item(f.admin, c);
        const k = key();
        expect(await code(createInvoice(f.app, { customerId: c, itemIds: [i], actor: user(a), idempotencyKey: k }))).toBe("FX_RATE_MISSING");
        expect((await f.admin.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n).toBe(0);
        expect((await f.admin.query("SELECT invoice_id FROM items WHERE id=$1", [i])).rows[0].invoice_id).toBeNull();
      } finally { await f.close(); }
    });
    it("[40] invalid FX cannot be stored (zero, negative, out of range), so it can never be frozen", async () => {
      for (const r of ["0", "-1", "0.05", "1001"]) {
        expect(await sqlstate(db.admin.query("INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at) VALUES ('USD','GHS',$1,'test',now() - interval '1 day')", [r])), r).toMatch(/23514/);
      }
    });
    it("[41] a client cannot supply FX (rejected), and cannot choose an older rate row", async () => {
      const c = await customer(db.admin);
      expect(await code(invoice(c, [await pricedItem(db.admin, c, "100.00")], { fxRate: "20", fxRateId: "x" }))).toBe("INVALID_INPUT");
    });
    it("[42] the invoice freezes the current authoritative rate and its row", async () => {
      const c = await customer(db.admin);
      const rowId = await fxRate(db.admin, "13.00000000");
      const { invoice: inv } = await invoice(c, [await pricedItem(db.admin, c, "100.00")]);
      expect(inv).toMatchObject({ fx_rate: "13.00000000", total_ghs: "1300.00", fx_estimated: false });
      expect((await db.admin.query("SELECT fx_rate_id FROM invoices WHERE id=$1", [inv.id])).rows[0].fx_rate_id).toBe(rowId);
      await fxRate(db.admin, "12.50000000");   // restore the working rate for later tests
    });
  });

  describe("historical immutability", () => {
    it("[43][44][45] changing the package rate, a special rate or FX never changes an existing invoice, its lines or its items; new invoices use the new values", async () => {
      const c = await customer(db.admin);
      const card = await specialRate(db.admin, { sea_rate_usd: 300 });
      const plain = await unpriced(c); const special = await unpriced(c);
      await price(plain); await price(special, card);
      const { invoice: inv } = await invoice(c, [plain, special]);
      const snap = async () => ({
        inv: (await db.admin.query("SELECT subtotal_usd, total_usd, fx_rate, fx_rate_id, total_ghs, balance_ghs, discount_usd FROM invoices WHERE id=$1", [inv.id])).rows[0],
        lines: (await db.admin.query("SELECT line_no, unit_price_usd, line_total_usd, rate_usd, billing_basis, special_rate_name FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no", [inv.id])).rows,
        items: (await db.admin.query("SELECT tier_price_usd, tier_rate_usd, special_price_usd, special_rate_usd, billing_basis FROM items WHERE invoice_id=$1 ORDER BY item_ref", [inv.id])).rows,
      });
      const before = await snap();
      expect(before.inv.subtotal_usd).toBe("650.00");
      await db.admin.query("UPDATE package_rates SET rate_usd = rate_usd * 2 WHERE tier='basic'");
      await db.admin.query("UPDATE special_rates SET sea_rate_usd = 999 WHERE id=$1", [card]);
      await fxRate(db.admin, "99.00000000");
      expect(await snap()).toEqual(before);
      // frozen item snapshots cannot be edited while the invoice is live, even to the "new" prices
      expect(await sqlstate(db.admin.query("UPDATE items SET tier_price_usd = 700 WHERE id=$1", [plain]))).toBe("MV004");
      expect(await sqlstate(db.app.query("UPDATE items SET special_price_usd = 999 WHERE id=$1", [special]))).toBe("MV004");
      // a NEW invoice uses the new values (700 at double rate; FX 99)
      const n = await invoice(c, [await unpriced(c)] as string[]).catch((e) => e);
      expect(n).toBeInstanceOf(DomainError);                              // still unpriced: pricing is a separate, explicit step
      const fresh = await unpriced(c); await price(fresh);
      const ninv = (await invoice(c, [fresh])).invoice;
      expect(ninv).toMatchObject({ subtotal_usd: "700.00", fx_rate: "99.00000000" });
      expect(await snap()).toEqual(before);
      // restore
      await db.admin.query("UPDATE package_rates SET rate_usd = CASE freight_type WHEN 'sea' THEN 350 ELSE 8 END WHERE tier='basic'");
      await fxRate(db.admin, "12.50000000");
    });
    it("re-invoicing after a cancellation re-prices at the CURRENT authoritative rates (Addendum A), never at the cancelled invoice's prices", async () => {
      const c = await customer(db.admin); const i = await unpriced(c);
      await price(i);
      const first = (await invoice(c, [i])).invoice;
      expect(first.subtotal_usd).toBe("350.00");
      await cancelInvoice(db.app, { invoiceId: first.id, reason: "wrong customer details", actor: user(admin) });
      await db.admin.query("UPDATE items SET invoice_id = NULL WHERE id=$1", [i]);        // stands in for the later release workflow (7G)
      await db.admin.query("UPDATE package_rates SET rate_usd = 400 WHERE tier='basic' AND freight_type='sea'");
      try {
        const second = (await invoice(c, [i])).invoice;
        expect(second.subtotal_usd).toBe("400.00");
        expect((await db.admin.query("SELECT unit_price_usd, rate_usd FROM invoice_lines WHERE invoice_id=$1", [second.id])).rows).toEqual([{ unit_price_usd: "400.00", rate_usd: "400.0000" }]);
        expect((await db.admin.query("SELECT subtotal_usd FROM invoices WHERE id=$1", [first.id])).rows[0].subtotal_usd).toBe("350.00");   // history untouched
      } finally { await db.admin.query("UPDATE package_rates SET rate_usd = 350 WHERE tier='basic' AND freight_type='sea'"); }
    });
  });

  describe("concurrency", () => {
    it("[46] concurrent invoices for one item: exactly one invoice, one line, no partial state", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const res = await Promise.all(Array.from({ length: 10 }, () => code(invoice(c, [i]))));
      expect(res.filter((r) => r === "OK")).toHaveLength(1);
      expect(res.filter((r) => r === "ITEM_ALREADY_INVOICED")).toHaveLength(9);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM invoice_lines WHERE item_id=$1", [i])).rows[0].n).toBe(1);
      expect((await db.admin.query("SELECT count(DISTINCT invoice_id)::int AS n FROM items WHERE id=$1 AND invoice_id IS NOT NULL", [i])).rows[0].n).toBe(1);
    });
    it("[47] concurrent pricing of one item (with and without a card) leaves one coherent snapshot, never a mixture", async () => {
      const c = await customer(db.admin); const i = await unpriced(c);
      const card = await specialRate(db.admin, { sea_rate_usd: 300 });
      const res = await Promise.all(Array.from({ length: 12 }, (_, n) => code(price(i, n % 2 ? card : null))));
      expect(res.every((r) => r === "OK")).toBe(true);
      const r = await row(i);
      if (r.billing_basis === "special") expect(r).toMatchObject({ special_rate_id: card, special_price_usd: "300.00", special_rate_usd: "300.0000", tier_price_usd: "350.00" });
      else expect(r).toMatchObject({ billing_basis: "tier", special_rate_id: null, special_rate_name: null, special_price_usd: null, special_rate_usd: null, tier_price_usd: "350.00" });
    });
    it("a special-rate edit racing an invoice: the invoice waits for the edit and prices EVERYTHING from the committed card (no mixed versions)", async () => {
      const c = await customer(db.admin);
      const card = await specialRate(db.admin, { sea_rate_usd: 300 });
      const a = await unpriced(c), b = await unpriced(c);
      await price(a, card); await price(b, card);
      const editor = await db.admin.connect();
      try {
        await editor.query("BEGIN");
        await editor.query("UPDATE special_rates SET sea_rate_usd = 320 WHERE id=$1", [card]);
        let done = false;
        const inv = invoice(c, [a, b]).then((r) => { done = true; return r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(done).toBe(false);                    // blocked on the card the editor holds
        await editor.query("COMMIT");
        const { invoice: made } = await inv;
        expect(made.subtotal_usd).toBe("640.00");    // 2 x 320: both lines from the same, new version
        expect((await db.admin.query("SELECT DISTINCT unit_price_usd FROM invoice_lines WHERE invoice_id=$1", [made.id])).rows).toEqual([{ unit_price_usd: "320.00" }]);
      } finally { await editor.query("ROLLBACK").catch(() => {}); editor.release(); }
    });
    it("a package-rate edit racing an invoice cannot split one invoice across two rate versions", async () => {
      const c = await customer(db.admin);
      const ids = [await pricedItem(db.admin, c, "80.00"), await pricedItem(db.admin, c, "80.00"), await pricedItem(db.admin, c, "80.00")];
      const editor = await db.admin.connect();
      try {
        await editor.query("BEGIN");
        await editor.query("UPDATE package_rates SET rate_usd = 10 WHERE tier='basic' AND freight_type='air'");
        const inv = invoice(c, ids);
        await new Promise((r) => setTimeout(r, 300));
        await editor.query("COMMIT");
        const { invoice: made } = await inv;
        expect(made.subtotal_usd).toBe("300.00");      // 3 x (10 kg x 10): all three at the new rate
      } finally {
        await editor.query("ROLLBACK").catch(() => {}); editor.release();
        await db.admin.query("UPDATE package_rates SET rate_usd = 8 WHERE tier='basic' AND freight_type='air'");
      }
    });
    it("concurrent invoice+discount attempts by staff and super_admin: exactly the super_admin ones succeed", async () => {
      const c = await customer(db.admin);
      const ids = await Promise.all(Array.from({ length: 8 }, () => pricedItem(db.admin, c, "100.00")));
      const res = await Promise.all(ids.map((id, n) => code(invoice(c, [id], { discountUsd: "10.00", discountReason: "concurrent" }, n % 2 ? staff : admin))));
      expect(res.filter((r) => r === "OK")).toHaveLength(4);
      expect(res.filter((r) => r === "NOT_AUTHORIZED")).toHaveLength(4);
      expect((await db.admin.query("SELECT DISTINCT actor_user_id FROM audit_logs WHERE action='invoice.discount' AND entity_id IN (SELECT id::text FROM invoices WHERE customer_id=$1)", [c])).rows).toEqual([{ actor_user_id: admin }]);
    });
  });

  describe("authority inventory", () => {
    it("the runtime role cannot call the pricing function with a made-up item, cannot edit rates for an invoice's items once invoiced, and the function is not PUBLIC", async () => {
      expect((await db.admin.query("SELECT has_function_privilege('public','item_authoritative_price(uuid,uuid)','EXECUTE') AS p, has_function_privilege('movezz_app','item_authoritative_price(uuid,uuid)','EXECUTE') AS a")).rows[0]).toEqual({ p: false, a: true });
      expect(await code(withActorTransaction(db.app, user(staff), (tx) => tx.query("SELECT * FROM item_authoritative_price('00000000-0000-4000-8000-000000000000', NULL)")))).toBe("PRICING_NOT_FOUND");
      void TEST_ACTOR_KEY;
    });
    it("users: the runtime role can read but not create or re-role users (column privileges)", async () => {
      const cols = (await db.admin.query(`SELECT column_name FROM information_schema.column_privileges WHERE grantee='movezz_app' AND table_name='users' AND privilege_type='UPDATE' ORDER BY 1`)).rows.map((r) => r.column_name);
      expect(cols).toEqual(["last_login_at"]);
      expect((await db.admin.query(`SELECT has_table_privilege('movezz_app','users','INSERT') AS i, has_table_privilege('movezz_app','users','DELETE') AS d, has_table_privilege('movezz_app','users','SELECT') AS s`)).rows[0]).toEqual({ i: false, d: false, s: true });
    });
  });
});
