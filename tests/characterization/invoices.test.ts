// Invoice creation: POST /api/orders and POST /api/orders/[id]/create-invoice (Keepup).
// Keepup is mocked (tests/setup/setup.ts); the calls it receives are what the production code would send.
import { describe, it, expect, vi } from "vitest";
import { standardWorld, type World } from "../helpers/world";
import { KNOWN_BUG, PRESERVE, FIXED } from "../helpers/known";

type LineItem = { item_name: string; quantity: number; price: number; item_type: string };
const sale = (w: World, n = 0) => vi.mocked(w.keepup.createKeepupSale).mock.calls[n][0];
const lines = (w: World, n = 0) => sale(w, n).items as LineItem[];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** An order of `invoiceAmount` USD over the given items, ready for create-invoice. */
async function orderWith(opts: { items: Record<string, Record<string, unknown>>; amount?: number; rate?: number | null; order?: Record<string, unknown> }) {
  const s = await standardWorld();
  const { w } = s;
  if (opts.rate !== null) w.seed.settings(opts.rate ?? 12.5);
  for (const [id, f] of Object.entries(opts.items)) w.seed.item(id, "recCustA", f);
  w.seed.order("recOrd1", "recCustA", { InvoiceAmount: opts.amount ?? 100, Items: Object.keys(opts.items), ...(opts.order ?? {}) });
  return s;
}
const createInvoice = (s: Awaited<ReturnType<typeof orderWith>>, body: unknown = {}) =>
  s.w.call("orders/[id]/create-invoice", "POST", { token: s.admin, params: { id: "recOrd1" }, body });

describe("create-invoice: USD order -> GHS Keepup invoice", () => {
  it(PRESERVE("converts the USD invoice amount to GHS at the CURRENT global rate and sends customer details"), async () => {
    const s = await orderWith({ items: { recI1: { Description: "Laptop", TrackingNumber: "1Z999", Length: 100, Width: 100, Height: 10 } } });
    const res = await createInvoice(s);
    expect(res.status).toBe(200);
    expect(sale(s.w)).toMatchObject({ customerName: "Ada Mensah", customerEmail: "reccusta@example.invalid", customerPhone: "0244001111", invoiceDate: "2026-03-10" });
    expect(lines(s.w)).toEqual([{ item_name: "Laptop [TRK: 1Z999] [CBM: 0.1000m3]", quantity: 1, price: 1250, item_type: "product" }]); // 100 USD x 12.5
  });

  it(PRESERVE("stores the Keepup sale id and link on the order"), async () => {
    const s = await orderWith({ items: { recI1: {} } });
    await createInvoice(s);
    expect(s.w.db.get("Orders", "recOrd1")?.fields).toMatchObject({ KeepupSaleId: "KU-TEST-1", KeepupLink: "https://keepup.example.invalid/s/KU-TEST-1" });
  });

  it(PRESERVE("a discount is subtracted in USD before conversion (net = (amount - discount) x rate)"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { Discount: 10 } });
    await createInvoice(s);
    expect(lines(s.w)[0].price).toBe(1125); // (100 - 10) x 12.5
  });

  it(PRESERVE("a zero discount changes nothing"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { Discount: 0 } });
    await createInvoice(s);
    expect(lines(s.w)[0].price).toBe(1250);
  });

  it("a discount equal to the amount (full-discount boundary) produces a 0-priced line", async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { Discount: 100 } });
    await createInvoice(s);
    expect(lines(s.w)[0].price).toBe(0);
  });

  it(KNOWN_BUG("a discount larger than the invoice is accepted and silently clamped to a 0 net amount"), async () => {
    // Future behavior (Phase 3 R-18): 0 <= discount <= subtotal, enforced with a CHECK constraint. Documents current behavior only.
    const s = await orderWith({ items: { recI1: {} } });
    const patch = await s.w.call("orders/[id]", "PATCH", { token: s.admin, params: { id: "recOrd1" }, body: { discount: 500 } });
    expect(patch.status).toBe(200);
    await createInvoice(s);
    expect(lines(s.w)[0].price).toBe(0);
  });

  it("rejects a negative discount with 400", async () => {
    const s = await orderWith({ items: { recI1: {} } });
    const patch = await s.w.call("orders/[id]", "PATCH", { token: s.admin, params: { id: "recOrd1" }, body: { discount: -5 } });
    expect(patch.status).toBe(400);
  });

  it(PRESERVE("refuses to create an invoice for a Paid order (400)"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { Status: "Paid" } });
    const res = await createInvoice(s);
    expect(res.status).toBe(400);
    expect(s.w.keepup.createKeepupSale).not.toHaveBeenCalled();
  });

  it(PRESERVE("is admin-only"), async () => {
    const s = await orderWith({ items: { recI1: {} } });
    const res = await s.w.call("orders/[id]/create-invoice", "POST", { token: s.staff, params: { id: "recOrd1" }, body: {} });
    expect(res.status).toBe(403);
  });
});

