// Payments and the currency/unit bugs identified in the Phase 2 audit.
// Money model today: invoice amount in USD; payments typed in GHS (dialog label "Payment Amount (GHS)");
// Keepup holds the GHS invoice. Nothing converts between them on the server.
import { describe, it, expect, vi } from "vitest";
import { standardWorld, type World } from "../helpers/world";
import { readSource } from "../helpers/sourceFn";
import { KNOWN_BUG, PRESERVE } from "../helpers/known";

const ORDER_PAGE = "src/app/(dashboard)/admin/orders/[id]/page.tsx";

async function invoiced(order: Record<string, unknown> = {}) {
  const s = await standardWorld();
  s.w.seed.settings(12.5);
  s.w.seed.item("recI1", "recCustA", { Order: ["recOrd1"] });
  s.w.seed.order("recOrd1", "recCustA", { InvoiceAmount: 100, Items: ["recI1"], KeepupSaleId: "KU-1", KeepupLink: "https://keepup.example.invalid/1", ...order });
  return s;
}
const pay = (s: { w: World; admin: string }, body: unknown) => s.w.call("orders/[id]", "PATCH", { token: s.admin, params: { id: "recOrd1" }, body });
const order = (w: World) => w.db.get("Orders", "recOrd1")!.fields;

describe("recording a payment: PATCH /api/orders/[id] { paymentAmount }", () => {
  it(PRESERVE("accumulates payments in AmountPaid and returns the updated order"), async () => {
    const s = await invoiced();
    await pay(s, { paymentAmount: 30 });
    await pay(s, { paymentAmount: 20 });
    expect(order(s.w)["AmountPaid"]).toBe(50);
  });
  it(PRESERVE("forwards the typed amount to Keepup as the payment"), async () => {
    const s = await invoiced();
    await pay(s, { paymentAmount: 30 });
    expect(s.w.keepup.recordKeepupPayment).toHaveBeenCalledWith("KU-1", 30);
  });
  it(PRESERVE("is admin-only"), async () => {
    const s = await invoiced();
    const res = await s.w.call("orders/[id]", "PATCH", { token: s.staff, params: { id: "recOrd1" }, body: { paymentAmount: 10 } });
    expect(res.status).toBe(403);
  });
});

describe(KNOWN_BUG("payment currency mismatch: GHS payment compared with USD invoice amount"), () => {
  // Phase 2 audit item 1. Future behavior (Phase 3 R-20): payments in GHS are compared with total_ghs only.
  // This test documents current behavior only. It must be replaced or inverted when the Phase 7/9 implementation fixes the underlying issue.
  it("documents current payment comparison behavior: GHS 100 settles a USD 100 invoice that is really GHS 1,250", async () => {
    const s = await invoiced(); // USD 100 at 12.5 = GHS 1,250 owed
    const res = await pay(s, { paymentAmount: 100 });
    expect(res.status).toBe(200);
    expect(order(s.w)).toMatchObject({ Status: "Paid", AmountPaid: 100, BalanceDue: 0 });
    expect(res.json?.data).toMatchObject({ status: "Paid", amountPaid: 100, balanceDue: 0 });
  });
  it("documents that the 'balance due' is computed as USD invoice minus GHS paid", async () => {
    const s = await invoiced();
    const res = await pay(s, { paymentAmount: 40 });
    expect(res.json?.data).toMatchObject({ status: "Partial", amountPaid: 40, balanceDue: 60 }); // 100 (USD) - 40 (GHS)
  });
  it("documents that the server never reads the exchange rate while recording a payment", async () => {
    const s = await invoiced();
    s.w.db.all("Settings")[0].fields["UsdToGhs"] = 99;
    await pay(s, { paymentAmount: 100 });
    expect(order(s.w)["Status"]).toBe("Paid");
  });
  it("documents that the client UI makes the same comparison with the converted amount (source anchors)", () => {
    const src = readSource(ORDER_PAGE);
    expect(src).toContain("Payment Amount (GHS)");
    expect(src).toContain("const newStatus = newPaid >= invoiceGhs");
  });
});

