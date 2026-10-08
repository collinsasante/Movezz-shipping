// Characterization of src/lib/cbm.ts (pure functions).
import { describe, it, expect } from "vitest";
import { unitFactor, computeCbm, computeCartonCbm, groupItemsForBilling } from "@/lib/cbm";
import type { Item } from "@/types";
import { KNOWN_BUG, PRESERVE, REPLACE_NOTE } from "../helpers/known";

const item = (over: Partial<Item> = {}): Item =>
  ({
    id: "i1",
    itemRef: "ITM-0001",
    photos: [],
    dimensionUnit: "cm",
    description: "",
    dateReceived: "2026-03-01",
    customerId: "c1",
    status: "Arrived at Transit Warehouse",
    isMissing: false,
    createdAt: "2026-03-01",
    ...over,
  }) as Item;

describe(PRESERVE("unitFactor"), () => {
  it("is 1 for cm and for an undefined unit", () => {
    expect(unitFactor("cm")).toBe(1);
    expect(unitFactor(undefined)).toBe(1);
  });
  it("is 16.387064 cm3 per cubic inch for inches", () => {
    expect(unitFactor("inches")).toBe(16.387064);
  });
});

describe(PRESERVE("computeCbm - centimeters"), () => {
  it("computes L x W x H / 1,000,000 for normal dimensions", () => {
    expect(computeCbm({ length: 100, width: 100, height: 100 })).toBe(1);
    expect(computeCbm({ length: 50, width: 40, height: 30 })).toBeCloseTo(0.06, 10);
  });
  it("handles fractional dimensions", () => {
    expect(computeCbm({ length: 12.5, width: 8.25, height: 4 })).toBeCloseTo(0.0004125, 10);
  });
  it("handles very small and very large dimensions", () => {
    expect(computeCbm({ length: 1, width: 1, height: 1 })).toBeCloseTo(0.000001, 12);
    expect(computeCbm({ length: 1000, width: 1000, height: 1000 })).toBe(1000);
  });
  it("applies no rounding (full floating point precision)", () => {
    expect(computeCbm({ length: 33, width: 33, height: 33 })).toBe(0.035937);
  });
});

describe(PRESERVE("computeCbm - inches"), () => {
  it("converts cubic inches to cm3 with 16.387064 before dividing by 1,000,000", () => {
    // 10 x 10 x 10 in = 1000 in3 = 16,387.064 cm3 = 0.016387064 m3
    expect(computeCbm({ length: 10, width: 10, height: 10, dimensionUnit: "inches" })).toBeCloseTo(0.016387064, 12);
  });
  it("treats a missing unit as centimeters", () => {
    expect(computeCbm({ length: 10, width: 10, height: 10 })).toBeCloseTo(0.001, 12);
  });
});

describe("computeCbm - invalid or missing dimensions (current behavior)", () => {
  it("returns 0 (does not throw) for zero, undefined, null, NaN or incomplete dimensions", () => {
    expect(computeCbm({ length: 0, width: 10, height: 10 })).toBe(0);
    expect(computeCbm({ length: 10, width: 10 })).toBe(0);
    expect(computeCbm({})).toBe(0);
    expect(computeCbm({ length: null as unknown as number, width: 10, height: 10 })).toBe(0);
    expect(computeCbm({ length: NaN, width: 10, height: 10 })).toBe(0);
  });
});

describe(KNOWN_BUG("computeCbm accepts negative dimensions and quantities"), () => {
  // Intended future behavior (Phase 3 R-7 / DB CHECK constraints): reject non-positive values.
  // (see REPLACE_NOTE in tests/helpers/known.ts)
  it("documents that a negative dimension yields a NEGATIVE cbm instead of being rejected", () => {
    expect(computeCbm({ length: -10, width: 10, height: 10 })).toBeCloseTo(-0.001, 12);
  });
  it("documents that two negative dimensions yield a POSITIVE cbm", () => {
    expect(computeCbm({ length: -10, width: -10, height: 10 })).toBeCloseTo(0.001, 12);
  });
  it("documents that a negative quantity yields a negative cbm", () => {
    expect(computeCbm({ length: 10, width: 10, height: 10, quantity: -2 })).toBeCloseTo(-0.002, 12);
  });
});