describe(KNOWN_BUG("the exchange rate is read live and silently defaults to 1"), () => {
  // Future behavior (Phase 3 R-19): the rate is frozen on the invoice; a missing rate is an error.
  it("documents that with NO Settings row the invoice is created at rate 1 (USD number sent as GHS)", async () => {
    const s = await orderWith({ items: { recI1: {} }, rate: null });
    const res = await createInvoice(s);
    expect(res.status).toBe(200);
    expect(lines(s.w)[0].price).toBe(100);
  });
  it("documents that nothing about the rate or GHS amount is stored on the order (no FX snapshot)", async () => {
    const s = await orderWith({ items: { recI1: {} } });
    await createInvoice(s);
    expect(Object.keys(s.w.db.get("Orders", "recOrd1")?.fields ?? {}).sort()).toEqual(
      ["Customer", "InvoiceAmount", "InvoiceDate", "Items", "KeepupLink", "KeepupSaleId", "OrderRef", "Status"].sort()
    );
  });
  it("documents that re-creating the invoice after the rate changed produces a DIFFERENT GHS amount for the same USD invoice", async () => {
    const s = await orderWith({ items: { recI1: {} }, rate: 10 });
    await createInvoice(s);
    s.w.db.all("Settings")[0].fields["UsdToGhs"] = 12;
    await createInvoice(s);
    expect([lines(s.w, 0)[0].price, lines(s.w, 1)[0].price]).toEqual([1000, 1200]);
  });
});

