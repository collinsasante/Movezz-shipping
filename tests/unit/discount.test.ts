import { describe, it, expect } from "vitest";
import { checkDiscount } from "@/lib/discount";

const base = { subtotal: 350, role: "super_admin" as const };
describe("invoice discount pre-check (the server stays authoritative)", () => {
  it("1. no discount: unchanged total", () => expect(checkDiscount({ ...base, discount: "", reason: "" })).toEqual({ ok: true, discount: 0, total: 350 }));
  it("2. valid discount with a reason", () => expect(checkDiscount({ ...base, discount: "50", reason: "loyalty" })).toEqual({ ok: true, discount: 50, total: 300 }));
  it("3. discount without a reason is refused", () => expect(checkDiscount({ ...base, discount: "50", reason: "  " })).toMatchObject({ ok: false, error: expect.stringMatching(/reason/i) }));
  it("4. a non super_admin cannot give a discount (and the controls are hidden)", () => {
    for (const role of ["warehouse_staff", "customer", undefined] as const) expect(checkDiscount({ subtotal: 350, role, discount: "10", reason: "x" })).toMatchObject({ ok: false });
    expect(checkDiscount({ subtotal: 350, role: "warehouse_staff", discount: "", reason: "" })).toMatchObject({ ok: true, total: 350 });
  });
  it("5. a discount larger than the subtotal is refused; negative, non-numeric and 3-decimal values too", () => {
    expect(checkDiscount({ ...base, discount: "350.01", reason: "x" })).toMatchObject({ ok: false });
    for (const d of ["-1", "abc", "10.123"]) expect(checkDiscount({ ...base, discount: d, reason: "x" }), d).toMatchObject({ ok: false });
  });
  it("6a. a discount equal to the subtotal is allowed by the pre-check; the server decides what a zero total means", () => expect(checkDiscount({ ...base, discount: "350", reason: "gift" })).toEqual({ ok: true, discount: 350, total: 0 }));
});
