// Phase 7L Group F through the REAL route handlers: dashboards, reports, activity log, under the locked financial model.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, packageRates, fxRate, item, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));
vi.mock("@/lib/email", () => ({ sendPaymentConfirmedEmail: vi.fn(async () => {}), sendPartialPaymentEmail: vi.fn(async () => {}) }));

import { GET as adminDash } from "../../src/app/api/dashboard/admin/route";
import { GET as custDash } from "../../src/app/api/dashboard/customer/route";
import { GET as reportsGet } from "../../src/app/api/reports/route";
import { GET as logsGet } from "../../src/app/api/activity-logs/route";
import { POST as ordersPost } from "../../src/app/api/orders/route";
import { PATCH as orderPatch } from "../../src/app/api/orders/[id]/route";
import { DELETE as orderDelete } from "../../src/app/api/orders/[id]/route";

function req(url: string, method: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": "198.51.100.3" };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = <T extends Record<string, string>>(o: T) => ({ params: Promise.resolve(o) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("Group F on PostgreSQL: dashboards, reports, activity log (real routes)", () => {
  let db: TestDb; let n = 0; let custA: string, custB: string;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const tok = (uid: string) => { const t = `t-${uid}-${++n}`; tokens.set(t, { uid, emailVerified: true }); return t; };
  let admin: string, staff: string, ca: string, cb: string;
  const order = async (cust: string, extra: Record<string, unknown> = {}) => json(await ordersPost(req("/api/orders", "POST", { token: admin, body: { customerId: cust, itemIds: [await item(db.admin, cust)], ...extra } })));
  const pay = (id: string, amount?: number) => orderPatch(req("", "PATCH", { token: admin, body: amount ? { paymentAmount: amount } : { status: "Paid" } }), ctx({ id }));

  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app);
    await packageRates(db.admin, "basic", "350", "8"); await fxRate(db.admin, "10.00000000");
    await q(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin'),('fb-staff','staff@example.invalid','warehouse_staff')`);
    custA = await customer(db.admin); custB = await customer(db.admin);
    await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-ca','ca@example.invalid','customer',$1),('fb-cb','cb@example.invalid','customer',$2)`, [custA, custB]);
    admin = tok("fb-admin"); staff = tok("fb-staff"); ca = tok("fb-ca"); cb = tok("fb-cb");
    const o1 = await order(custA);                                        // 350 USD / 3500 GHS, paid in full
    await pay(o1.body.data.id);
    const o2 = await order(custA, { discount: 50, discountReason: "loyalty" });   // 300 USD / 3000 GHS, 1000 GHS paid -> Partial
    await pay(o2.body.data.id, 1000);
    await order(custB);                                                   // 350 USD pending
    const o4 = await order(custB);                                        // cancelled: must not count anywhere
    await orderDelete(req("", "DELETE", { token: admin }), ctx({ id: o4.body.data.id }));
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("admin dashboard: counts and money follow the invoices' own USD totals and the GHS actually received; USD and GHS are never mixed; cancelled invoices are excluded", async () => {
    const r = await json(await adminDash(req("/api/dashboard/admin", "GET", { token: admin })));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ totalCustomers: 2, activeCustomers: 2, totalRevenue: 350, pendingRevenue: 350, totalRevenueGhs: 4500, outstandingBalanceGhs: 5500, ordersThisMonth: 3 });
    expect(r.body.data.pendingOrders.length).toBe(1); expect(r.body.data.recentOrders.length).toBe(3);
    expect(r.body.data.itemsByStatus["Arrived at Transit Warehouse"]).toBeGreaterThan(0);
  });
  it("staff see operational counts but no money at all; customers and anonymous users are refused", async () => {
    const r = await json(await adminDash(req("/api/dashboard/admin", "GET", { token: staff })));
    expect(r.status).toBe(200); expect(r.body.data).toMatchObject({ totalRevenue: 0, pendingRevenue: 0, pendingOrders: [], recentOrders: [], ordersThisMonth: 0 });
    expect(JSON.stringify(r.body)).not.toMatch(/Ghs/);
    expect((await adminDash(req("/api/dashboard/admin", "GET", { token: ca }))).status).toBe(403);
    expect((await adminDash(req("/api/dashboard/admin", "GET"))).status).toBe(401);
  });
  it("customer dashboard: own data only; a customer cannot pick another id; admin can; staff cannot", async () => {
    const own = await json(await custDash(req(`/api/dashboard/customer?customerId=${custB}`, "GET", { token: ca })));
    expect(own.status).toBe(200); expect(own.body.data.totalItems).toBe(2); expect(own.body.data.totalOrders).toBe(2);
    expect(own.body.data.recentOrders.every((o: { customerId: string }) => o.customerId === custA)).toBe(true);
    expect(own.body.data).toMatchObject({ pendingPayment: 0, pendingPaymentGhs: 2000 });
    const theirs = await json(await custDash(req("/api/dashboard/customer", "GET", { token: cb })));
    expect(theirs.body.data).toMatchObject({ totalOrders: 1, pendingPayment: 350, pendingPaymentGhs: 3500 });
    expect((await json(await custDash(req(`/api/dashboard/customer?customerId=${custB}`, "GET", { token: admin })))).body.data.totalOrders).toBe(1);
    expect((await custDash(req("/api/dashboard/customer", "GET", { token: admin }))).status).toBe(400);
    expect((await custDash(req("/api/dashboard/customer", "GET", { token: staff }))).status).toBe(403);
  });
  it("reports: super_admin only; revenue per customer and month, outstanding list with GHS balances, period filter", async () => {
    expect((await reportsGet(req("/api/reports", "GET", { token: staff }))).status).toBe(403);
    expect((await reportsGet(req("/api/reports", "GET", { token: ca }))).status).toBe(403);
    const r = await json(await reportsGet(req("/api/reports", "GET", { token: admin })));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ totalRevenue: 350, pendingRevenue: 350, totalOrders: 3, paidOrders: 1, avgOrderValue: 350, totalRevenueGhs: 4500, outstandingBalanceGhs: 5500, totalShipments: 4 });
    expect(r.body.data.monthlyRevenue.length).toBe(12); expect(r.body.data.monthlyRevenue[11].revenue).toBe(350);
    expect(r.body.data.topCustomers[0]).toMatchObject({ name: expect.any(String), revenue: 350, orders: 1 });
    expect(r.body.data.outstandingPayments.map((o: { balanceDueGhs: number }) => o.balanceDueGhs).sort()).toEqual([2000, 3500]);
    const a = r.body.data.customerAnalytics.find((x: { id: string }) => x.id === custA);
    expect(a).toMatchObject({ totalOrders: 2, totalRevenue: 350, outstandingBalance: 300, outstandingBalanceGhs: 2000 });
    const none = await json(await reportsGet(req("/api/reports?from=2000-01-01&to=2000-12-31", "GET", { token: admin })));
    expect(none.body.data).toMatchObject({ totalOrders: 0, totalRevenue: 0 });
  });
  it("activity log: super_admin only, shows who did what from the audit trail, with no secrets", async () => {
    expect((await logsGet(req("/api/activity-logs", "GET", { token: staff }))).status).toBe(403);
    const r = await json(await logsGet(req("/api/activity-logs?limit=500", "GET", { token: admin })));
    expect(r.status).toBe(200); expect(r.body.data.length).toBeGreaterThan(5);
    expect(r.body.data.some((l: { action: string; userEmail: string }) => l.action === "payment.create" && l.userEmail === "admin@example.invalid")).toBe(true);
    expect((await json(await logsGet(req("/api/activity-logs?limit=2", "GET", { token: admin })))).body.data.length).toBe(2);
  });
});