describe("create-invoice: splitting the net GHS amount across lines and rounding", () => {
  it(PRESERVE("without client prices, splits proportionally to CBM; the last line absorbs the remainder"), async () => {
    const s = await orderWith({
      items: { recI1: { Length: 100, Width: 100, Height: 10 }, recI2: { Length: 100, Width: 100, Height: 30 } }, // 0.1 and 0.3 m3
      amount: 100,
    });
    await createInvoice(s);
    expect(lines(s.w).map((l) => l.price)).toEqual([312.5, 937.5]); // 1250 x 25% / 75%
  });

  it("without dimensions, splits equally and the last line absorbs the rounding (100.00 over 3 -> 33.33, 33.33, 33.34)", async () => {
    const s = await orderWith({ items: { recI1: {}, recI2: {}, recI3: {} }, amount: 100, rate: 1 });
    await createInvoice(s);
    expect(lines(s.w).map((l) => l.price)).toEqual([33.33, 33.33, 33.34]);
    expect(Math.round(sum(lines(s.w).map((l) => l.price)) * 100) / 100).toBe(100);
  });

  it("line totals always add back to the net GHS total (rounding is per line, remainder on the last)", async () => {
    const s = await orderWith({ items: { recI1: { Length: 33, Width: 31, Height: 7 }, recI2: { Length: 21, Width: 17, Height: 9 }, recI3: { Length: 12, Width: 12, Height: 12 } }, amount: 187.77, rate: 12.34 });
    await createInvoice(s);
    const net = Math.round(187.77 * 12.34 * 100) / 100;
    expect(Math.round(sum(lines(s.w).map((l) => l.price)) * 100) / 100).toBe(net);
  });

  it(PRESERVE("converts USD->GHS with a single rounding of amount x rate to 2 decimals"), async () => {
    const s = await orderWith({ items: { recI1: {} }, amount: 33.333, rate: 12.3456 });
    await createInvoice(s);
    expect(lines(s.w)[0].price).toBe(411.52); // round(33.333 x 12.3456 x 100) / 100
  });

  it(PRESERVE("with a client itemPriceMap for ALL items, splits proportionally to those client prices"), async () => {
    const s = await orderWith({ items: { recI1: { Length: 100, Width: 100, Height: 10 }, recI2: { Length: 100, Width: 100, Height: 30 } }, amount: 100 });
    await createInvoice(s, { itemPriceMap: { recI1: 30, recI2: 10 } }); // opposite of the CBM split
    expect(lines(s.w).map((l) => l.price)).toEqual([937.5, 312.5]);
  });

  it("falls back to the CBM split when the client map misses any item", async () => {
    const s = await orderWith({ items: { recI1: { Length: 100, Width: 100, Height: 10 }, recI2: { Length: 100, Width: 100, Height: 30 } }, amount: 100 });
    await createInvoice(s, { itemPriceMap: { recI1: 30 } });
    expect(lines(s.w).map((l) => l.price)).toEqual([312.5, 937.5]);
  });

  it(KNOWN_BUG("a client price map that sums to 0 produces NaN line prices"), async () => {
    // Future behavior: server-side pricing makes the client map obsolete. Documents current behavior only.
    const s = await orderWith({ items: { recI1: {}, recI2: {} }, amount: 100 });
    await createInvoice(s, { itemPriceMap: { recI1: 0, recI2: 0 } });
    expect(lines(s.w).every((l) => Number.isNaN(l.price))).toBe(true);
  });

  it(PRESERVE("a carton is ONE invoice line named after the carton, priced like any other group"), async () => {
    const s = await orderWith({
      items: {
        recI1: { CartonNumber: "CTN-0001", CartonLength: 100, CartonWidth: 100, CartonHeight: 10, TrackingNumber: "TRK1" },
        recI2: { CartonNumber: "CTN-0001", CartonLength: 100, CartonWidth: 100, CartonHeight: 10, TrackingNumber: "TRK2" },
        recI3: { Length: 100, Width: 100, Height: 10 },
      },
      amount: 100,
    });
    await createInvoice(s);
    expect(lines(s.w)).toHaveLength(2);
    expect(lines(s.w)[0].item_name).toBe("Carton CTN-0001 (2 pkgs: TRK1, TRK2) [CBM: 0.1000m3]");
    expect(lines(s.w).map((l) => l.price)).toEqual([625, 625]);
  });

  it(PRESERVE("items that fail to load are skipped; with none left a single 'Freight - <order ref>' line is sent"), async () => {
    const s = await orderWith({ items: {}, amount: 100 });
    s.w.db.update("Orders", "recOrd1", { Items: ["recGhost"] });
    await createInvoice(s);
    expect(lines(s.w)).toEqual([{ item_name: "Freight - ORD-recOrd1", quantity: 1, price: 1250, item_type: "product" }]);
  });

  it(PRESERVE("line names are limited to printable ASCII and 200 characters"), async () => {
    const s = await orderWith({ items: { recI1: { Description: "Café ünïcode 📦 " + "x".repeat(300) } } });
    await createInvoice(s);
    const name = lines(s.w)[0].item_name;
    expect(name).toMatch(/^[\x20-\x7E]{1,200}$/);
    expect(name.startsWith("Caf ncode")).toBe(true);
  });
});

describe(FIXED("the invoice total must agree with the stored item prices"), () => {
  const post = (w: World, admin: string, over: Record<string, unknown>) =>
    w.call("orders", "POST", { token: admin, body: { customerId: "recCustA", itemIds: ["recI1"], invoiceAmount: 500, invoiceDate: "2026-03-10", ...over } });

  it("rejects an amount that does not match the priced items", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 500 });
    const res = await post(w, admin, { invoiceAmount: 0.01 });
    expect(res.status).toBe(400);
    expect(w.db.all("Orders")).toHaveLength(0);
  });
  it("accepts the exact total and a 1-cent rounding difference", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 500 });
    expect((await post(w, admin, { invoiceAmount: 500.01 })).status).toBe(201);
  });
  it("bills a special-rate item at its special price, not the tier price", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 50, EstShippingPrice: 80, IsSpecialItem: true, specialRateName: "Bulk Lagos" });
    expect((await post(w, admin, { invoiceAmount: 50 })).status).toBe(400); // the old (tier) number
    expect((await post(w, admin, { invoiceAmount: 80 })).status).toBe(201);
  });
  it("PRESERVE - an order over items that carry no stored price is still accepted (server-side pricing is a later phase)", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA");
    expect((await post(w, admin, { invoiceAmount: 123 })).status).toBe(201);
  });
});

