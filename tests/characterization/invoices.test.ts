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

  it(FIXED("a discount larger than the invoice is rejected (it used to be silently clamped to a 0 net amount)"), async () => {
    const s = await orderWith({ items: { recI1: {} } });
    const patch = await s.w.call("orders/[id]", "PATCH", { token: s.admin, params: { id: "recOrd1" }, body: { discount: 500 } });
    expect(patch.status).toBe(400);
    expect(s.w.db.get("Orders", "recOrd1")?.fields["Discount"]).toBeUndefined();
    // lowering the invoice below an existing discount is rejected too
    s.w.db.update("Orders", "recOrd1", { Discount: 80 });
    expect((await s.w.call("orders/[id]", "PATCH", { token: s.admin, params: { id: "recOrd1" }, body: { invoiceAmount: 50 } })).status).toBe(400);
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

describe("create-invoice: the exchange rate", () => {
  it(FIXED("with no configured rate the invoice is refused (409), not created at rate 1"), async () => {
    const s = await orderWith({ items: { recI1: {} }, rate: null });
    const res = await createInvoice(s);
    expect(res.status).toBe(409);
    expect(s.w.keepup.createKeepupSale).not.toHaveBeenCalled();
    expect(s.w.db.get("Orders", "recOrd1")?.fields["KeepupSaleId"]).toBeUndefined();
  });
  it(FIXED("an invalid rate (0 or negative) is refused the same way"), async () => {
    const s = await orderWith({ items: { recI1: {} }, rate: 0 });
    expect((await createInvoice(s)).status).toBe(409);
  });
  it(KNOWN_BUG("nothing about the rate or GHS amount is stored on the order (no FX snapshot)"), async () => {
    // Needs the PostgreSQL phase: usd_total, fx_rate and ghs_total frozen on the invoice (an Airtable schema change is not made here).
    const s = await orderWith({ items: { recI1: {} } });
    await createInvoice(s);
    expect(Object.keys(s.w.db.get("Orders", "recOrd1")?.fields ?? {}).sort()).toEqual(
      ["Customer", "InvoiceAmount", "InvoiceDate", "Items", "KeepupLink", "KeepupSaleId", "OrderRef", "Status"].sort()
    );
  });
  it(KNOWN_BUG("regenerating after the rate changed produces a DIFFERENT GHS amount for the same USD invoice"), async () => {
    const s = await orderWith({ items: { recI1: {} }, rate: 10 });
    await createInvoice(s);
    s.w.db.all("Settings")[0].fields["UsdToGhs"] = 12;
    await createInvoice(s, { regenerate: true });
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

  it(FIXED("a client-supplied itemPriceMap is ignored: lines are weighted by the stored item prices"), async () => {
    const s = await orderWith({
      items: {
        recI1: { Length: 100, Width: 100, Height: 10, PkgEstShipping: 10 },
        recI2: { Length: 100, Width: 100, Height: 30, PkgEstShipping: 30 },
      },
      amount: 100,
    });
    await createInvoice(s, { itemPriceMap: { recI1: 900, recI2: 1 } }); // forged: tries to push the total onto item 1
    expect(lines(s.w).map((l) => l.price)).toEqual([312.5, 937.5]); // 10:30 stored prices
    expect(sum(lines(s.w).map((l) => l.price))).toBe(1250);
  });
  it(FIXED("a special-rate item's line is weighted by its special price, not its tier price"), async () => {
    const s = await orderWith({
      items: {
        recI1: { PkgEstShipping: 10, EstShippingPrice: 30, IsSpecialItem: true, specialRateName: "Bulk Lagos" },
        recI2: { PkgEstShipping: 10 },
      },
      amount: 40,
    });
    await createInvoice(s);
    expect(lines(s.w).map((l) => l.price)).toEqual([375, 125]); // 30:10 of 500
  });
  it("without stored prices it falls back to the CBM split", async () => {
    const s = await orderWith({ items: { recI1: { Length: 100, Width: 100, Height: 10 }, recI2: { Length: 100, Width: 100, Height: 30 } }, amount: 100 });
    await createInvoice(s, { itemPriceMap: { recI1: 30 } });
    expect(lines(s.w).map((l) => l.price)).toEqual([312.5, 937.5]);
  });
  it(FIXED("an all-zero client price map no longer produces NaN line prices"), async () => {
    const s = await orderWith({ items: { recI1: {}, recI2: {} }, amount: 100 });
    await createInvoice(s, { itemPriceMap: { recI1: 0, recI2: 0 } });
    expect(lines(s.w).map((l) => l.price)).toEqual([625, 625]);
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
    await createInvoice(s, { regenerate: true });
    expect(s.w.db.get("Orders", "recOrd1")?.fields["KeepupSaleId"]).toBe("KU-NEW");
    expect(s.w.keepup.cancelKeepupSale).toHaveBeenCalledWith("KU-OLD");
  });
  it(PRESERVE("a failure to cancel the old sale is swallowed"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { KeepupSaleId: "KU-OLD" } });
    vi.mocked(s.w.keepup.cancelKeepupSale).mockRejectedValueOnce(new Error("keepup down"));
    expect((await createInvoice(s, { regenerate: true })).status).toBe(200);
  });
  it(PRESERVE("a Keepup failure returns 500 and leaves the order untouched"), async () => {
    const s = await orderWith({ items: { recI1: {} } });
    vi.mocked(s.w.keepup.createKeepupSale).mockRejectedValueOnce(new Error("Keepup API error 500"));
    const res = await createInvoice(s);
    expect(res.status).toBe(500);
    expect(s.w.db.get("Orders", "recOrd1")?.fields["KeepupSaleId"]).toBeUndefined();
  });
  it(FIXED("a PARTIALLY PAID order cannot be regenerated (it would cancel the sale that holds the payments)"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { Status: "Partial", AmountPaid: 40, KeepupSaleId: "KU-OLD" } });
    const res = await createInvoice(s, { regenerate: true });
    expect(res.status).toBe(409);
    expect(s.w.keepup.createKeepupSale).not.toHaveBeenCalled();
    expect(s.w.keepup.cancelKeepupSale).not.toHaveBeenCalled();
  });
  it(FIXED("create-invoice is idempotent: an order that already has a sale gets that sale back and no new external sale"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { KeepupSaleId: "KU-OLD", KeepupLink: "https://keepup.example.invalid/old" } });
    const res = await createInvoice(s);
    expect(res.status).toBe(200);
    expect(res.json?.data).toMatchObject({ saleId: "KU-OLD", link: "https://keepup.example.invalid/old", existing: true });
    expect(s.w.keepup.createKeepupSale).not.toHaveBeenCalled();
    expect(s.w.keepup.cancelKeepupSale).not.toHaveBeenCalled();
  });
  it(FIXED("two simultaneous create-invoice calls create exactly one Keepup sale"), async () => {
    const s = await orderWith({ items: { recI1: {} } });
    const [a, b] = await Promise.all([createInvoice(s), createInvoice(s)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(s.w.keepup.createKeepupSale).toHaveBeenCalledTimes(1);
    expect(a.json?.data.saleId).toBe(b.json?.data.saleId);
  });
  it(FIXED("the customer is emailed once, in GHS, with the link of the sale that exists"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { Discount: 10 } });
    await createInvoice(s);
    await createInvoice(s); // repeat
    await vi.waitFor(() => expect(s.w.email.sendInvoiceCreatedEmail).toHaveBeenCalledTimes(1));
    expect(vi.mocked(s.w.email.sendInvoiceCreatedEmail).mock.calls[0][0]).toMatchObject({
      invoiceAmount: 1125, currency: "GHS", keepupLink: "https://keepup.example.invalid/s/KU-TEST-1", itemCount: 1,
    });
  });
  it(FIXED("regenerating does not email the customer again"), async () => {
    const s = await orderWith({ items: { recI1: {} }, order: { KeepupSaleId: "KU-OLD" } });
    await createInvoice(s, { regenerate: true });
    expect(s.w.email.sendInvoiceCreatedEmail).not.toHaveBeenCalled();
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

  it(FIXED("creating an order no longer creates a Keepup sale or emails: create-invoice is the single authoritative creation"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.settings(12.5);
    w.seed.item("recI1", "recCustA");
    w.seed.item("recI2", "recCustA");
    const res = await w.call("orders", "POST", { token: admin, body: body({ itemIds: ["recI1", "recI2"] }) });
    expect(res.status).toBe(201);
    expect(w.keepup.createKeepupSale).not.toHaveBeenCalled();
    expect(w.email.sendInvoiceCreatedEmail).not.toHaveBeenCalled();
    expect(res.json?.data.keepupSaleId).toBeUndefined();
  });

  it(FIXED("the UI's two-step flow (POST /api/orders then create-invoice) yields exactly ONE Keepup sale, in GHS, and one email with its link"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.settings(12.5);
    w.seed.item("recI1", "recCustA");
    const created = await w.call("orders", "POST", { token: admin, body: body() });
    const orderId = created.json?.data.id as string;
    await w.call("orders/[id]/create-invoice", "POST", { token: admin, params: { id: orderId }, body: {} }); // what orders/new/page.tsx does next
    expect(w.keepup.createKeepupSale).toHaveBeenCalledTimes(1);
    expect(w.keepup.cancelKeepupSale).not.toHaveBeenCalled();
    expect((w.keepup.createKeepupSale as ReturnType<typeof vi.fn>).mock.calls[0][0].items.map((l: LineItem) => l.price)).toEqual([1250]); // 100 USD x 12.5
    expect(w.db.get("Orders", orderId)?.fields["KeepupSaleId"]).toBe("KU-TEST-1");
    await vi.waitFor(() => expect(w.email.sendInvoiceCreatedEmail).toHaveBeenCalledTimes(1));
    expect(vi.mocked(w.email.sendInvoiceCreatedEmail).mock.calls[0][0]).toMatchObject({ invoiceAmount: 1250, currency: "GHS", keepupLink: "https://keepup.example.invalid/s/KU-TEST-1" });
  });

  it(FIXED("the line prices always add back to the GHS total (distribution is by create-invoice, remainder on the last line)"), async () => {
    const s = await orderWith({ items: { recI1: {}, recI2: {}, recI3: {} }, amount: 100, rate: 1 });
    await createInvoice(s);
    expect(lines(s.w).map((l) => l.price)).toEqual([33.33, 33.33, 33.34]);
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
