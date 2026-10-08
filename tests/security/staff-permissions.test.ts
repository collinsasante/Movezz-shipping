// Staff (warehouse_staff) permissions checked against the approved role model, not against route comments.
// Q9 (exact staff powers) is still open; items marked PENDING-Q9 record today's behavior for the owner to decide.
import { describe, it, expect } from "vitest";
import { standardWorld } from "../helpers/world";
import { PRESERVE, FIXED, KNOWN_BUG } from "../helpers/known";

describe(FIXED("staff cannot change anything that sets a price or an amount owed"), () => {
  it("package rates, special rates and the exchange rate: 403", async () => {
    const { w, staff } = await standardWorld();
    expect((await w.call("package-rates", "PUT", { token: staff, body: {} })).status).toBe(403);
    expect((await w.call("special-rates", "POST", { token: staff, body: { name: "x" } })).status).toBe(403);
    expect((await w.call("settings", "PUT", { token: staff, body: { usdToGhs: 12, shippingRatePerCbm: 1 } })).status).toBe(403);
  });
  it("users: staff cannot list, create or delete accounts (including themselves)", async () => {
    const { w, staff } = await standardWorld();
    expect((await w.call("users", "GET", { token: staff })).status).toBe(403);
    expect((await w.call("users", "POST", { token: staff, body: { email: "x@example.invalid", role: "warehouse_staff" } })).status).toBe(403);
    expect((await w.call("users/[id]", "DELETE", { token: staff, params: { id: "recAny" }, body: {} })).status).toBe(403);
  });
  it("payments and invoices: staff cannot record, alter or void a payment, change an invoice or create/cancel a Keepup sale", async () => {
    const { w, staff } = await standardWorld();
    w.seed.order("recO1", "recCustA", { Status: "Partial", AmountPaid: 40, KeepupSaleId: "KU-1" });
    expect((await w.call("orders/[id]", "PATCH", { token: staff, params: { id: "recO1" }, body: { paymentAmount: 10 } })).status).toBe(403);
    expect((await w.call("orders/[id]", "PATCH", { token: staff, params: { id: "recO1" }, body: { status: "Paid" } })).status).toBe(403);
    expect((await w.call("orders/[id]", "DELETE", { token: staff, params: { id: "recO1" } })).status).toBe(403);
    expect((await w.call("orders/[id]/create-invoice", "POST", { token: staff, params: { id: "recO1" }, body: {} })).status).toBe(403);
    expect((await w.call("orders", "POST", { token: staff, body: {} })).status).toBe(403);
    expect(w.db.get("Orders", "recO1")?.fields).toMatchObject({ Status: "Partial", AmountPaid: 40 });
    expect(w.keepup.recordKeepupPayment).not.toHaveBeenCalled();
  });
  it("customers: staff cannot edit or delete customer profiles (shipping mark, tier, status)", async () => {
    const { w, staff } = await standardWorld();
    expect((await w.call("customers/[id]", "PATCH", { token: staff, params: { id: "recCustA" }, body: { package: "special" } })).status).toBe(403);
    expect((await w.call("customers/[id]", "DELETE", { token: staff, params: { id: "recCustA" } })).status).toBe(403);
    expect(w.db.get("Customers", "recCustA")?.fields["CustomerPackage"]).toBe("basic");
  });
  it("containers: staff cannot change status/details or delete (only add/remove items)", async () => {
    const { w, staff } = await standardWorld();
    w.seed.container("recC1");
    expect((await w.call("containers/[id]/status", "PATCH", { token: staff, params: { id: "recC1" }, body: { status: "Shipped to Ghana" } })).status).toBe(403);
    expect((await w.call("containers/[id]", "PATCH", { token: staff, params: { id: "recC1" }, body: {} })).status).toBe(403);
    expect((await w.call("containers/[id]", "DELETE", { token: staff, params: { id: "recC1" } })).status).toBe(403);
  });
  it("audit log and legacy admin surfaces: staff cannot read them", async () => {
    const { w, staff } = await standardWorld();
    expect((await w.call("activity-logs", "GET", { token: staff })).status).toBe(403);
  });
});

describe(PRESERVE("staff can do the approved operational work"), () => {
  it("receive and edit items, move items forward, repack cartons, run sorting, manage suppliers", async () => {
    const { w, staff } = await standardWorld();
    const item = await w.call("items", "POST", { token: staff, body: { customerId: "recCustA", description: "Box", dateReceived: "2026-03-01" } });
    expect(item.status).toBe(201);
    const id = item.json?.data.id as string;
    expect((await w.call("items/[id]", "PATCH", { token: staff, params: { id }, body: { description: "Box 2" } })).status).toBe(200);
    expect((await w.call("items/[id]/status", "PATCH", { token: staff, params: { id }, body: { status: "Sorting" } })).status).toBe(200);
    expect((await w.call("sorting", "GET", { token: staff })).status).toBe(200);
    expect((await w.call("suppliers", "POST", { token: staff, body: { name: "Acme" } })).status).toBe(201);
    expect((await w.call("cartons", "GET", { token: staff })).status).toBe(200);
  });
});

describe(PRESERVE("staff do not bypass customer ownership rules (they act on records, not as a customer)"), () => {
  it("a staff login is not a customer: customer-only routes reject it", async () => {
    const { w, staff } = await standardWorld();
    expect((await w.call("customers/me/warehouse", "PATCH", { token: staff, body: { warehouseId: "x" } })).status).toBe(403);
    expect((await w.call("dashboard/customer", "GET", { token: staff })).status).toBe(403);
  });
});

describe(KNOWN_BUG("PENDING-Q9: staff powers the owner has not decided yet"), () => {
  // These are NOT asserted as correct. They record today's behavior so the decision is visible.
  it("documents that staff can still create and edit warehouses", async () => {
    const { w, staff } = await standardWorld();
    const created = await w.call("warehouses", "POST", { token: staff, body: { name: "Depot", address: "1 Main St" } });
    expect(created.status).toBe(201);
    expect((await w.call("warehouses/[id]", "PATCH", { token: staff, params: { id: created.json?.data.id }, body: { address: "2 Main St" } })).status).toBe(200);
  });
  it("documents that staff can read revenue reports, the dashboard totals and the exchange rate", async () => {
    const { w, staff } = await standardWorld();
    expect((await w.call("reports", "GET", { token: staff })).status).toBe(200);
    expect((await w.call("dashboard/admin", "GET", { token: staff })).status).toBe(200);
    expect((await w.call("settings", "GET", { token: staff })).status).toBe(200);
  });
  it("documents that staff can trigger the Keepup payment-status sync (it only reads Keepup and sets order status)", async () => {
    const { w, staff } = await standardWorld();
    expect((await w.call("orders/keepup-sync", "POST", { token: staff })).status).toBe(200);
  });
});
