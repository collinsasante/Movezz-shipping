// IDOR / BOLA characterization: can customer A reach customer B's data? Also existence leaks.
import { describe, it, expect } from "vitest";
import { standardWorld } from "../helpers/world";
import { KNOWN_BUG, PRESERVE, FIXED } from "../helpers/known";

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
  it(FIXED("a customer's self-update with ANY protected field is rejected (400) and changes nothing"), async () => {
    const s = await seeded();
    const before = JSON.stringify(s.w.db.get("Customers", "recCustA")?.fields);
    const attempts: Record<string, unknown>[] = [
      { package: "special" }, { status: "inactive" }, { email: "evil@example.invalid" }, { shippingMark: "HACK-1" }, { shippingType: "air" },
      { exchangeRate: 0.0001 }, { role: "super_admin" }, { firebaseUid: "x" }, { customerId: "recCustB" }, { id: "recCustB" }, { preferredWarehouseId: "x" },
      { createdAt: "2000-01-01" }, { notes: "ok", package: "special" }, // a legitimate field cannot smuggle a protected one
    ];
    for (const body of attempts) {
      const res = await s.w.call("customers/[id]", "PATCH", { token: s.custA, params: { id: "recCustA" }, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(JSON.stringify(s.w.db.get("Customers", "recCustA")?.fields)).toBe(before);
  });
  it(PRESERVE("a customer can still update their own name, phone, notes and address"), async () => {
    const s = await seeded();
    const res = await s.w.call("customers/[id]", "PATCH", { token: s.custA, params: { id: "recCustA" }, body: { notes: "hello", shippingAddress: "East Legon" } });
    expect(res.status).toBe(200);
    expect(s.w.db.get("Customers", "recCustA")?.fields).toMatchObject({ Notes: "hello", ShippingAddress: "East Legon", Status: "active", CustomerPackage: "basic" });
  });
  it(FIXED("a customer can only choose an existing, ACTIVE warehouse"), async () => {
    const s = await seeded();
    s.w.db.insert("Warehouses", { Name: "Open", Address: "1 St", IsActive: true }, "recWhOpen");
    s.w.db.insert("Warehouses", { Name: "Closed", Address: "2 St", IsActive: false }, "recWhClosed");
    const call = (warehouseId: unknown) => s.w.call("customers/me/warehouse", "PATCH", { token: s.custA, body: { warehouseId } });
    expect((await call("recDoesNotExist")).status).toBe(400);
    expect((await call("recWhClosed")).status).toBe(400);
    expect((await call(12345)).status).toBe(400);
    expect(s.w.db.get("Customers", "recCustA")?.fields["PreferredWarehouse"]).toBeUndefined();
    expect((await call("recWhOpen")).status).toBe(200);
    expect(s.w.db.get("Customers", "recCustA")?.fields["PreferredWarehouse"]).toBe("recWhOpen");
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
  it(PRESERVE("A -> A item allowed; A -> B item denied"), async () => {
    const s = await seeded();
    expect((await s.w.call("items/[id]", "GET", { token: s.custA, params: { id: "recIA" } })).status).toBe(200);
    expect((await s.w.call("items/[id]", "GET", { token: s.custA, params: { id: "recIB" } })).status).toBe(404);
  });
  it(FIXED("someone else's item is indistinguishable from a non-existent one (identical 404 response)"), async () => {
    const s = await seeded();
    const other = await s.w.call("items/[id]", "GET", { token: s.custA, params: { id: "recIB" } });
    const none = await s.w.call("items/[id]", "GET", { token: s.custA, params: { id: "recNope" } });
    expect([other.status, none.status]).toEqual([404, 404]);
    expect(other.json).toEqual(none.json);
  });
  it(FIXED("A -> B item history is denied before any history is read; a missing item is the same 404 (no more 500)"), async () => {
    const s = await seeded();
    s.w.db.insert("StatusHistory", { RecordType: "Item", RecordID: "recIB", PreviousStatus: "a", NewStatus: "b", ChangedAt: "2026-03-01T00:00:00.000Z" });
    s.w.db.clearCalls();
    const other = await s.w.call("items/[id]/history", "GET", { token: s.custA, params: { id: "recIB" } });
    const none = await s.w.call("items/[id]/history", "GET", { token: s.custA, params: { id: "recNope" } });
    expect([other.status, none.status]).toEqual([404, 404]);
    expect(other.json).toEqual(none.json);
    expect(s.w.db.count("StatusHistory", "select")).toBe(0); // ownership is decided first
    expect((await s.w.call("items/[id]/history", "GET", { token: s.custA, params: { id: "recIA" } })).status).toBe(200);
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
  it(PRESERVE("A -> A order allowed; A -> B order denied"), async () => {
    const s = await seeded();
    expect((await s.w.call("orders/[id]", "GET", { token: s.custA, params: { id: "recOA" } })).status).toBe(200);
    expect((await s.w.call("orders/[id]", "GET", { token: s.custA, params: { id: "recOB" } })).status).toBe(404);
  });
  it(FIXED("someone else's order is indistinguishable from a non-existent one (identical 404 response)"), async () => {
    const s = await seeded();
    const other = await s.w.call("orders/[id]", "GET", { token: s.custA, params: { id: "recOB" } });
    const none = await s.w.call("orders/[id]", "GET", { token: s.custA, params: { id: "recNope" } });
    expect([other.status, none.status]).toEqual([404, 404]);
    expect(other.json).toEqual(none.json);
  });
  it(PRESERVE("a customer cannot create, edit, delete or invoice orders (403)"), async () => {
    const s = await seeded();
    expect((await s.w.call("orders", "POST", { token: s.custA, body: {} })).status).toBe(403);
    expect((await s.w.call("orders/[id]", "PATCH", { token: s.custA, params: { id: "recOA" }, body: { status: "Paid" } })).status).toBe(403);
    expect((await s.w.call("orders/[id]", "DELETE", { token: s.custA, params: { id: "recOA" } })).status).toBe(403);
  });
});

describe(FIXED("a customer user with NO valid customer profile is denied everywhere"), () => {
  // HIGH severity in Phase 4: such a login was served EVERY customer's items and orders.
  async function brokenLogins() {
    const s = await seeded();
    return {
      ...s,
      orphan: s.w.asUser("customer"), // Users row with Role=customer and no CustomerRecord
      dangling: s.w.asUser("customer", { customerId: "recDeletedCustomer" }), // link to a record that no longer exists
    };
  }
  it("GET /api/items and GET /api/orders return 403, never other customers' records", async () => {
    const s = await brokenLogins();
    for (const t of [s.orphan, s.dangling]) {
      for (const route of ["items", "orders"]) {
        const res = await s.w.call(route, "GET", { token: t });
        expect(res.status, route).toBe(403);
        expect(res.json?.code).toBe("CUSTOMER_NOT_LINKED");
        expect(JSON.stringify(res.json)).not.toContain("recIA");
        expect(JSON.stringify(res.json)).not.toContain("recIB");
      }
    }
  });
  it("every other customer-reachable route is denied as well", async () => {
    const s = await brokenLogins();
    const calls: [string, "GET" | "PATCH", Record<string, string>?, unknown?][] = [
      ["customers/[id]", "GET", { id: "recCustA" }], ["customers/[id]", "PATCH", { id: "recCustA" }, { notes: "x" }],
      ["customers/me/warehouse", "PATCH", undefined, { warehouseId: "w" }], ["dashboard/customer", "GET"],
      ["items/[id]", "GET", { id: "recIA" }], ["items/[id]/history", "GET", { id: "recIA" }], ["orders/[id]", "GET", { id: "recOA" }],
      ["warehouses", "GET"], ["package-rates", "GET"], ["special-rates", "GET"],
    ];
    for (const t of [s.orphan, s.dangling]) {
      for (const [route, method, params, body] of calls) {
        const res = await s.w.call(route, method, { token: t, params, body });
        expect(res.status, `${method} ${route}`).toBe(403);
      }
    }
  });
  it("the data layer is fail-closed too: a missing customer id returns nothing instead of everything", async () => {
    const s = await seeded();
    expect(await s.w.airtable.itemsApi.getByCustomer(undefined as unknown as string)).toEqual([]);
    expect(await s.w.airtable.ordersApi.getByCustomer("")).toEqual([]);
    expect((await s.w.airtable.dashboardApi.getCustomerStats(undefined as unknown as string)).totalItems).toBe(0);
  });
  it("a customer cannot reach the data by supplying a customerId query parameter either", async () => {
    const s = await brokenLogins();
    const res = await s.w.call("items", "GET", { token: s.orphan, query: { customerId: "recCustB" } });
    expect(res.status).toBe(403);
  });
  it("admin and staff are unaffected (no customer profile is required for them)", async () => {
    const s = await brokenLogins();
    expect((await s.w.call("items", "GET", { token: s.admin })).status).toBe(200);
    expect((await s.w.call("orders", "GET", { token: s.staff })).status).toBe(200);
  });
});

describe("staff and admin visibility (no tenant restriction by design)", () => {
  it(PRESERVE("admin and staff see every customer's items and orders"), async () => {
    const s = await seeded();
    expect(ids(await s.w.call("items", "GET", { token: s.staff })).sort()).toEqual(["recIA", "recIB"]);
    expect(ids(await s.w.call("orders", "GET", { token: s.admin })).sort()).toEqual(["recOA", "recOB"]);
  });
});
