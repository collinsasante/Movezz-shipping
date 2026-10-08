// IDOR / BOLA characterization: can customer A reach customer B's data? Also existence leaks.
import { describe, it, expect } from "vitest";
import { standardWorld } from "../helpers/world";
import { KNOWN_BUG, PRESERVE } from "../helpers/known";

async function seeded() {
  const s = await standardWorld();
  s.w.seed.item("recIA", "recCustA", { TrackingNumber: "TRK-A-111" });
  s.w.seed.item("recIB", "recCustB", { TrackingNumber: "TRK-B-222" });
  s.w.seed.order("recOA", "recCustA", { Items: ["recIA"] });
  s.w.seed.order("recOB", "recCustB", { Items: ["recIB"] });
  return s;
}
const ids = (res: { json?: Record<string, any> }) => (res.json?.data as { id: string }[]).map((x) => x.id); // eslint-disable-line @typescript-eslint/no-explicit-any

describe("customer A -> customer data", () => {
  it(PRESERVE("customer A -> customer A: allowed; customer A -> customer B: denied (403); admin and staff: allowed"), async () => {
    const s = await seeded();
    expect((await s.w.call("customers/[id]", "GET", { token: s.custA, params: { id: "recCustA" } })).status).toBe(200);
    const denied = await s.w.call("customers/[id]", "GET", { token: s.custA, params: { id: "recCustB" } });
    expect(denied.status).toBe(403);
    expect(denied.json?.error).toBe("Access denied");
    expect((await s.w.call("customers/[id]", "GET", { token: s.admin, params: { id: "recCustB" } })).status).toBe(200);
    expect((await s.w.call("customers/[id]", "GET", { token: s.staff, params: { id: "recCustB" } })).status).toBe(200);
  });
  it(PRESERVE("customer lookups do not reveal whether an id exists (403 for both B and a non-existent id)"), async () => {
    const s = await seeded();
    expect((await s.w.call("customers/[id]", "GET", { token: s.custA, params: { id: "recNope" } })).status).toBe(403);
  });
  it(PRESERVE("customer A cannot modify customer B (403)"), async () => {
    const s = await seeded();
    expect((await s.w.call("customers/[id]", "PATCH", { token: s.custA, params: { id: "recCustB" }, body: { notes: "pwned" } })).status).toBe(403);
    expect(s.w.db.get("Customers", "recCustB")?.fields["Notes"]).toBeUndefined();
  });
  it(PRESERVE("a customer's self-update silently strips privileged fields (package, status, email, shippingMark) and returns 200"), async () => {
    const s = await seeded();
    const res = await s.w.call("customers/[id]", "PATCH", {
      token: s.custA,
      params: { id: "recCustA" },
      body: { notes: "hello", package: "special", status: "inactive", email: "evil@example.invalid", shippingMark: "HACK-1" },
    });
    expect(res.status).toBe(200);
    expect(s.w.db.get("Customers", "recCustA")?.fields).toMatchObject({ Notes: "hello", Status: "active", CustomerPackage: "basic", ShippingMark: "MOVEZZ-AM1111" });
    expect(s.w.db.get("Customers", "recCustA")?.fields["Email"]).not.toBe("evil@example.invalid");
  });
  it(KNOWN_BUG("a customer can set their preferred warehouse to ANY string (no existence/active check)"), async () => {
    const s = await seeded();
    const res = await s.w.call("customers/me/warehouse", "PATCH", { token: s.custA, body: { warehouseId: "recDoesNotExist" } });
    expect(res.status).toBe(200);
    expect(s.w.db.get("Customers", "recCustA")?.fields["PreferredWarehouse"]).toBe("recDoesNotExist");
  });
});

describe("customer A -> items", () => {
  it(PRESERVE("the list contains only the customer's own items; a customerId query parameter is ignored"), async () => {
    const s = await seeded();
    expect(ids(await s.w.call("items", "GET", { token: s.custA }))).toEqual(["recIA"]);
    expect(ids(await s.w.call("items", "GET", { token: s.custA, query: { customerId: "recCustB" } }))).toEqual(["recIA"]);
  });
  it(PRESERVE("search only matches within the customer's own items"), async () => {
    const s = await seeded();
    expect(ids(await s.w.call("items", "GET", { token: s.custA, query: { search: "TRK-B-222" } }))).toEqual([]);
  });
  it(PRESERVE("A -> A item allowed, A -> B item denied (403)"), async () => {
    const s = await seeded();
    expect((await s.w.call("items/[id]", "GET", { token: s.custA, params: { id: "recIA" } })).status).toBe(200);
    expect((await s.w.call("items/[id]", "GET", { token: s.custA, params: { id: "recIB" } })).status).toBe(403);
  });
  it(KNOWN_BUG("item lookups leak existence: 403 for someone else's item, 404 for a non-existent one"), async () => {
    // Future behavior (Phase 3, D.1): ownership failures return 404 so existence is not revealed. Documents current behavior only.
    const s = await seeded();
    const other = await s.w.call("items/[id]", "GET", { token: s.custA, params: { id: "recIB" } });
    const none = await s.w.call("items/[id]", "GET", { token: s.custA, params: { id: "recNope" } });
    expect([other.status, none.status]).toEqual([403, 404]);
  });
  it(PRESERVE("A -> B item history denied (403)"), async () => {
    const s = await seeded();
    expect((await s.w.call("items/[id]/history", "GET", { token: s.custA, params: { id: "recIB" } })).status).toBe(403);
    expect((await s.w.call("items/[id]/history", "GET", { token: s.custA, params: { id: "recIA" } })).status).toBe(200);
  });
  it(KNOWN_BUG("item history leaks existence differently again: 500 for a non-existent item"), async () => {
    const s = await seeded();
    expect((await s.w.call("items/[id]/history", "GET", { token: s.custA, params: { id: "recNope" } })).status).toBe(500);
  });
  it(PRESERVE("a customer cannot change or delete items or their status (403)"), async () => {
    const s = await seeded();
    expect((await s.w.call("items/[id]", "PATCH", { token: s.custA, params: { id: "recIA" }, body: { description: "x" } })).status).toBe(403);
    expect((await s.w.call("items/[id]", "DELETE", { token: s.custA, params: { id: "recIA" } })).status).toBe(403);
    expect((await s.w.call("items/[id]/status", "PATCH", { token: s.custA, params: { id: "recIA" }, body: { status: "Completed" } })).status).toBe(403);
  });
});

