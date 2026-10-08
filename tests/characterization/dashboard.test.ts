// Dashboard and report aggregates (dashboardApi, GET /api/dashboard/*, GET /api/reports).
// All aggregates load whole tables and compute in JavaScript. Amounts are the USD InvoiceAmount.
import { describe, it, expect } from "vitest";
import { standardWorld } from "../helpers/world";
import { computeCbm } from "@/lib/cbm";
import { KNOWN_BUG, PRESERVE, FIXED } from "../helpers/known";

async function populated() {
  const s = await standardWorld();
  const { w } = s;
  w.seed.customer("recCustC", { Name: "Esi Owusu", Status: "inactive" });
  // Orders (USD). CreatedAt is a created-time field in Airtable, so it is seeded explicitly.
  w.seed.order("recOP", "recCustA", { Status: "Pending", InvoiceAmount: 100, InvoiceDate: "2026-03-05", CreatedAt: "2026-03-05T08:00:00.000Z", Items: ["recI1"] });
  w.seed.order("recOQ", "recCustA", { Status: "Pending", InvoiceAmount: 50, Discount: 10, InvoiceDate: "2026-03-06", CreatedAt: "2026-03-06T08:00:00.000Z" });
  w.seed.order("recOR", "recCustB", { Status: "Partial", InvoiceAmount: 200, AmountPaid: 150, InvoiceDate: "2026-03-07", CreatedAt: "2026-03-07T08:00:00.000Z" });
  w.seed.order("recOS", "recCustB", { Status: "Paid", InvoiceAmount: 300, Discount: 50, InvoiceDate: "2026-03-08", CreatedAt: "2026-03-08T08:00:00.000Z" });
  w.seed.order("recOT", "recCustA", { Status: "Paid", InvoiceAmount: 100, InvoiceDate: "2026-02-10", CreatedAt: "2026-02-10T08:00:00.000Z" });
  // Items
  w.seed.item("recI1", "recCustA", { Status: "Arrived at Transit Warehouse", Length: 100, Width: 100, Height: 100, Quantity: 3, DateReceived: "2026-03-01" });
  w.seed.item("recI2", "recCustA", { Status: "Sorting", IsMissing: true, Length: 10, Width: 10, Height: 10, DimensionUnit: "inches", DateReceived: "2026-03-02" });
  w.seed.item("recI3", "recCustB", { Status: "Ready for Pickup", DateReceived: "2026-03-03" });
  w.seed.item("recI4", "recCustB", { Status: "Sorting", DateReceived: "2026-03-04" });
  w.seed.container("recC1", { Status: "Shipped to Ghana" });
  w.seed.container("recC2", { Status: "Loading" });
  return s;
}
const stats = async (s: Awaited<ReturnType<typeof populated>>) => (await s.w.call("dashboard/admin", "GET", { token: s.admin })).json?.data;

