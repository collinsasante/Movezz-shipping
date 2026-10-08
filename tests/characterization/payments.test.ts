// Payments and the currency/unit bugs identified in the Phase 2 audit.
// Money model: invoice amount in USD; payments typed in GHS (dialog label "Payment Amount (GHS)");
// Keepup holds the GHS invoice. The server converts the USD invoice to GHS ONCE (lib/money.ts) and only ever
// compares GHS with GHS. Exchange-rate snapshots are NOT stored yet (PostgreSQL phase) - see the KNOWN_BUG block below.
import { describe, it, expect, vi } from "vitest";
import { standardWorld, type World } from "../helpers/world";
import { readSource } from "../helpers/sourceFn";
import { KNOWN_BUG, PRESERVE, FIXED } from "../helpers/known";

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

describe(FIXED("payments are GHS amounts compared with the GHS invoice"), () => {
  it("GHS 100 no longer settles a USD 100 invoice that is GHS 1,250: it is a partial payment", async () => {
    const s = await invoiced(); // USD 100 at 12.5 = GHS 1,250 owed
    const res = await pay(s, { paymentAmount: 100 });
    expect(res.status).toBe(200);
    expect(order(s.w)).toMatchObject({ Status: "Partial", AmountPaid: 100, BalanceDue: 1150 });
    expect(res.json?.data).toMatchObject({ status: "Partial", amountPaid: 100, balanceDue: 1150 });
  });
  it("paying the full GHS amount settles the invoice", async () => {
    const s = await invoiced();
    const res = await pay(s, { paymentAmount: 1250 });
    expect(res.json?.data).toMatchObject({ status: "Paid", amountPaid: 1250, balanceDue: 0 });
  });
  it("two payments add up in GHS and the last one settles", async () => {
    const s = await invoiced();
    await pay(s, { paymentAmount: 1000 });
    const res = await pay(s, { paymentAmount: 250 });
    expect(res.json?.data).toMatchObject({ status: "Paid", amountPaid: 1250, balanceDue: 0 });
  });
  it("the discount is applied before conversion: (100 - 20) x 12.5 = GHS 1,000", async () => {
    const s = await invoiced({ Discount: 20 });
    const res = await pay(s, { paymentAmount: 1000 });
    expect(res.json?.data).toMatchObject({ status: "Paid", balanceDue: 0 });
  });
  it("the balance uses the configured rate; changing the rate changes what a payment settles (documented FX limit)", async () => {
    const s = await invoiced();
    s.w.db.all("Settings")[0].fields["UsdToGhs"] = 99;
    const res = await pay(s, { paymentAmount: 100 });
    expect(res.json?.data).toMatchObject({ status: "Partial", balanceDue: 9800 });
  });
  it("with no configured rate a payment is refused (409) and nothing is written", async () => {
    const s = await invoiced();
    s.w.db.all("Settings")[0].fields["UsdToGhs"] = 0;
    const res = await pay(s, { paymentAmount: 100 });
    expect(res.status).toBe(409);
    expect(order(s.w)["AmountPaid"]).toBeUndefined();
    expect(s.w.keepup.recordKeepupPayment).not.toHaveBeenCalled();
  });
  it("source anchor: the dialog is labelled GHS and the page no longer compares against a USD-converted total", () => {
    const src = readSource(ORDER_PAGE);
    expect(src).toContain("Payment Amount (GHS)");
    expect(src).toContain("const invoiceGhs = keepupTotal ?? 0");
  });
});

