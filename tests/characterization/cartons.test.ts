// Cartons (repacking): behavior of cartonsApi in src/lib/airtable.ts and the /api/cartons routes.
// A "carton" today is just the set of Items that share a CartonNumber (there is no cartons table).
import { describe, it, expect } from "vitest";
import { freshWorld, standardWorld, type World } from "../helpers/world";
import { KNOWN_BUG, PRESERVE, FIXED } from "../helpers/known";

const dims = (over: Record<string, unknown> = {}) => ({ length: 50, width: 40, height: 30, dimensionUnit: "cm" as const, ...over });
const priceOf = (w: World, id: string) => w.db.get("Items", id)?.fields["PkgEstShipping"];

async function world3Items(fields: Record<string, unknown> = {}) {
  const w = await freshWorld();
  w.seed.customer("recCustA");
  for (const id of ["recI1", "recI2", "recI3"]) w.seed.item(id, "recCustA", fields);
  return w;
}

describe(PRESERVE("carton pricing: tier rate x carton CBM (sea) or x weight (air), then split evenly"), () => {
  it("prices a sea carton at the customer's tier rate (default basic 350/m3) and splits it evenly", async () => {
    const w = await world3Items();
    const res = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2", "recI3"], ...dims() });
    expect(res.cartonNumber).toBe("CTN-0001");
    expect(res.cbm).toBeCloseTo(0.06, 10);
    expect(res.totalPrice).toBe(21); // 0.06 * 350
    expect(["recI1", "recI2", "recI3"].map((id) => priceOf(w, id))).toEqual([7, 7, 7]);
  });

  it("copies the carton dimensions, unit and carton number onto every member", async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims({ weight: 12 }) });
    for (const id of ["recI1", "recI2"]) {
      expect(w.db.get("Items", id)?.fields).toMatchObject({
        CartonNumber: "CTN-0001",
        CartonLength: 50,
        CartonWidth: 40,
        CartonHeight: 30,
        CartonWeight: 12,
        DimensionUnit: "cm",
      });
    }
    expect(w.db.get("Items", "recI3")?.fields["CartonNumber"]).toBeUndefined();
  });

  it("gives the last member the rounding remainder (10.00 over 3 items -> 3.33, 3.33, 3.34)", async () => {
    const w = await world3Items();
    w.seed.packageRate("basic", 100, 10); // 0.1 m3 x 100 = 10.00
    const res = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2", "recI3"], length: 100, width: 100, height: 10, dimensionUnit: "cm" });
    expect(res.totalPrice).toBe(10);
    expect(["recI1", "recI2", "recI3"].map((id) => priceOf(w, id))).toEqual([3.33, 3.33, 3.34]);
  });

  it("rounds the carton total to 2 decimals BEFORE splitting", async () => {
    const w = await world3Items();
    const res = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], length: 10, width: 10, height: 10, dimensionUnit: "inches" });
    // 10x10x10 in = 0.016387064 m3 x 350 = 5.7354724 -> 5.74
    expect(res.totalPrice).toBe(5.74);
    expect(priceOf(w, "recI1")).toBe(5.74);
  });

  it("uses the tier rate card defined in code when the PackageRates table is empty (not necessarily business-correct values)", async () => {
    // 1 m3 of sea freight, 10 kg of air freight, per tier.
    const expected: Record<string, { sea: number; air: number }> = {
      basic: { sea: 350, air: 80 },
      business: { sea: 280, air: 60 },
      enterprise: { sea: 450, air: 120 },
      special: { sea: 500, air: 150 },
    };
    for (const [tier, want] of Object.entries(expected)) {
      const sea = await freshWorld();
      sea.seed.customer("recCustA", { CustomerPackage: tier });
      sea.seed.item("recI1", "recCustA", { FreightType: "sea" });
      const s = await sea.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], length: 100, width: 100, height: 100, dimensionUnit: "cm" });
      expect(s.totalPrice, `${tier} sea`).toBe(want.sea);

      const air = await freshWorld();
      air.seed.customer("recCustA", { CustomerPackage: tier });
      air.seed.item("recI1", "recCustA", { FreightType: "air" });
      const a = await air.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], length: 10, width: 10, height: 10, weight: 10, dimensionUnit: "cm" });
      expect(a.totalPrice, `${tier} air`).toBe(want.air);
    }
  });

  it("treats a customer with no stored tier as basic, and stored table rates override the in-code defaults", async () => {
    const w = await world3Items();
    w.seed.packageRate("basic", 1000, 20);
    const res = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], length: 100, width: 100, height: 100, dimensionUnit: "cm" });
    expect(res.totalPrice).toBe(1000);
  });

  it("prices an air carton by weight; cbm is reported as 0 for air", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA", { FreightType: "air" });
    const res = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims({ weight: 10 }) });
    expect(res.cbm).toBe(0);
    expect(res.totalPrice).toBe(80); // 10 kg x 8
  });

  it("ignores the carton's own dimension values for pricing an air carton", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA", { FreightType: "air" });
    const small = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], length: 1, width: 1, height: 1, weight: 10, dimensionUnit: "cm" });
    expect(small.totalPrice).toBe(80);
  });
});

