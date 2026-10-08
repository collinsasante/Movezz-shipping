// What can the CLIENT dictate? Price, totals, exchange rate, payment status, discount, tier, folders, UIDs.
// Every test documents current behavior; the Phase 3 specification makes all of these server-authoritative.
import { describe, it, expect, vi } from "vitest";
import { standardWorld } from "../helpers/world";
import { KNOWN_BUG, PRESERVE } from "../helpers/known";

describe(KNOWN_BUG("item prices are accepted from the client exactly as sent"), () => {
  // Future behavior (Phase 3 R-9 / ADR-7): the server computes price; price/rate/tier fields from the client are rejected.
  it("documents that POST /api/items stores client-supplied price, rate and special-rate fields verbatim, even if inconsistent with the dimensions", async () => {
    const { w, staff } = await standardWorld();
    const res = await w.call("items", "POST", {
      token: staff,
      body: {
        customerId: "recCustA", description: "Laptop", dateReceived: "2026-03-01", shippingType: "sea",
        length: 100, width: 100, height: 100, // 1 m3 -> would be 350 at the basic rate
        estPrice: 1, estShippingPrice: 0.01, pkgEstShipping: 0.01, pkgShippingRate: 0.01, specialShippingRate: 0.01, isSpecialItem: true, specialRateName: "Anything",
      },
    });
    expect(res.status).toBe(201);
    expect(w.db.all("Items")[0].fields).toMatchObject({ EstPrice: 1, EstShippingPrice: 0.01, PkgEstShipping: 0.01, PkgShippingRate: 0.01, SpecialShippingRate: 0.01, IsSpecialItem: true, specialRateName: "Anything" });
  });
  it("documents that PATCH /api/items/[id] lets staff overwrite the price of an item that is already invoiced", async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 100, Order: ["recO1"] });
    const res = await w.call("items/[id]", "PATCH", { token: staff, params: { id: "recI1" }, body: { pkgEstShipping: 1, estShippingPrice: 1 } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields["PkgEstShipping"]).toBe(1);
  });
  it("documents that staff can re-assign an invoiced item to a different customer, and to a container id that does not exist", async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Order: ["recO1"] });
    const res = await w.call("items/[id]", "PATCH", { token: staff, params: { id: "recI1" }, body: { customerId: "recCustB", containerId: "recNoSuchContainer" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields).toMatchObject({ Customer: ["recCustB"], Container: ["recNoSuchContainer"], Order: ["recO1"] });
  });
});