describe("admin dashboard (dashboardApi.getAdminStats)", () => {
  it(PRESERVE("counts customers, warehouse items, containers in transit, sorting, missing and ready-for-pickup items"), async () => {
    const d = await stats(await populated());
    expect(d).toMatchObject({ totalCustomers: 3, activeCustomers: 2, itemsInWarehouse: 1, containersInTransit: 1, itemsInSorting: 2, lostItems: 1, readyForPickup: 1 });
    expect(d.itemsByStatus).toEqual({ "Arrived at Transit Warehouse": 1, Sorting: 2, "Ready for Pickup": 1 });
  });

  it("revenue = sum of InvoiceAmount of PAID orders; pending revenue = sum of PENDING orders only", async () => {
    const d = await stats(await populated());
    expect(d.totalRevenue).toBe(400); // 300 + 100
    expect(d.pendingRevenue).toBe(150); // 100 + 50
  });

  it(KNOWN_BUG("revenue ignores discounts and excludes partial payments entirely"), async () => {
    // Future behavior (Phase 3 R-17/R-20): revenue from payments; discount reflected in the invoice total.
    // This test documents current behavior only. It must be replaced when reporting moves to payments.
    const d = await stats(await populated());
    expect(d.totalRevenue).toBe(400); // the 50 discount on the 300 order is not subtracted
    expect(d.pendingRevenue + d.totalRevenue).toBe(550); // 750 invoiced in total; the 200 Partial order (150 paid) appears in neither bucket
    expect(d.pendingOrders.map((o: { orderRef: string }) => o.orderRef)).toEqual(["ORD-recOQ", "ORD-recOP"]);
  });

  it(PRESERVE("ordersThisMonth uses InvoiceDate in the current calendar month"), async () => {
    expect((await stats(await populated())).ordersThisMonth).toBe(4); // clock is 2026-03-15; the Feb order is excluded
  });

  it(PRESERVE("recentOrders are the 5 newest by CreatedAt; recentShipments the 5 newest items by DateReceived"), async () => {
    const d = await stats(await populated());
    expect(d.recentOrders.map((o: { orderRef: string }) => o.orderRef)).toEqual(["ORD-recOS", "ORD-recOR", "ORD-recOQ", "ORD-recOP", "ORD-recOT"]);
    expect(d.recentShipments.map((s: { id: string }) => s.id)).toEqual(["recI4", "recI3", "recI2", "recI1"]);
  });

  it(KNOWN_BUG("dashboard total CBM ignores item quantity (and counts cartoned items by their own dimensions)"), async () => {
    // Future behavior (Phase 3 R-7): quantity-aware CBM from one shared definition. Documents current behavior only.
    const d = await stats(await populated());
    const qtyAware = computeCbm({ length: 100, width: 100, height: 100, quantity: 3 }); // what billing uses
    expect(qtyAware).toBe(3);
    // 1 (quantity ignored) + 10x10x10 inches (0.016387064)
    expect(d.totalCbm).toBeCloseTo(1 + 0.016387064, 9);
  });

  it(FIXED("is available to warehouse staff WITHOUT revenue/invoice figures (stripped server-side), full for super_admin, denied to customers"), async () => {
    const s = await populated();
    const staffRes = await s.w.call("dashboard/admin", "GET", { token: s.staff });
    expect(staffRes.status).toBe(200);
    expect(staffRes.json?.data).toMatchObject({ totalRevenue: 0, pendingRevenue: 0, pendingOrders: [], recentOrders: [] });
    expect(JSON.stringify(staffRes.json)).not.toMatch(/invoiceAmount/);
    const adminRes = await s.w.call("dashboard/admin", "GET", { token: s.admin });
    expect(adminRes.json?.data.totalRevenue).toBeGreaterThan(0);
    expect((await s.w.call("dashboard/admin", "GET", { token: s.custA })).status).toBe(403);
  });

  it(KNOWN_BUG("every dashboard load reads four whole tables"), async () => {
    const s = await populated();
    s.w.db.clearCalls();
    await stats(s);
    expect(["Customers", "Items", "Containers", "Orders"].map((t) => s.w.db.count(t, "select"))).toEqual([1, 1, 1, 1]);
  });
});