describe(FIXED("an air carton without a weight is rejected instead of being priced at 0"), () => {
  it("rejects creation and writes nothing", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA", { FreightType: "air", PkgEstShipping: 7 });
    await expect(w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() })).rejects.toThrow("Air freight cartons need a weight");
    expect(w.db.get("Items", "recI1")?.fields["CartonNumber"]).toBeUndefined();
    expect(priceOf(w, "recI1")).toBe(7);
  });
});

describe(PRESERVE("carton creation validation (BusinessError messages)"), () => {
  it("rejects an empty selection", async () => {
    const w = await world3Items();
    await expect(w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: [], ...dims() })).rejects.toThrow("Select at least one item to repack");
  });
  it("requires every item to belong to the stated customer, naming the offending items", async () => {
    const w = await world3Items();
    w.seed.customer("recCustB");
    w.seed.item("recX", "recCustB");
    await expect(w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recX"], ...dims() })).rejects.toThrow(
      "All items in a carton must belong to the same customer: ITM-recX"
    );
  });
  it("rejects items already in a carton", async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() });
    await expect(w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims() })).rejects.toThrow(
      "Already in a carton (CTN-0001): ITM-recI1"
    );
  });
  it("rejects items that are already invoiced", async () => {
    const w = await world3Items();
    w.db.insert("Items", { ItemRef: "ITM-INV", Customer: ["recCustA"], Order: ["recOrd1"], OrderRef: "ORD-00009" }, "recINV");
    await expect(w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recINV"], ...dims() })).rejects.toThrow(
      "Already invoiced (ORD-00009): ITM-INV"
    );
  });
  it("rejects special-rate items", async () => {
    const w = await world3Items();
    w.seed.item("recSP", "recCustA", { IsSpecialItem: true });
    await expect(w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recSP"], ...dims() })).rejects.toThrow(
      "Special-rate items can't be repacked into a carton: ITM-recSP"
    );
  });
  it("requires one freight type per carton (items with no freight type count as sea)", async () => {
    const w = await world3Items();
    w.seed.item("recAIR", "recCustA", { FreightType: "air" });
    await expect(w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recAIR"], ...dims() })).rejects.toThrow(
      "All items in a carton must share the same freight type (sea): ITM-recAIR don't match"
    );
  });
  it("de-duplicates repeated item ids", async () => {
    const w = await world3Items();
    const res = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI1", "recI2"], ...dims() });
    expect(res.items).toHaveLength(2);
  });
  it("is exposed over HTTP as 400 with the message for rule violations, and 403 for a customer caller", async () => {
    const { w, admin, custA } = await standardWorld();
    w.seed.item("recI1", "recCustA");
    w.seed.customer("recCustZ");
    const bad = await w.call("cartons", "POST", { token: admin, body: { customerId: "recCustZ", itemIds: ["recI1"], ...dims() } });
    expect(bad.status).toBe(400);
    expect(bad.json?.error).toMatch(/same customer/);
    const denied = await w.call("cartons", "POST", { token: custA, body: { customerId: "recCustA", itemIds: ["recI1"], ...dims() } });
    expect(denied.status).toBe(403);
  });
});