describe("replacing an existing Keepup invoice", () => {
  it(PRESERVE("stores the NEW sale first and then cancels the old one"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { KeepupSaleId: "KU-OLD" } });
    vi.mocked(s.w.keepup.createKeepupSale).mockResolvedValueOnce({ saleId: "KU-NEW", link: "https://keepup.example.invalid/new" });
    await createInvoice(s);
    expect(s.w.db.get("Orders", "recOrd1")?.fields["KeepupSaleId"]).toBe("KU-NEW");
    expect(s.w.keepup.cancelKeepupSale).toHaveBeenCalledWith("KU-OLD");
  });
  it(PRESERVE("a failure to cancel the old sale is swallowed"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { KeepupSaleId: "KU-OLD" } });
    vi.mocked(s.w.keepup.cancelKeepupSale).mockRejectedValueOnce(new Error("keepup down"));
    expect((await createInvoice(s)).status).toBe(200);
  });
  it(PRESERVE("a Keepup failure returns 500 and leaves the order untouched"), async () => {
    const s = await orderWith({ items: { recI1: {} } });
    vi.mocked(s.w.keepup.createKeepupSale).mockRejectedValueOnce(new Error("Keepup API error 500"));
    const res = await createInvoice(s);
    expect(res.status).toBe(500);
    expect(s.w.db.get("Orders", "recOrd1")?.fields["KeepupSaleId"]).toBeUndefined();
  });
  it(KNOWN_BUG("a PARTIALLY PAID order may be re-invoiced at the full amount, cancelling the sale that holds the payments"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { Status: "Partial", AmountPaid: 40, KeepupSaleId: "KU-OLD" } });
    const res = await createInvoice(s);
    expect(res.status).toBe(200);
    expect(lines(s.w)[0].price).toBe(1250); // AmountPaid is ignored
    expect(s.w.keepup.cancelKeepupSale).toHaveBeenCalledWith("KU-OLD");
  });
  it(PRESERVE("DELETE cancels the Keepup sale and clears the ids; 400 when there is none"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { KeepupSaleId: "KU-OLD", KeepupLink: "https://x.invalid" } });
    expect((await s.w.call("orders/[id]/create-invoice", "DELETE", { token: s.admin, params: { id: "recOrd1" } })).status).toBe(200);
    expect(s.w.db.get("Orders", "recOrd1")?.fields["KeepupSaleId"]).toBeUndefined();
    expect((await s.w.call("orders/[id]/create-invoice", "DELETE", { token: s.admin, params: { id: "recOrd1" } })).status).toBe(400);
  });
});