describe(KNOWN_BUG("overpayment, races and silent Keepup divergence"), () => {
  it("documents that a payment larger than the invoice is accepted (balance clamps to 0)", async () => {
    const s = await invoiced();
    await pay(s, { paymentAmount: 5000 });
    expect(order(s.w)).toMatchObject({ Status: "Paid", AmountPaid: 5000 });
  });
  it("documents a lost update: two simultaneous payments overwrite each other (read-modify-write)", async () => {
    const s = await invoiced({ InvoiceAmount: 1000 });
    await Promise.all([pay(s, { paymentAmount: 40 }), pay(s, { paymentAmount: 30 })]);
    const paid = order(s.w)["AmountPaid"] as number;
    expect([30, 40]).toContain(paid);
    expect(paid).not.toBe(70);
  });
  it("documents that a Keepup payment failure is swallowed: Movezz says paid, Keepup does not", async () => {
    const s = await invoiced();
    vi.mocked(s.w.keepup.recordKeepupPayment).mockRejectedValueOnce(new Error("keepup down"));
    const res = await pay(s, { paymentAmount: 100 });
    expect(res.status).toBe(200);
    expect(order(s.w)["AmountPaid"]).toBe(100);
  });
  it("documents that recording a payment sends NO email (emails key off the requested status, which the UI does not send)", async () => {
    const s = await invoiced();
    await pay(s, { paymentAmount: 100 });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.w.email.sendPaymentConfirmedEmail).not.toHaveBeenCalled();
    expect(s.w.email.sendPartialPaymentEmail).not.toHaveBeenCalled();
  });
});

describe(KNOWN_BUG("marking an order Paid sends the USD invoice amount to Keepup as if it were GHS"), () => {
  // Phase 2 audit item 2. Documents current behavior only.
  it("documents current Keepup payment amount behavior: status 'Paid' records invoiceAmount (USD 100) against a GHS 1,250 sale", async () => {
    const s = await invoiced();
    const res = await pay(s, { status: "Paid" });
    expect(res.status).toBe(200);
    expect(s.w.keepup.recordKeepupPayment).toHaveBeenCalledWith("KU-1", 100);
    expect(order(s.w)["Status"]).toBe("Paid");
    expect(order(s.w)["AmountPaid"]).toBeUndefined(); // no payment amount is stored at all on this path
  });
  it("documents that the 'Paid' email shows the USD invoice amount", async () => {
    const s = await invoiced();
    await pay(s, { status: "Paid" });
    await vi.waitFor(() => expect(s.w.email.sendPaymentConfirmedEmail).toHaveBeenCalled());
    expect(vi.mocked(s.w.email.sendPaymentConfirmedEmail).mock.calls[0][0]).toMatchObject({ invoiceAmount: 100, orderRef: "ORD-recOrd1" });
  });
  it("documents that the 'Partial' email uses a hard-coded 50% / 50% placeholder instead of real amounts", async () => {
    const s = await invoiced();
    await pay(s, { status: "Partial" });
    await vi.waitFor(() => expect(s.w.email.sendPartialPaymentEmail).toHaveBeenCalled());
    expect(vi.mocked(s.w.email.sendPartialPaymentEmail).mock.calls[0][0]).toMatchObject({ amountPaid: 50, balanceDue: 50 });
  });
});