describe("customer A -> invoices", () => {
  it(PRESERVE("the list contains only the customer's own orders; a customerId query parameter is ignored"), async () => {
    const s = await seeded();
    expect(ids(await s.w.call("orders", "GET", { token: s.custA }))).toEqual(["recOA"]);
    expect(ids(await s.w.call("orders", "GET", { token: s.custA, query: { customerId: "recCustB" } }))).toEqual(["recOA"]);
  });
  it(PRESERVE("A -> A order allowed, A -> B order denied (403)"), async () => {
    const s = await seeded();
    expect((await s.w.call("orders/[id]", "GET", { token: s.custA, params: { id: "recOA" } })).status).toBe(200);
    expect((await s.w.call("orders/[id]", "GET", { token: s.custA, params: { id: "recOB" } })).status).toBe(403);
  });
  it(KNOWN_BUG("order lookups leak existence: 403 for someone else's order, 404 for a non-existent one"), async () => {
    const s = await seeded();
    const other = await s.w.call("orders/[id]", "GET", { token: s.custA, params: { id: "recOB" } });
    const none = await s.w.call("orders/[id]", "GET", { token: s.custA, params: { id: "recNope" } });
    expect([other.status, none.status]).toEqual([403, 404]);
  });
  it(PRESERVE("a customer cannot create, edit, delete or invoice orders (403)"), async () => {
    const s = await seeded();
    expect((await s.w.call("orders", "POST", { token: s.custA, body: {} })).status).toBe(403);
    expect((await s.w.call("orders/[id]", "PATCH", { token: s.custA, params: { id: "recOA" }, body: { status: "Paid" } })).status).toBe(403);
    expect((await s.w.call("orders/[id]", "DELETE", { token: s.custA, params: { id: "recOA" } })).status).toBe(403);
  });
});

describe(KNOWN_BUG("a customer user with NO linked customer record sees EVERYONE's items and orders"), () => {
  // Phase 3 section F: customer reads are always filtered by the caller's customer_id (NOT NULL for role=customer).
  // This test documents current behavior only. It must be inverted when authorization moves into the repository layer.
  async function orphanCustomer() {
    const s = await seeded();
    const token = s.w.asUser("customer"); // Users row with Role=customer but no CustomerRecord link
    return { ...s, token };
  }
  it("documents that GET /api/items returns every customer's items", async () => {
    const s = await orphanCustomer();
    expect(ids(await s.w.call("items", "GET", { token: s.token })).sort()).toEqual(["recIA", "recIB"]);
  });
  it("documents that GET /api/orders returns every customer's orders", async () => {
    const s = await orphanCustomer();
    expect(ids(await s.w.call("orders", "GET", { token: s.token })).sort()).toEqual(["recOA", "recOB"]);
  });
  it("documents that the other customer-scoped routes still deny (customer detail 403, dashboard 400)", async () => {
    const s = await orphanCustomer();
    expect((await s.w.call("customers/[id]", "GET", { token: s.token, params: { id: "recCustA" } })).status).toBe(403);
    expect((await s.w.call("dashboard/customer", "GET", { token: s.token })).status).toBe(400);
    expect((await s.w.call("items/[id]", "GET", { token: s.token, params: { id: "recIA" } })).status).toBe(403);
  });
});

describe("staff and admin visibility (no tenant restriction by design)", () => {
  it(PRESERVE("admin and staff see every customer's items and orders"), async () => {
    const s = await seeded();
    expect(ids(await s.w.call("items", "GET", { token: s.staff })).sort()).toEqual(["recIA", "recIB"]);
    expect(ids(await s.w.call("orders", "GET", { token: s.admin })).sort()).toEqual(["recOA", "recOB"]);
  });
});