describe(FIXED("overpayment, races, Keepup divergence and payment emails"), () => {
  it("an overpayment is rejected (400) and nothing is recorded", async () => {
    const s = await invoiced();
    const res = await pay(s, { paymentAmount: 5000 });
    expect(res.status).toBe(400);
    expect(order(s.w)["AmountPaid"]).toBeUndefined();
    expect(s.w.keepup.recordKeepupPayment).not.toHaveBeenCalled();
  });
  it("paying more than the REMAINING balance is rejected too", async () => {
    const s = await invoiced();
    await pay(s, { paymentAmount: 1000 });
    expect((await pay(s, { paymentAmount: 300 })).status).toBe(400);
    expect(order(s.w)["AmountPaid"]).toBe(1000);
  });
  it("two simultaneous payments in one process both count (serialised per order)", async () => {
    const s = await invoiced({ InvoiceAmount: 1000 });
    await Promise.all([pay(s, { paymentAmount: 40 }), pay(s, { paymentAmount: 30 })]);
    expect(order(s.w)["AmountPaid"]).toBe(70);
  });
  it(KNOWN_BUG("two simultaneous payments handled by DIFFERENT isolates/instances can still overwrite each other (no cross-process lock on Airtable)"), () => {
    // Cannot be reproduced against the single-process fake; fixed by a PostgreSQL transaction / row lock (payments table, append-only).
    expect(true).toBe(true);
  });
  it("a Keepup payment failure is no longer silent: the payment is saved and the response carries a warning", async () => {
    const s = await invoiced();
    vi.mocked(s.w.keepup.recordKeepupPayment).mockRejectedValueOnce(new Error("keepup down"));
    const res = await pay(s, { paymentAmount: 100 });
    expect(res.status).toBe(200);
    expect(order(s.w)["AmountPaid"]).toBe(100);
    expect(res.json?.warnings?.[0]).toMatch(/Keepup/);
  });
  it("recording a payment now sends the matching email with the real GHS figures", async () => {
    const s = await invoiced();
    await pay(s, { paymentAmount: 250 });
    await vi.waitFor(() => expect(s.w.email.sendPartialPaymentEmail).toHaveBeenCalledTimes(1));
    expect(vi.mocked(s.w.email.sendPartialPaymentEmail).mock.calls[0][0]).toMatchObject({ amountPaid: 250, balanceDue: 1000, currency: "GHS" });
    await pay(s, { paymentAmount: 1000 });
    await vi.waitFor(() => expect(s.w.email.sendPaymentConfirmedEmail).toHaveBeenCalledTimes(1));
    expect(vi.mocked(s.w.email.sendPaymentConfirmedEmail).mock.calls[0][0]).toMatchObject({ invoiceAmount: 1250, currency: "GHS" });
  });
});

describe(FIXED("marking an order Paid settles the GHS outstanding amount, not the USD invoice amount"), () => {
  it("records the GHS outstanding amount in Keepup and stores it on the order", async () => {
    const s = await invoiced();
    const res = await pay(s, { status: "Paid" });
    expect(res.status).toBe(200);
    expect(s.w.keepup.recordKeepupPayment).toHaveBeenCalledWith("KU-1", 1250);
    expect(order(s.w)).toMatchObject({ Status: "Paid", AmountPaid: 1250, BalanceDue: 0 });
  });
  it("after a partial payment only the remainder is sent (no double payment)", async () => {
    const s = await invoiced({ Status: "Partial", AmountPaid: 250 });
    await pay(s, { status: "Paid" });
    expect(s.w.keepup.recordKeepupPayment).toHaveBeenCalledWith("KU-1", 1000);
  });
  it("the 'Paid' email shows the GHS amount", async () => {
    const s = await invoiced();
    await pay(s, { status: "Paid" });
    await vi.waitFor(() => expect(s.w.email.sendPaymentConfirmedEmail).toHaveBeenCalled());
    expect(vi.mocked(s.w.email.sendPaymentConfirmedEmail).mock.calls[0][0]).toMatchObject({ invoiceAmount: 1250, currency: "GHS", orderRef: "ORD-recOrd1" });
  });
  it("a 'Partial' status with no known amounts sends no invented 50/50 email", async () => {
    const s = await invoiced();
    await pay(s, { status: "Partial" });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.w.email.sendPartialPaymentEmail).not.toHaveBeenCalled();
  });
  it("Mark Paid with no rate configured and a Keepup sale is refused (409)", async () => {
    const s = await invoiced();
    s.w.db.all("Settings")[0].fields["UsdToGhs"] = 0;
    expect((await pay(s, { status: "Paid" })).status).toBe(409);
    expect(order(s.w)["Status"]).toBe("Pending");
  });
});