describe("computeCbm - quantity (current behavior)", () => {
  const dims = { length: 100, width: 100, height: 100 };
  it("defaults to quantity 1 when quantity is undefined or null", () => {
    expect(computeCbm({ ...dims })).toBe(1);
    expect(computeCbm({ ...dims, quantity: undefined })).toBe(1);
    expect(computeCbm({ ...dims, quantity: null as unknown as number })).toBe(1);
  });
  it("multiplies the per-unit CBM by quantity (returns TOTAL cbm, not per-unit)", () => {
    expect(computeCbm({ ...dims, quantity: 3 })).toBe(3);
  });
  it("returns 0 for quantity 0 (0 is not treated as missing)", () => {
    expect(computeCbm({ ...dims, quantity: 0 })).toBe(0);
  });
  it("returns NaN for a NaN quantity (no validation)", () => {
    expect(computeCbm({ ...dims, quantity: NaN })).toBeNaN();
  });
});

describe(PRESERVE("computeCartonCbm"), () => {
  it("uses the carton's own dimensions and unit, with quantity fixed at 1", () => {
    expect(computeCartonCbm({ cartonLength: 100, cartonWidth: 50, cartonHeight: 40, dimensionUnit: "cm" })).toBeCloseTo(0.2, 10);
    expect(computeCartonCbm({ cartonLength: 10, cartonWidth: 10, cartonHeight: 10, dimensionUnit: "inches" })).toBeCloseTo(0.016387064, 12);
  });
  it("returns 0 when any carton dimension is missing", () => {
    expect(computeCartonCbm({ cartonLength: 10, cartonWidth: 10, dimensionUnit: "cm" })).toBe(0);
  });
});

describe("groupItemsForBilling (current behavior)", () => {
  it("keeps un-cartoned items as singleton groups priced by their OWN dimensions x quantity", () => {
    const groups = groupItemsForBilling([item({ id: "a", length: 100, width: 100, height: 100, quantity: 2 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "item:a", isCarton: false, cbm: 2 });
  });
  it("collapses items sharing a cartonNumber into ONE group priced by the carton dimensions", () => {
    const common = { cartonNumber: "CTN-0001", cartonLength: 100, cartonWidth: 100, cartonHeight: 100, length: 5, width: 5, height: 5 };
    const groups = groupItemsForBilling([item({ id: "a", ...common }), item({ id: "b", ...common })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "carton:CTN-0001", isCarton: true, cartonNumber: "CTN-0001", cbm: 1 });
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });
  it("ignores member quantity inside a carton (the carton cbm is not multiplied)", () => {
    const common = { cartonNumber: "CTN-0002", cartonLength: 100, cartonWidth: 100, cartonHeight: 100 };
    const groups = groupItemsForBilling([item({ id: "a", quantity: 5, ...common })]);
    expect(groups[0].cbm).toBe(1);
  });
  it("takes the group cbm from the FIRST member when members disagree about carton dimensions", () => {
    const first = item({ id: "a", cartonNumber: "CTN-0003", cartonLength: 100, cartonWidth: 100, cartonHeight: 100 });
    const second = item({ id: "b", cartonNumber: "CTN-0003", cartonLength: 10, cartonWidth: 10, cartonHeight: 10 });
    expect(groupItemsForBilling([first, second])[0].cbm).toBe(1);
    expect(groupItemsForBilling([second, first])[0].cbm).toBeCloseTo(0.001, 10);
  });
  it("preserves first-seen order and mixes cartons with singleton items", () => {
    const groups = groupItemsForBilling([
      item({ id: "x", length: 10, width: 10, height: 10 }),
      item({ id: "c1", cartonNumber: "CTN-0009", cartonLength: 10, cartonWidth: 10, cartonHeight: 10 }),
      item({ id: "y", length: 10, width: 10, height: 10 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["item:x", "carton:CTN-0009", "item:y"]);
  });
  it("does NOT check that carton members share a customer (grouping is by cartonNumber only)", () => {
    const groups = groupItemsForBilling([
      item({ id: "a", customerId: "c1", cartonNumber: "CTN-0010" }),
      item({ id: "b", customerId: "c2", cartonNumber: "CTN-0010" }),
    ]);
    expect(groups).toHaveLength(1);
  });
});