describe("carton editing and dissolution (current behavior)", () => {
  it(PRESERVE("removing a member clears its carton fields and re-prices the remainder"), async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2", "recI3"], ...dims() }); // 21 -> 7 each
    const res = await w.airtable.cartonsApi.update("CTN-0001", { removeItemIds: ["recI3"] });
    expect(res.items.map((i) => i.id)).toEqual(["recI1", "recI2"]);
    expect(priceOf(w, "recI1")).toBe(10.5);
    expect(w.db.get("Items", "recI3")?.fields["CartonNumber"]).toBeUndefined();
  });
  it(PRESERVE("adding a member re-validates it and re-prices every member"), async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims() });
    const res = await w.airtable.cartonsApi.update("CTN-0001", { addItemIds: ["recI3"] });
    expect(res.items).toHaveLength(3);
    expect(priceOf(w, "recI3")).toBe(7);
  });
  it(PRESERVE("editing dimensions re-computes the price"), async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() });
    const res = await w.airtable.cartonsApi.update("CTN-0001", { length: 100, width: 100, height: 100 });
    expect(res.totalPrice).toBe(350);
  });
  it(PRESERVE("an unknown carton number is a BusinessError"), async () => {
    const w = await world3Items();
    await expect(w.airtable.cartonsApi.update("CTN-9999", { length: 10 })).rejects.toThrow("Carton not found");
  });
  it(PRESERVE("removing every member makes the carton cease to exist (empty result)"), async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() });
    const res = await w.airtable.cartonsApi.update("CTN-0001", { removeItemIds: ["recI1"] });
    expect(res).toEqual({ cartonNumber: "CTN-0001", items: [], cbm: 0, totalPrice: 0 });
    expect(await w.airtable.cartonsApi.list()).toEqual([]);
  });
  it(PRESERVE("list() returns only non-invoiced cartons, grouped, with the cbm of the carton"), async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims() });
    const list = await w.airtable.cartonsApi.list();
    expect(list).toHaveLength(1);
    expect(list[0].cartonNumber).toBe("CTN-0001");
    expect(list[0].items).toHaveLength(2);
    expect(list[0].cbm).toBeCloseTo(0.06, 10);
    expect(await w.airtable.cartonsApi.list("someoneElse")).toEqual([]);
  });
});