describe(KNOWN_BUG("invoice totals, discounts and payment status are accepted from the client"), () => {
  it("documents that invoiceAmount is whatever the admin client sends (including 0.01 for expensive goods)", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { PkgEstShipping: 5000 });
    const res = await w.call("orders", "POST", { token: admin, body: { customerId: "recCustA", itemIds: ["recI1"], invoiceAmount: 0.01, invoiceDate: "2026-03-10" } });
    expect(res.status).toBe(201);
  });
  it("documents that the order status can be set straight to Paid with no payment", async () => {
    const { w, admin } = await standardWorld();
    w.seed.order("recO1", "recCustA", { Status: "Pending" });
    const res = await w.call("orders/[id]", "PATCH", { token: admin, params: { id: "recO1" }, body: { status: "Paid" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Orders", "recO1")?.fields["Status"]).toBe("Paid");
  });
  it("documents that a discount larger than the invoice, and an amount edit after invoicing, are accepted", async () => {
    const { w, admin } = await standardWorld();
    w.seed.order("recO1", "recCustA", { InvoiceAmount: 100, KeepupSaleId: "KU-1" });
    const res = await w.call("orders/[id]", "PATCH", { token: admin, params: { id: "recO1" }, body: { discount: 99999, invoiceAmount: 1 } });
    expect(res.status).toBe(200);
    expect(w.db.get("Orders", "recO1")?.fields).toMatchObject({ Discount: 99999, InvoiceAmount: 1 });
  });
});

describe("exchange rate", () => {
  it(PRESERVE("is a single global value; only super_admin may change it"), async () => {
    const { w, admin, staff, custA } = await standardWorld();
    expect((await w.call("settings", "PUT", { token: staff, body: { usdToGhs: 12, shippingRatePerCbm: 1 } })).status).toBe(403);
    expect((await w.call("settings", "PUT", { token: custA, body: { usdToGhs: 12, shippingRatePerCbm: 1 } })).status).toBe(403);
    expect((await w.call("settings", "PUT", { token: admin, body: { usdToGhs: 12, shippingRatePerCbm: 1 } })).status).toBe(200);
  });
  it(PRESERVE("a client-supplied rate in the create-invoice body is ignored"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.settings(10);
    w.seed.item("recI1", "recCustA");
    w.seed.order("recO1", "recCustA", { InvoiceAmount: 100, Items: ["recI1"] });
    await w.call("orders/[id]/create-invoice", "POST", { token: admin, params: { id: "recO1" }, body: { usdToGhs: 999, exchangeRate: 999 } });
    expect(vi.mocked(w.keepup.createKeepupSale).mock.calls[0][0].items[0].price).toBe(1000);
  });
  it(KNOWN_BUG("the rate has no sanity bounds (0.0001 and 1,000,000,000 are accepted)"), async () => {
    const { w, admin } = await standardWorld();
    expect((await w.call("settings", "PUT", { token: admin, body: { usdToGhs: 0.0001, shippingRatePerCbm: 1 } })).status).toBe(200);
    expect((await w.call("settings", "PUT", { token: admin, body: { usdToGhs: 1_000_000_000, shippingRatePerCbm: 1 } })).status).toBe(200);
    expect((await w.call("settings", "PUT", { token: admin, body: { usdToGhs: 0, shippingRatePerCbm: 1 } })).status).toBe(400);
  });
  it(KNOWN_BUG("ShippingRatePerCbm is stored by Settings but never used by any pricing code"), async () => {
    const { w, admin } = await standardWorld();
    await w.call("settings", "PUT", { token: admin, body: { usdToGhs: 12, shippingRatePerCbm: 777 } });
    expect(w.db.all("Settings")[0].fields["ShippingRatePerCbm"]).toBe(777);
    // (verified by search: no other source file reads shippingRatePerCbm - see docs/CHARACTERIZATION-BASELINE.md)
  });
});

describe(KNOWN_BUG("package rate writes are not validated"), () => {
  it("documents that PUT /api/package-rates writes ANY tier name with ANY values (negative, non-numeric)", async () => {
    const { w, admin } = await standardWorld();
    const res = await w.call("package-rates", "PUT", { token: admin, body: { evil: { sea: -5, air: "free" } } });
    expect(res.status).toBe(200);
    const row = w.db.all("PackageRates").find((r) => r.fields["Tier"] === "evil");
    expect(row?.fields).toMatchObject({ Tier: "evil", Sea: -5, Air: "free" });
  });
  it("documents that a malformed body is a 500, not a 400", async () => {
    const { w, admin } = await standardWorld();
    expect((await w.call("package-rates", "PUT", { token: admin, body: null })).status).toBe(500);
  });
  it("documents that the customer tier can be set to a customer by an admin without any pricing audit", async () => {
    const { w, admin } = await standardWorld();
    const res = await w.call("customers/[id]", "PATCH", { token: admin, params: { id: "recCustA" }, body: { package: "special", exchangeRate: 0.0001 } });
    expect(res.status).toBe(200);
    expect(w.db.get("Customers", "recCustA")?.fields).toMatchObject({ CustomerPackage: "special", ExchangeRate: 0.0001 });
  });
});

describe(KNOWN_BUG("user deletion and uploads trust client-supplied identifiers"), () => {
  it("documents that DELETE /api/users/[id] deletes whatever Firebase UID the request body names", async () => {
    const { w, admin } = await standardWorld();
    const res = await w.call("users/[id]", "DELETE", { token: admin, params: { id: "recAnything" }, body: { firebaseUid: "some-unrelated-firebase-uid" } });
    expect(res.status).toBe(500); // the Airtable row id does not exist, but...
    expect(w.firebase.deleteFirebaseUser).toHaveBeenCalledWith("some-unrelated-firebase-uid"); // ...the Firebase account was already deleted
  });
  it("documents that the last super_admin can delete their own account", async () => {
    const { w, admin } = await standardWorld();
    const row = w.db.all("Users").find((r) => r.fields["Role"] === "super_admin")!;
    const res = await w.call("users/[id]", "DELETE", { token: admin, params: { id: row.id }, body: {} });
    expect(res.status).toBe(200);
    expect(w.db.all("Users").some((r) => r.fields["Role"] === "super_admin")).toBe(false);
  });
  it("documents that /api/upload/sign signs whatever folder the client asks for, with no file type or size limits", async () => {
    const { w, staff } = await standardWorld();
    const res = await w.call("upload/sign", "POST", { token: staff, body: { folder: "../../anywhere/else" } });
    expect(res.status).toBe(200);
    expect(res.json?.data).toMatchObject({ folder: "../../anywhere/else", signature: "test-only-signature" });
  });
  it("documents that item photo URLs are only checked to be URLs (any host, up to 20 per item)", async () => {
    const { w, staff } = await standardWorld();
    const res = await w.call("items", "POST", { token: staff, body: { customerId: "recCustA", description: "x", dateReceived: "2026-03-01", photoUrls: ["https://attacker.example.invalid/tracker.png"] } });
    expect(res.status).toBe(201);
  });
});

describe("test-suite safety", () => {
  it("never reaches the network: fetch is blocked and the credentials are test-only", async () => {
    const { w } = await standardWorld();
    expect(process.env.AIRTABLE_API_KEY).toMatch(/^test-only-/);
    expect(process.env.KEEPUP_API_KEY).toMatch(/^test-only-/);
    expect(process.env.RESEND_API_KEY).toMatch(/^test-only-/);
    expect(process.env.CLOUDINARY_API_SECRET).toMatch(/^test-only-/);
    expect(process.env.FIREBASE_PRIVATE_KEY).toMatch(/^test-only-/);
    expect(() => fetch("https://api.airtable.com/v0/anything")).toThrow(/Outbound network access is blocked/);
    expect(w.db).toBeDefined();
  });
});