describe(KNOWN_BUG("double conversion: GET /api/orders/[id] returns Keepup GHS totals; the page multiplies them by the rate again"), () => {
  // Phase 2 audit item 3 (and 4: balance mixes today's rate with older payments). Documents current behavior only.
  it("documents current double-conversion behavior (server side): keepupTotalAmount is the raw Keepup GHS figure", async () => {
    const s = await invoiced();
    vi.mocked(s.w.keepup.getKeepupSale).mockResolvedValueOnce({ totalAmount: 1250, amountPaid: 250, balanceDue: 1000 });
    const res = await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(res.json?.data).toMatchObject({ invoiceAmount: 100, keepupTotalAmount: 1250, keepupAmountPaid: 250, keepupBalanceDue: 1000 });
  });
  it("documents that when Keepup is unreachable the SAME field carries the USD invoice amount instead", async () => {
    const s = await invoiced();
    vi.mocked(s.w.keepup.getKeepupSale).mockRejectedValueOnce(new Error("down"));
    const res = await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(res.json?.data).toMatchObject({ keepupTotalAmount: 100, keepupAmountPaid: 0, keepupBalanceDue: 100 });
  });
  it("documents that a Paid order whose Keepup payment is 0 is reported as paid in the USD invoice amount", async () => {
    const s = await invoiced({ Status: "Paid" });
    vi.mocked(s.w.keepup.getKeepupSale).mockResolvedValueOnce({ totalAmount: 1250, amountPaid: 0, balanceDue: 1250 });
    const res = await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(res.json?.data).toMatchObject({ keepupAmountPaid: 100, keepupBalanceDue: 0 });
  });
  it("documents the client-side conversions (source anchors in the order detail page)", () => {
    const src = readSource(ORDER_PAGE);
    expect(src).toContain("formatCurrency(keepupTotal * usdToGhs, \"GHS\")"); // Keepup GHS total x rate
    expect(src).toContain("order.invoiceAmount * usdToGhs - (keepupPaid ?? 0)"); // today's rate minus older GHS payments
  });
});

describe(KNOWN_BUG("historical invoices have no exchange-rate snapshot"), () => {
  it("documents that the displayed GHS value of an existing invoice changes when the global rate changes (source anchors)", () => {
    // The order screen converts the stored USD amount with the rate in force TODAY (usdToGhs from Settings / localStorage).
    const src = readSource(ORDER_PAGE);
    expect(src).toContain("formatCurrency(order.invoiceAmount * usdToGhs, \"GHS\")");
    expect(src).toContain('localStorage.getItem("pakk_exchange_rates")');
  });
  it("documents that the order record holds no rate or GHS amount to reconstruct history from", async () => {
    const s = await invoiced();
    const keys = Object.keys(order(s.w));
    expect(keys.filter((k) => /rate|ghs|fx|exchange/i.test(k))).toEqual([]);
  });
});

describe("GET /api/orders/[id] (other behavior)", () => {
  it(PRESERVE("back-fills and stores a missing Keepup share link"), async () => {
    const s = await invoiced({ KeepupLink: "" });
    vi.mocked(s.w.keepup.fetchKeepupShareLink).mockResolvedValueOnce("https://keepup.example.invalid/filled");
    vi.mocked(s.w.keepup.getKeepupSale).mockResolvedValueOnce({ totalAmount: 1250, amountPaid: 0, balanceDue: 1250 });
    await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(order(s.w)["KeepupLink"]).toBe("https://keepup.example.invalid/filled");
  });
  it(KNOWN_BUG("a read performs one live Keepup call (plus one Airtable read per item) on every view"), async () => {
    const s = await invoiced();
    s.w.seed.item("recI2", "recCustA");
    s.w.seed.item("recI3", "recCustA");
    s.w.db.update("Orders", "recOrd1", { Items: ["recI1", "recI2", "recI3"] });
    vi.mocked(s.w.keepup.getKeepupSale).mockResolvedValue({ totalAmount: 1250, amountPaid: 0, balanceDue: 1250 });
    s.w.db.clearCalls();
    await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(s.w.keepup.getKeepupSale).toHaveBeenCalledTimes(1);
    expect(s.w.db.count("Items", "find")).toBe(3); // N+1: one find() per item
  });
});

