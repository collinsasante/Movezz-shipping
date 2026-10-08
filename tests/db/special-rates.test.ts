// Special rate cards are OPTIONAL named USD price lists that staff select explicitly; the server validates the selection.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbDescribe, createTestDb, customer, item, specialRate, packageRates, sqlstate, staffUser, type TestDb } from "./helpers";
import { priceItem } from "../../src/lib/db/pricing";
import { DomainError } from "../../src/lib/db/errors";
import { withActorTransaction, user } from "../../src/lib/db/actor";

async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : `RAW:${(e as Error).message}`; }
}
const row = async (db: TestDb, id: string) => (await db.admin.query("SELECT * FROM items WHERE id=$1", [id])).rows[0];
const bare = (db: TestDb, c: string, over: Record<string, unknown> = {}) =>
  item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null, length: 100, width: 100, height: 100, ...over });
let actor: string;
const price = (db: TestDb, id: string, specialRateId?: string) => withActorTransaction(db.app, user(actor), (tx) => priceItem(tx, id, { specialRateId }));

dbDescribe("special rates (PostgreSQL)", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); actor = await staffUser(db.admin); await packageRates(db.admin, "basic", "350", "8"); await packageRates(db.admin, "special", "280", "6"); });
  afterAll(async () => { await db?.close(); });

  it("special rates are OPTIONAL: no card exists and items are priced at the tier rate", async () => {
    expect((await db.admin.query("SELECT count(*)::int AS n FROM special_rates")).rows[0].n).toBe(0);
    const c = await customer(db.admin); const i = await bare(db, c);
    const r = await price(db, i);
    expect(r).toMatchObject({ billingBasis: "tier", tierRateUsd: "350.0000", tierPriceUsd: "350.00", specialPriceUsd: null });
    expect(await row(db, i)).toMatchObject({ billing_basis: "tier", special_rate_id: null, special_rate_name: null, special_price_usd: null });
  });

  it("tier pricing: sea = CBM x quantity x rate, air = kg x quantity x rate, rounded once", async () => {
    const c = await customer(db.admin);
    const sea = await bare(db, c, { length: 50, width: 40, height: 30, quantity: 3 });   // 0.18 m3
    expect((await price(db, sea)).tierPriceUsd).toBe("63.00");                              // 0.18 * 350
    const air = await bare(db, c, { freight_type: "air", weight_kg: 5, quantity: 2, length: null, width: null, height: null });
    expect((await price(db, air)).tierPriceUsd).toBe("80.00");                              // 10 kg * 8
  });

  it("the 'special' PACKAGE TIER is a separate concept from special rate cards", async () => {
    const c = await customer(db.admin, { tier: "special" });
    const i = await bare(db, c);
    const r = await price(db, i);
    expect(r).toMatchObject({ billingBasis: "tier", tierRateUsd: "280.0000", tierPriceUsd: "280.00" });
    expect((await row(db, i)).package_tier).toBe("special");
  });

  it("a valid GLOBAL card applies when staff select it: basis special, special price stored, tier price kept", async () => {
    const c = await customer(db.admin); const i = await bare(db, c);
    const card = await specialRate(db.admin, { name: "Bulk Lagos", sea_rate_usd: 300 });
    const r = await price(db, i, card);
    expect(r).toMatchObject({ billingBasis: "special", specialRateUsd: "300.0000", specialPriceUsd: "300.00", tierPriceUsd: "350.00" });
    expect(await row(db, i)).toMatchObject({ billing_basis: "special", special_rate_id: card, special_rate_name: "Bulk Lagos", special_price_usd: "300.00" });
  });

  it("a card scoped to this customer applies; the same card is refused for another customer", async () => {
    const a = await customer(db.admin), b = await customer(db.admin);
    const card = await specialRate(db.admin, { name: "Only A", customer_id: a, sea_rate_usd: 250 });
    expect((await price(db, await bare(db, a), card)).specialPriceUsd).toBe("250.00");
    const ib = await bare(db, b);
    expect(await code(price(db, ib, card))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
    expect((await row(db, ib)).billing_basis).toBe("tier"); // nothing was written
  });

  it.each([
    ["inactive", { is_active: false }],
    ["expired", { effective_from: "2025-01-01T00:00:00Z", effective_to: "2025-06-01T00:00:00Z" }],
    ["not yet effective", { effective_from: "2099-01-01T00:00:00Z" }],
  ])("a %s card is rejected and the item keeps its tier pricing", async (_label, over) => {
    const c = await customer(db.admin); const i = await bare(db, c);
    const card = await specialRate(db.admin, over);
    expect(await code(price(db, i, card))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
    expect(await row(db, i)).toMatchObject({ billing_basis: "tier", special_rate_id: null });
  });

  it("an unknown card id is rejected", async () => {
    const c = await customer(db.admin);
    expect(await code(price(db, await bare(db, c), "00000000-0000-0000-0000-00000000dead"))).toBe("SPECIAL_RATE_NOT_APPLICABLE");
  });

  it("the database refuses an inapplicable card even if SQL bypasses the service (insert and update)", async () => {
    const a = await customer(db.admin), b = await customer(db.admin);
    const card = await specialRate(db.admin, { customer_id: a });
    expect(await sqlstate(item(db.admin, b, { billing_basis: "special", special_rate_id: card, special_rate_name: "x", special_price_usd: 1 }))).toBe("MV002");
    const ib = await bare(db, b);
    expect(await sqlstate(db.admin.query("UPDATE items SET billing_basis='special', special_rate_id=$2, special_rate_name='x', special_price_usd=1 WHERE id=$1", [ib, card]))).toBe("MV002");
  });

  it("a client cannot make a tier item look special: tier basis with a card id is a constraint violation", async () => {
    const c = await customer(db.admin); const card = await specialRate(db.admin, {});
    expect(await sqlstate(item(db.admin, c, { billing_basis: "tier", special_rate_id: card }))).toBe("23514");
  });

  it("uniqueness: no two ACTIVE overlapping cards share (name, customer) - including GLOBAL cards (NULL customer)", async () => {
    await specialRate(db.admin, { name: "Dup" });
    expect(await sqlstate(specialRate(db.admin, { name: "Dup" }))).toBe("23P01");
    const a = await customer(db.admin);
    await specialRate(db.admin, { name: "DupA", customer_id: a });
    expect(await sqlstate(specialRate(db.admin, { name: "DupA", customer_id: a }))).toBe("23P01");
  });

  it("coexistence: inactive duplicates, non-overlapping windows, and a customer card with a global card's name are allowed", async () => {
    const a = await customer(db.admin);
    await specialRate(db.admin, { name: "Seasonal", effective_from: "2025-01-01T00:00:00Z", effective_to: "2025-06-01T00:00:00Z" });
    await specialRate(db.admin, { name: "Seasonal", effective_from: "2025-06-01T00:00:00Z" });               // starts exactly when the first ends
    await specialRate(db.admin, { name: "Seasonal", is_active: false });                                       // inactive history
    await specialRate(db.admin, { name: "Seasonal", customer_id: a, effective_from: "2025-01-01T00:00:00Z" }); // same name, customer-specific
    expect(await sqlstate(specialRate(db.admin, { name: "Seasonal", effective_from: "2025-03-01T00:00:00Z", effective_to: "2025-07-01T00:00:00Z" }))).toBe("23P01"); // overlaps
  });

  it("windows must be ordered and rates non-negative", async () => {
    expect(await sqlstate(specialRate(db.admin, { effective_from: "2026-02-01T00:00:00Z", effective_to: "2026-01-01T00:00:00Z" }))).toBe("23514");
    expect(await sqlstate(specialRate(db.admin, { sea_rate_usd: -1 }))).toBe("23514");
  });

  it("historical pricing: editing or deactivating the card never changes the snapshot already stored on the item", async () => {
    const c = await customer(db.admin); const i = await bare(db, c);
    const card = await specialRate(db.admin, { name: "Snapshot", sea_rate_usd: 300 });
    await price(db, i, card);
    await db.admin.query("UPDATE special_rates SET sea_rate_usd = 999, is_active = false WHERE id=$1", [card]);
    expect(await row(db, i)).toMatchObject({ billing_basis: "special", special_rate_usd: "300.0000", special_price_usd: "300.00", special_rate_name: "Snapshot" });
  });

  it("a card that items reference cannot be deleted (RESTRICT)", async () => {
    const c = await customer(db.admin); const i = await bare(db, c);
    const card = await specialRate(db.admin, { name: "Referenced" });
    await price(db, i, card);
    expect(await sqlstate(db.admin.query("DELETE FROM special_rates WHERE id=$1", [card]))).toBe("23503");
  });

  it("package rates: overlapping ACTIVE windows for one tier/freight are refused; history may coexist", async () => {
    expect(await sqlstate(db.admin.query("INSERT INTO package_rates (tier, freight_type, rate_usd) VALUES ('basic','sea',360)"))).toBe("23P01");
    await db.admin.query("INSERT INTO package_rates (tier, freight_type, rate_usd, is_active) VALUES ('basic','sea',360,false)");
    expect(await sqlstate(db.admin.query("INSERT INTO package_rates (tier, freight_type, rate_usd) VALUES ('platinum','sea',1)"))).toBe("23514");
  });

  it("with no active tier rate pricing fails with a controlled error instead of guessing", async () => {
    const c = await customer(db.admin, { tier: "enterprise" });
    expect(await code(price(db, await bare(db, c)))).toBe("INVALID_INPUT");
  });
});