describe(FIXED("carton operations no longer lose prices, half-apply edits or touch invoiced cartons"), () => {
  it("dissolving a carton restores each member's own price (snapshotted when it joined)", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 12.34 }); // the item's own tier price from receiving
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() });
    expect(priceOf(w, "recI1")).toBe(21); // the carton share
    await w.airtable.cartonsApi.dissolve("CTN-0001");
    expect(priceOf(w, "recI1")).toBe(12.34);
    expect(w.db.get("Items", "recI1")?.fields["CartonNumber"]).toBeUndefined();
    expect(w.db.get("Items", "recI1")?.fields["PreCartonPkgEstShipping"] ?? null).toBeNull();
  });

  it("removing a member restores its own price too", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 12.34 });
    w.seed.item("recI2", "recCustA", { PkgEstShipping: 56.78 });
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims() });
    await w.airtable.cartonsApi.update("CTN-0001", { removeItemIds: ["recI2"] });
    expect(priceOf(w, "recI2")).toBe(56.78);
    expect(w.db.get("Items", "recI2")?.fields["CartonNumber"]).toBeUndefined();
  });

  it(KNOWN_BUG("without a PreCartonPkgEstShipping field on the Items table no snapshot exists and a dissolved item has no price"), async () => {
    // The fake accepts any field, so this documents the dependency: an item that had no price of its own gets none back.
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA"); // no own price, hence no snapshot
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() });
    await w.airtable.cartonsApi.dissolve("CTN-0001");
    expect(priceOf(w, "recI1") ?? null).toBeNull();
  });

  it("a base WITHOUT the optional PreCartonPkgEstShipping field still creates, edits and dissolves cartons (the snapshot is best effort)", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 12.34 });
    w.db.beforeWrite = ({ table, op, fields }) => {
      if (table === "Items" && op === "update" && fields && "PreCartonPkgEstShipping" in fields) throw new Error("UNKNOWN_FIELD_NAME: PreCartonPkgEstShipping");
    };
    const res = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() });
    expect(res.cartonNumber).toBe("CTN-0001");
    expect(priceOf(w, "recI1")).toBe(21);
    await w.airtable.cartonsApi.dissolve("CTN-0001"); // no snapshot to restore: price cleared, exactly like before the fix
    expect(w.db.get("Items", "recI1")?.fields["CartonNumber"]).toBeUndefined();
    expect(priceOf(w, "recI1") ?? null).toBeNull();
  });

  it("a mid-way write failure rolls back to the items' PREVIOUS state, prices included", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 12.34 });
    w.seed.item("recI2", "recCustA", { PkgEstShipping: 56.78 });
    w.db.beforeWrite = ({ table, op, id, fields }) => {
      if (table === "Items" && op === "update" && id === "recI2" && fields?.["CartonNumber"]) throw new Error("simulated Airtable failure");
    };
    await expect(w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims() })).rejects.toThrow("simulated Airtable failure");
    expect(w.db.get("Items", "recI1")?.fields["CartonNumber"] ?? "").toBe("");
    expect(priceOf(w, "recI1")).toBe(12.34); // restored, not erased
    expect(priceOf(w, "recI2")).toBe(56.78); // never reached
    expect(w.db.get("Items", "recI1")?.fields["PreCartonPkgEstShipping"] ?? null).toBeNull();
  });

  it("a rejected edit changes nothing: additions are validated BEFORE removals are applied", async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims() });
    w.seed.customer("recCustB");
    w.seed.item("recX", "recCustB");
    await expect(w.airtable.cartonsApi.update("CTN-0001", { removeItemIds: ["recI2"], addItemIds: ["recX"] })).rejects.toThrow(/same customer/);
    expect(w.db.get("Items", "recI2")?.fields["CartonNumber"]).toBe("CTN-0001"); // still a member
  });

  it("an INVOICED carton cannot be re-dimensioned, edited or dissolved", async () => {
    const w = await world3Items();
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims() });
    const before = priceOf(w, "recI1");
    for (const id of ["recI1", "recI2"]) w.db.update("Items", id, { Order: ["recOrd1"] });
    await expect(w.airtable.cartonsApi.update("CTN-0001", { length: 100, width: 100, height: 100 })).rejects.toThrow(/already invoiced/);
    await expect(w.airtable.cartonsApi.update("CTN-0001", { removeItemIds: ["recI1"] })).rejects.toThrow(/already invoiced/);
    await expect(w.airtable.cartonsApi.dissolve("CTN-0001")).rejects.toThrow(/already invoiced/);
    expect(w.db.get("Items", "recI1")?.fields["CartonNumber"]).toBe("CTN-0001");
    expect(priceOf(w, "recI1")).toBe(before);
  });

  it("the carton routes map the refusal to a 400", async () => {
    const w = await world3Items();
    const admin = w.asUser("super_admin");
    await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1", "recI2"], ...dims() });
    for (const id of ["recI1", "recI2"]) w.db.update("Items", id, { Order: ["recOrd1"] });
    const res = await w.call("cartons/[cartonNumber]", "DELETE", { token: admin, params: { cartonNumber: "CTN-0001" } });
    expect(res.status).toBe(400);
  });
});

describe(KNOWN_BUG("carton numbering"), () => {
  it("documents that carton numbers are REUSED after a carton is dissolved (max existing + 1)", async () => {
    const w = await world3Items();
    const first = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() });
    await w.airtable.cartonsApi.dissolve(first.cartonNumber);
    const second = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI2"], ...dims() });
    expect(first.cartonNumber).toBe("CTN-0001");
    expect(second.cartonNumber).toBe("CTN-0001");
  });

  it("documents that two simultaneous carton creations receive the same number", async () => {
    const w = await world3Items();
    const [a, b] = await Promise.all([
      w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI1"], ...dims() }),
      w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ["recI2"], ...dims() }),
    ]);
    expect([a.cartonNumber, b.cartonNumber]).toEqual(["CTN-0001", "CTN-0001"]);
  });
});