describe("POST /api/orders", () => {
  const body = (over: Record<string, unknown> = {}) => ({ customerId: "recCustA", itemIds: ["recI1"], invoiceAmount: 100, invoiceDate: "2026-03-10", ...over });

  it(PRESERVE("creates a Pending order with the next ORD reference and links each item to it"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA");
    w.seed.item("recI2", "recCustA");
    const res = await w.call("orders", "POST", { token: admin, body: body({ itemIds: ["recI1", "recI2"] }) });
    expect(res.status).toBe(201);
    expect(res.json?.data).toMatchObject({ orderRef: "ORD-00001", status: "Pending", invoiceAmount: 100 });
    expect(w.db.get("Items", "recI1")?.fields["Order"]).toEqual([res.json?.data.id]);
    expect(w.db.get("Items", "recI2")?.fields["Order"]).toEqual([res.json?.data.id]);
  });

  it(PRESERVE("validates the body: at least one item, a positive amount up to 1,000,000"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA");
    expect((await w.call("orders", "POST", { token: admin, body: body({ itemIds: [] }) })).status).toBe(400);
    expect((await w.call("orders", "POST", { token: admin, body: body({ invoiceAmount: 0 }) })).status).toBe(400);
    expect((await w.call("orders", "POST", { token: admin, body: body({ invoiceAmount: 1_000_001 }) })).status).toBe(400);
    expect((await w.call("orders", "POST", { token: admin, body: body({ invoiceAmount: 1_000_000 }) })).status).toBe(201);
  });

  it(FIXED("items must exist, belong to the invoiced customer and not already be invoiced"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recBItem", "recCustB"); // belongs to ANOTHER customer
    w.seed.order("recOrdOld", "recCustB", { Items: ["recBItem"] });
    w.db.update("Items", "recBItem", { Order: ["recOrdOld"] }); // and is already invoiced
    const wrongOwner = await w.call("orders", "POST", { token: admin, body: body({ itemIds: ["recBItem"] }) });
    expect(wrongOwner.status).toBe(400);
    w.seed.item("recAItem", "recCustA", { Order: ["recOrdOld"] });
    expect((await w.call("orders", "POST", { token: admin, body: body({ itemIds: ["recAItem"] }) })).status).toBe(400);
    expect((await w.call("orders", "POST", { token: admin, body: body({ itemIds: ["recNoSuch"] }) })).status).toBe(400);
    expect(w.db.get("Items", "recBItem")?.fields["Order"]).toEqual(["recOrdOld"]);
    expect(w.db.get("Orders", "recOrdOld")?.fields["Items"]).toEqual(["recBItem"]);
  });

  it(KNOWN_BUG("creating an order also creates a Keepup sale in raw USD numbers, and emails the customer its link"), async () => {
    // Future behavior (Phase 3 R-17/R-22): one invoice, in GHS at a frozen rate, created once through an idempotent job.
    const { w, admin } = await standardWorld();
    w.seed.settings(12.5);
    w.seed.item("recI1", "recCustA");
    w.seed.item("recI2", "recCustA");
    const res = await w.call("orders", "POST", { token: admin, body: body({ itemIds: ["recI1", "recI2"] }) });
    expect(res.status).toBe(201);
    expect((w.keepup.createKeepupSale as ReturnType<typeof vi.fn>).mock.calls[0][0].items.map((l: LineItem) => l.price)).toEqual([50, 50]); // USD, NOT x12.5
    await vi.waitFor(() => expect(w.email.sendInvoiceCreatedEmail).toHaveBeenCalledTimes(1));
    expect(vi.mocked(w.email.sendInvoiceCreatedEmail).mock.calls[0][0]).toMatchObject({ invoiceAmount: 100, keepupLink: "https://keepup.example.invalid/s/KU-TEST-1" });
  });

  it(KNOWN_BUG("the UI's two-step flow (POST /api/orders then create-invoice) creates TWO Keepup sales; the emailed link is the one that gets cancelled"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.settings(12.5);
    w.seed.item("recI1", "recCustA");
    vi.mocked(w.keepup.createKeepupSale)
      .mockResolvedValueOnce({ saleId: "KU-FIRST", link: "https://keepup.example.invalid/first" })
      .mockResolvedValueOnce({ saleId: "KU-SECOND", link: "https://keepup.example.invalid/second" });
    const created = await w.call("orders", "POST", { token: admin, body: body() });
    const orderId = created.json?.data.id as string;
    await w.call("orders/[id]/create-invoice", "POST", { token: admin, params: { id: orderId }, body: {} }); // what orders/new/page.tsx does next
    expect(w.keepup.createKeepupSale).toHaveBeenCalledTimes(2);
    expect(w.keepup.cancelKeepupSale).toHaveBeenCalledWith("KU-FIRST");
    expect(w.db.get("Orders", orderId)?.fields["KeepupSaleId"]).toBe("KU-SECOND");
    await vi.waitFor(() => expect(w.email.sendInvoiceCreatedEmail).toHaveBeenCalled());
    expect(vi.mocked(w.email.sendInvoiceCreatedEmail).mock.calls[0][0].keepupLink).toBe("https://keepup.example.invalid/first"); // dead link
  });

  it(KNOWN_BUG("the initial Keepup lines are invoiceAmount / n rounded per line, so Keepup's total can differ from the order total"), async () => {
    const { w, admin } = await standardWorld();
    for (const id of ["recI1", "recI2", "recI3"]) w.seed.item(id, "recCustA");
    await w.call("orders", "POST", { token: admin, body: body({ itemIds: ["recI1", "recI2", "recI3"] }) });
    const prices = (w.keepup.createKeepupSale as ReturnType<typeof vi.fn>).mock.calls[0][0].items.map((l: LineItem) => l.price);
    expect(prices).toEqual([33.33, 33.33, 33.33]);
    expect(Math.round(sum(prices) * 100) / 100).toBe(99.99); // order says 100
  });

  it(PRESERVE("a Keepup failure does not fail order creation (no email is sent)"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA");
    vi.mocked(w.keepup.createKeepupSale).mockRejectedValueOnce(new Error("down"));
    const res = await w.call("orders", "POST", { token: admin, body: body() });
    expect(res.status).toBe(201);
    expect(w.email.sendInvoiceCreatedEmail).not.toHaveBeenCalled();
  });
});