describe(FIXED("GET /api/orders/[id] never puts a USD figure in a GHS field"), () => {
  it("keepup figures are the raw Keepup GHS values and the server adds the GHS net total", async () => {
    const s = await invoiced();
    vi.mocked(s.w.keepup.getKeepupSale).mockResolvedValueOnce({ totalAmount: 1250, amountPaid: 250, balanceDue: 1000 });
    const res = await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(res.json?.data).toMatchObject({ invoiceAmount: 100, invoiceTotalGhs: 1250, keepupTotalAmount: 1250, keepupAmountPaid: 250, keepupBalanceDue: 1000 });
  });
  it("when Keepup is unreachable the Keepup total is null (not the USD amount); paid/balance come from the stored GHS payments", async () => {
    const s = await invoiced({ AmountPaid: 250, BalanceDue: 1000, Status: "Partial" });
    vi.mocked(s.w.keepup.getKeepupSale).mockRejectedValueOnce(new Error("down"));
    const res = await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(res.json?.data).toMatchObject({ keepupTotalAmount: null, keepupAmountPaid: 250, keepupBalanceDue: 1000, invoiceTotalGhs: 1250 });
  });
  it("a Paid order whose Keepup payment is 0 is no longer reported as paid in USD", async () => {
    const s = await invoiced({ Status: "Paid" });
    vi.mocked(s.w.keepup.getKeepupSale).mockResolvedValueOnce({ totalAmount: 1250, amountPaid: 0, balanceDue: 1250 });
    const res = await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(res.json?.data).toMatchObject({ keepupAmountPaid: 0 });
    expect(res.json?.data.keepupAmountPaid).not.toBe(100);
  });
  it("with no rate configured the GHS total is null, never USD-as-GHS", async () => {
    const s = await invoiced();
    s.w.db.all("Settings")[0].fields["UsdToGhs"] = 0;
    vi.mocked(s.w.keepup.getKeepupSale).mockRejectedValueOnce(new Error("down"));
    const res = await s.w.call("orders/[id]", "GET", { token: s.admin, params: { id: "recOrd1" } });
    expect(res.json?.data).toMatchObject({ invoiceTotalGhs: null, keepupTotalAmount: null });
  });
  it("source anchors: the page shows Keepup/GHS figures as-is (no second multiplication by the rate)", () => {
    const src = readSource(ORDER_PAGE);
    expect(src).toContain('formatCurrency(keepupTotal, "GHS")');
    expect(src).not.toContain('formatCurrency(keepupTotal * usdToGhs, "GHS")');
    expect(src).not.toContain("order.invoiceAmount * usdToGhs - (keepupPaid ?? 0)");
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
  it(PRESERVE("marks Paid when Keepup balance <= 0 and Partial when something was paid; ignores unsynced and Paid orders (super_admin only since Phase 7F / A4)"), async () => {
    const s = await syncWorld();
    vi.mocked(s.w.keepup.getKeepupSale).mockImplementation(async (id: string) =>
      id === "KU-P" ? { totalAmount: 1250, amountPaid: 1250, balanceDue: 0 } : id === "KU-Q" ? { totalAmount: 1250, amountPaid: 500, balanceDue: 750 } : { totalAmount: 1250, amountPaid: 500, balanceDue: 750 }
    );
    expect((await s.w.call("orders/keepup-sync", "POST", { token: s.staff })).status).toBe(403);   // A4: staff must not force a Keepup sync
    const res = await s.w.call("orders/keepup-sync", "POST", { token: s.admin });
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