describe("customer dashboard (dashboardApi.getCustomerStats)", () => {
  it(PRESERVE("is scoped to the logged-in customer: counts, status breakdown and pending payment"), async () => {
    const s = await populated();
    const res = await s.w.call("dashboard/customer", "GET", { token: s.custA });
    expect(res.status).toBe(200);
    expect(res.json?.data).toMatchObject({ totalItems: 2, totalOrders: 3, pendingPayment: 150 });
    expect(res.json?.data.itemsByStatus).toEqual({ "Arrived at Transit Warehouse": 1, Sorting: 1 });
  });
  it(KNOWN_BUG("pendingPayment counts Pending orders only: partial balances and discounts are ignored"), async () => {
    const s = await populated();
    const b = await s.w.call("dashboard/customer", "GET", { token: s.custB });
    expect(b.json?.data.pendingPayment).toBe(0); // customer B owes 50 on a Partial order, shown as 0
  });
  it(KNOWN_BUG("customer total CBM ignores quantity"), async () => {
    const s = await populated();
    const a = await s.w.call("dashboard/customer", "GET", { token: s.custA });
    expect(a.json?.data.totalCbm).toBeCloseTo(1 + 0.016387064, 9); // item recI1 has quantity 3 but counts once
  });
  it(PRESERVE("an admin may query any customer; a customer cannot override the customer id"), async () => {
    const s = await populated();
    const asAdmin = await s.w.call("dashboard/customer", "GET", { token: s.admin, query: { customerId: "recCustB" } });
    expect(asAdmin.json?.data.totalItems).toBe(2);
    const sneaky = await s.w.call("dashboard/customer", "GET", { token: s.custA, query: { customerId: "recCustB" } });
    expect(sneaky.json?.data.totalOrders).toBe(3); // customer A's 3 orders, not customer B's 2: the query parameter is ignored
  });
  it(PRESERVE("an admin without a customer id gets 400"), async () => {
    const s = await populated();
    expect((await s.w.call("dashboard/customer", "GET", { token: s.admin })).status).toBe(400);
  });
});

describe("GET /api/reports", () => {
  const report = async (s: Awaited<ReturnType<typeof populated>>, query?: Record<string, string>) => (await s.w.call("reports", "GET", { token: s.admin, query })).json?.data;

  it(PRESERVE("totals: paid revenue, order counts, average paid order value, shipments"), async () => {
    const d = await report(await populated());
    expect(d).toMatchObject({ totalRevenue: 400, totalOrders: 5, paidOrders: 2, avgOrderValue: 200, totalShipments: 4 });
    expect(d.revenueThisMonth).toBe(300); // March paid orders only
    expect(d.revenueThisYear).toBe(400);
  });
  it(PRESERVE("monthly series covers the last 12 months ending this month"), async () => {
    const d = await report(await populated());
    expect(d.monthlyRevenue).toHaveLength(12);
    expect(d.monthlyRevenue.at(-1)).toEqual({ month: "2026-03", revenue: 300 });
    expect(d.monthlyRevenue.at(-2)).toEqual({ month: "2026-02", revenue: 100 });
  });
  it(PRESERVE("from/to filter the order-based totals by InvoiceDate (inclusive of the 'to' day)"), async () => {
    const d = await report(await populated(), { from: "2026-03-07", to: "2026-03-08" });
    expect(d.totalOrders).toBe(2);
    expect(d.totalRevenue).toBe(300);
  });
  it(KNOWN_BUG("'pending revenue' excludes Partial orders but 'outstanding' lists and customer balances include them at full value"), async () => {
    const d = await report(await populated());
    expect(d.pendingRevenue).toBe(150);
    expect(d.outstandingPayments.map((o: { orderRef: string }) => o.orderRef)).toEqual(["ORD-recOP", "ORD-recOQ", "ORD-recOR"]);
    const b = d.customerAnalytics.find((c: { id: string }) => c.id === "recCustB");
    expect(b.outstandingBalance).toBe(200); // the 150 already paid is not subtracted
    expect(b.totalRevenue).toBe(300); // discount not subtracted
  });
  it(PRESERVE("top customers rank by paid revenue"), async () => {
    const d = await report(await populated());
    expect(d.topCustomers.map((c: { id: string; revenue: number }) => [c.id, c.revenue])).toEqual([["recCustB", 300], ["recCustA", 100]]);
  });
  it(FIXED("is super_admin only: denied to warehouse staff and customers (D6: no revenue reports for staff)"), async () => {
    const s = await populated();
    expect((await s.w.call("reports", "GET", { token: s.admin })).status).toBe(200);
    expect((await s.w.call("reports", "GET", { token: s.staff })).status).toBe(403);
    expect((await s.w.call("reports", "GET", { token: s.custA })).status).toBe(403);
  });
});
