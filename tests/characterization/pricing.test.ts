// Pricing characterization. Item prices and invoice totals are currently computed IN THE BROWSER
// (React page components); the server stores whatever it is sent. Functions that live inside page
// components are executed from their real source text (tests/helpers/sourceFn.ts).
import { describe, it, expect } from "vitest";
import { computeCbm } from "@/lib/cbm";
import { loadFunction, readSource } from "../helpers/sourceFn";
import { freshWorld } from "../helpers/world";
import { KNOWN_BUG, PRESERVE } from "../helpers/known";
import type { Item } from "@/types";

const ITEMS_NEW = "src/app/(dashboard)/admin/items/new/page.tsx";
const ORDERS_NEW = "src/app/(dashboard)/admin/orders/new/page.tsx";

const getCbm = loadFunction<(l: number, w: number, h: number, unit: "cm" | "inches") => number>(ITEMS_NEW, "getCbm");
const calcTotal = loadFunction<(items: Item[]) => number>(ORDERS_NEW, "calcTotal");

describe("browser CBM (items/new page) vs server CBM (lib/cbm.ts)", () => {
  it(PRESERVE("agree exactly for centimeters"), () => {
    expect(getCbm(50, 40, 30, "cm")).toBe(computeCbm({ length: 50, width: 40, height: 30 }));
  });

  it(PRESERVE("return 0 for missing dimensions"), () => {
    expect(getCbm(0, 10, 10, "cm")).toBe(0);
    expect(getCbm(10, 10, 10, "cm")).toBeGreaterThan(0);
  });

  it(KNOWN_BUG("the browser uses a rounded inch factor (0.000016387) while the server uses 16.387064 / 1e6"), () => {
    // Future behavior (Phase 3 R-7): ONE definition (database generated column + one TS function).
    // This test documents current behavior only. It must be replaced when pricing moves server-side.
    const browser = getCbm(100, 100, 100, "inches");
    const server = computeCbm({ length: 100, width: 100, height: 100, dimensionUnit: "inches" });
    expect(browser).toBeCloseTo(16.387, 6);
    expect(server).toBeCloseTo(16.387064, 6);
    expect(browser).not.toBe(server);
    // The drift is visible in money at the basic sea rate (350/m3): about 0.02 per 100x100x100 in.
    expect(Math.round((server - browser) * 350 * 100) / 100).toBe(0.02);
  });

  it("source anchors: the formulas that cannot be extracted (they live inside React hooks)", () => {
    const src = readSource(ITEMS_NEW);
    // Tier price: air = weight x quantity x tier air rate ; sea = cbm x tier sea rate (cbm already includes quantity)
    expect(src).toContain("if (w) cost = w * qty * (tierRates.air ?? 0);");
    expect(src).toContain("if (cbm) cost = cbm * (tierRates.sea ?? 0);");
    // Hard-coded fallback rates used by the browser when a tier is missing from the rate card
    expect(src).toContain("pkgRates[tier] ?? { sea: 350, air: 8 }");
    // The customer's tier decides the rate; no tier means basic
    expect(src).toContain('(customer?.package ?? "basic")');
    // Special rate: air = weight x quantity x special air rate ; sea = cbm x special sea rate
    expect(src).toContain("if (w) costGhs = w * qty * rate.air;");
    expect(src).toContain("if (cbm) costGhs = cbm * rate.sea;");
  });
});

describe("package rate card (server: packageRatesApi)", () => {
  it(PRESERVE("falls back to the rate card defined in code when no rows exist"), async () => {
    const w = await freshWorld();
    expect(await w.airtable.packageRatesApi.getAll()).toEqual({
      basic: { sea: 350, air: 8 },
      business: { sea: 280, air: 6 },
      enterprise: { sea: 450, air: 12 },
      special: { sea: 500, air: 15 },
    });
  });
  it(PRESERVE("stored rows override defaults per tier; other tiers keep their defaults"), async () => {
    const w = await freshWorld();
    w.seed.packageRate("business", 111, 2);
    const rates = await w.airtable.packageRatesApi.getAll();
    expect(rates.business).toEqual({ sea: 111, air: 2 });
    expect(rates.basic).toEqual({ sea: 350, air: 8 });
  });
  it(PRESERVE("rows with a tier name outside the four known tiers are ignored when reading"), async () => {
    const w = await freshWorld();
    w.seed.packageRate("platinum", 1, 1);
    expect(Object.keys(await w.airtable.packageRatesApi.getAll()).sort()).toEqual(["basic", "business", "enterprise", "special"]);
  });
  it(PRESERVE("the 'special' TIER (customer package) is separate from named SPECIAL RATES (per-item)"), async () => {
    const w = await freshWorld();
    w.seed.specialRate("recSR1", "Bulk Lagos", 300, 5);
    const list = await w.airtable.specialRatesApi.list();
    expect(list).toEqual([{ id: "recSR1", name: "Bulk Lagos", sea: 300, air: 5 }]);
  });
});

describe("invoice total as computed by the browser (orders/new page calcTotal)", () => {
  const item = (over: Partial<Item>): Item => ({ id: "i", ...over }) as Item;

  it(PRESERVE("sums each item's tier price (pkgEstShipping)"), () => {
    expect(calcTotal([item({ pkgEstShipping: 10 }), item({ pkgEstShipping: 20.5 })])).toBe(30.5);
  });
  it(PRESERVE("falls back to estShippingPrice only when pkgEstShipping is absent"), () => {
    expect(calcTotal([item({ estShippingPrice: 7 })])).toBe(7);
  });
  it(PRESERVE("treats an item with no price as 0"), () => {
    expect(calcTotal([item({}), item({ pkgEstShipping: 5 })])).toBe(5);
  });
  it("rounds ONCE, on the final total (not per item)", () => {
    expect(calcTotal([item({ pkgEstShipping: 0.1 }), item({ pkgEstShipping: 0.2 })])).toBe(0.3);
    expect(calcTotal([item({ pkgEstShipping: 1.004 }), item({ pkgEstShipping: 1.004 })])).toBe(2.01); // per-item rounding would give 2.00
  });

  describe(KNOWN_BUG("special-rate items are invoiced at the TIER price, not the special-rate price"), () => {
    // Approved decision Q16: billing_basis='special' must use special_price_usd; billing_basis='tier' uses tier_price_usd.
    // pkgEstShipping = tier price ; estShippingPrice = special-rate price.
    // This test documents current behavior only. It must be inverted in Phase 7/9 when server-side pricing lands.
    const specialItem = item({ isSpecialItem: true, specialRateName: "Bulk Lagos", pkgEstShipping: 50, estShippingPrice: 80 });

    it("documents current special-rate invoice behavior: the invoice uses pkgEstShipping (50), ignoring the special price (80)", () => {
      expect(calcTotal([specialItem])).toBe(50);
    });
    it("documents that the special price only wins if the tier price is missing", () => {
      expect(calcTotal([item({ isSpecialItem: true, estShippingPrice: 80 })])).toBe(80);
    });
    it.todo("FUTURE (Q16, billing_basis='special'): the invoice line for this item is special_price_usd = 80, and a billing_basis='tier' item is billed tier_price_usd");
    it.todo("FUTURE (Q16): historical invoices are NOT recalculated; the special rate is kept as a pricing snapshot on the item");
  });

  it("source anchor: the expression is the whole rule (no other code path totals an invoice in the browser)", () => {
    expect(readSource(ORDERS_NEW)).toContain("item.pkgEstShipping ?? item.estShippingPrice ?? 0");
  });
});