describe("POST /api/orders/keepup-sync", () => {
  async function syncWorld() {
    const s = await standardWorld();
    s.w.seed.order("recP", "recCustA", { Status: "Pending", KeepupSaleId: "KU-P" });
    s.w.seed.order("recQ", "recCustA", { Status: "Pending", KeepupSaleId: "KU-Q" });
    s.w.seed.order("recR", "recCustA", { Status: "Partial", KeepupSaleId: "KU-R" });
    s.w.seed.order("recS", "recCustA", { Status: "Pending" }); // no Keepup sale
    s.w.seed.order("recT", "recCustA", { Status: "Paid", KeepupSaleId: "KU-T" }); // already paid
    return s;
  }
  it(PRESERVE("marks Paid when Keepup balance <= 0 and Partial when something was paid; ignores unsynced and Paid orders"), async () => {
    const s = await syncWorld();
    vi.mocked(s.w.keepup.getKeepupSale).mockImplementation(async (id: string) =>
      id === "KU-P" ? { totalAmount: 1250, amountPaid: 1250, balanceDue: 0 } : id === "KU-Q" ? { totalAmount: 1250, amountPaid: 500, balanceDue: 750 } : { totalAmount: 1250, amountPaid: 500, balanceDue: 750 }
    );
    const res = await s.w.call("orders/keepup-sync", "POST", { token: s.staff });
    expect(res.json).toMatchObject({ success: true, synced: 3, updated: 2, errors: 0 });
    expect(s.w.db.get("Orders", "recP")?.fields["Status"]).toBe("Paid");
    expect(s.w.db.get("Orders", "recQ")?.fields["Status"]).toBe("Partial");
    expect(s.w.db.get("Orders", "recR")?.fields["Status"]).toBe("Partial"); // unchanged
    expect(s.w.keepup.getKeepupSale).not.toHaveBeenCalledWith("KU-T");
  });
  it(PRESERVE("counts Keepup failures as errors and continues"), async () => {
    const s = await syncWorld();
    vi.mocked(s.w.keepup.getKeepupSale).mockRejectedValue(new Error("down"));
    const res = await s.w.call("orders/keepup-sync", "POST", { token: s.admin });
    expect(res.json).toMatchObject({ synced: 3, updated: 0, errors: 3 });
  });
  it(KNOWN_BUG("the sync changes only Status; AmountPaid / BalanceDue are not updated and no payment record is created"), async () => {
    const s = await syncWorld();
    vi.mocked(s.w.keepup.getKeepupSale).mockResolvedValue({ totalAmount: 1250, amountPaid: 1250, balanceDue: 0 });
    await s.w.call("orders/keepup-sync", "POST", { token: s.admin });
    expect(s.w.db.get("Orders", "recP")?.fields["Status"]).toBe("Paid");
    expect(s.w.db.get("Orders", "recP")?.fields["AmountPaid"]).toBeUndefined();
    expect(s.w.db.all("StatusHistory")).toHaveLength(0);
  });
  it(PRESERVE("is not available to customers"), async () => {
    const s = await syncWorld();
    expect((await s.w.call("orders/keepup-sync", "POST", { token: s.custA })).status).toBe(403);
  });
});

describe("other order updates and deletion", () => {
  it(KNOWN_BUG("editing the amount after a Keepup invoice exists does not touch Keepup (only the date can be synced)"), async () => {
    const s = await invoiced();
    await pay(s, { invoiceAmount: 999, syncKeeup: true, invoiceDate: "2026-04-01" });
    expect(order(s.w)["InvoiceAmount"]).toBe(999);
    expect(s.w.keepup.updateKeepupSale).toHaveBeenCalledWith("KU-1", { invoiceDate: "2026-04-01" });
  });
  it(KNOWN_BUG("PATCH itemIds rewrites the order's item list without updating the items' own Order link"), async () => {
    const s = await invoiced();
    s.w.seed.item("recI9", "recCustA");
    await pay(s, { itemIds: ["recI9"] });
    expect(order(s.w)["Items"]).toEqual(["recI9"]);
    expect(s.w.db.get("Items", "recI9")?.fields["Order"]).toBeUndefined();
    expect(s.w.db.get("Items", "recI1")?.fields["Order"]).toEqual(["recOrd1"]);
  });
  it(PRESERVE("DELETE hard-deletes the order, unlinks its items and cancels the Keepup sale (cancel failure swallowed)"), async () => {
    const s = await invoiced();
    vi.mocked(s.w.keepup.cancelKeepupSale).mockRejectedValueOnce(new Error("down"));
    const res = await s.w.call("orders/[id]", "DELETE", { token: s.admin, params: { id: "recOrd1" } });
    expect(res.status).toBe(200);
    expect(s.w.db.get("Orders", "recOrd1")).toBeUndefined();
    expect(s.w.db.get("Items", "recI1")?.fields["Order"]).toBeUndefined();
    expect(s.w.keepup.cancelKeepupSale).toHaveBeenCalledWith("KU-1");
  });
});
