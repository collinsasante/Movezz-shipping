// Phase 7L staging verification of the CORE WORKFLOW on the PostgreSQL backend (mocked Firebase / e-mail; no Keepup, no Airtable):
// login -> customer -> item -> carton -> container -> pricing -> invoice -> payment -> status -> dashboard, then the denied paths.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, packageRates, fxRate, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
const fb = vi.hoisted(() => ({ createFirebaseUser: vi.fn(), deleteFirebaseUser: vi.fn(async () => {}), setCustomClaims: vi.fn(async () => {}), generatePasswordResetLink: vi.fn(async () => "https://example.invalid/r") }));
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; }, ...fb }));
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: vi.fn(async () => {}), sendPasswordResetEmail: vi.fn(async () => {}), sendItemStatusEmail: vi.fn(async () => {}), sendPaymentConfirmedEmail: vi.fn(async () => {}), sendPartialPaymentEmail: vi.fn(async () => {}) }));

import { POST as verify } from "../../src/app/api/auth/verify/route";
import { POST as customersPost } from "../../src/app/api/customers/route";
import { POST as itemsPost, GET as itemsGet } from "../../src/app/api/items/route";
import { PATCH as itemStatus } from "../../src/app/api/items/[id]/status/route";
import { POST as cartonsPost } from "../../src/app/api/cartons/route";
import { POST as containersPost } from "../../src/app/api/containers/route";
import { POST as containerItems } from "../../src/app/api/containers/[id]/items/route";
import { PATCH as containerStatus } from "../../src/app/api/containers/[id]/status/route";
import { POST as ordersPost, GET as ordersGet } from "../../src/app/api/orders/route";
import { PATCH as orderPatch } from "../../src/app/api/orders/[id]/route";
import { GET as adminDash } from "../../src/app/api/dashboard/admin/route";
import { GET as custDash } from "../../src/app/api/dashboard/customer/route";
import { PUT as settingsPut } from "../../src/app/api/settings/route";

function req(url: string, method: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = <T extends Record<string, string>>(o: T) => ({ params: Promise.resolve(o) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("core workflow on the PostgreSQL backend", () => {
  let db: TestDb;
  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app);
    await packageRates(db.admin, "basic", "350", "8");
    await db.admin.query(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin'),('fb-staff','staff@example.invalid','warehouse_staff')`);
    for (const [t, uid] of [["t-admin", "fb-admin"], ["t-staff", "fb-staff"], ["t-cust", "fb-new-customer"], ["t-other", "fb-other"]]) tokens.set(t, { uid, emailVerified: true });
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("runs end to end and denies what must be denied", async () => {
    // pricing configuration: FX is set by the administrator through the API
    expect((await settingsPut(req("/api/settings", "PUT", { token: "t-admin", body: { usdToGhs: 12, shippingRatePerCbm: 200 } }))).status).toBe(200);
    // customer + login
    fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-new-customer" });
    const created = await json(await customersPost(req("/api/customers", "POST", { token: "t-admin", body: { name: "Esi Boateng", phone: "+233201112223", email: "esi@example.invalid" } })));
    expect(created.status).toBe(201); const custId = created.body.data.customer.id;
    const login = await json(await verify(req("/api/auth/verify", "POST", { body: { idToken: "t-cust" } })));
    expect(login.body.data.user).toMatchObject({ role: "customer", customerId: custId, shippingMark: created.body.data.customer.shippingMark });
    // item -> carton
    const mk = async () => (await json(await itemsPost(req("/api/items", "POST", { token: "t-staff", body: { customerId: custId, dateReceived: "2026-05-01", shippingType: "sea", length: 100, width: 100, height: 100, description: "box" } })))).body.data;
    const [i1, i2, i3] = [await mk(), await mk(), await mk()];
    expect(i1.pkgEstShipping).toBe(350);
    const carton = await json(await cartonsPost(req("/api/cartons", "POST", { token: "t-staff", body: { customerId: custId, itemIds: [i1.id, i2.id], length: 100, width: 100, height: 100 } })));
    expect(carton.body.data.totalPrice).toBe(350);
    // container + shipping
    const con = (await json(await containersPost(req("/api/containers", "POST", { token: "t-admin", body: { trackingNumber: "MSKU1234567" } })))).body.data;
    for (const i of [i1, i2, i3]) expect((await containerItems(req("", "POST", { token: "t-staff", body: { itemId: i.id } }), ctx({ id: con.id }))).status).toBe(200);
    expect((await containerStatus(req("", "PATCH", { token: "t-admin", body: { status: "Arrived in Ghana" } }), ctx({ id: con.id }))).status).toBe(200);
    // invoice (carton + loose item) and payments
    const order = await json(await ordersPost(req("/api/orders", "POST", { token: "t-admin", body: { customerId: custId, itemIds: [i1.id, i2.id, i3.id] } })));
    expect(order.status).toBe(201); expect(order.body.data).toMatchObject({ invoiceAmount: 700, totalGhs: 8400, status: "Pending" });
    const id = order.body.data.id;
    expect((await json(await orderPatch(req("", "PATCH", { token: "t-admin", body: { paymentAmount: 3000 } }), ctx({ id })))).body.data).toMatchObject({ status: "Partial", balanceDue: 5400 });
    expect((await json(await orderPatch(req("", "PATCH", { token: "t-admin", body: { status: "Paid" } }), ctx({ id })))).body.data).toMatchObject({ status: "Paid", balanceDue: 0 });
    // status progression
    for (const s of ["Sorting", "Ready for Pickup", "Completed"]) expect((await itemStatus(req("", "PATCH", { token: "t-staff", body: { status: s } }), ctx({ id: i3.id }))).status).toBe(200);
    // customer sees only own data; dashboards add up
    const mine = await json(await itemsGet(req("/api/items", "GET", { token: "t-cust" })));
    expect(mine.body.total).toBe(3);
    expect((await json(await ordersGet(req("/api/orders", "GET", { token: "t-cust" })))).body.total).toBe(1);
    expect((await json(await custDash(req("/api/dashboard/customer", "GET", { token: "t-cust" })))).body.data).toMatchObject({ totalItems: 3, totalOrders: 1, pendingPayment: 0 });
    expect((await json(await adminDash(req("/api/dashboard/admin", "GET", { token: "t-admin" })))).body.data).toMatchObject({ totalRevenue: 700, totalRevenueGhs: 8400, outstandingBalanceGhs: 0 });

    // denied paths
    await db.admin.query(`INSERT INTO customers (name, phone, email, shipping_mark, package_tier) VALUES ('Other','0244999111','o@example.invalid','MOVEZZ-OT9111','basic')`);
    const other = (await db.admin.query(`SELECT id FROM customers WHERE shipping_mark = 'MOVEZZ-OT9111'`)).rows[0].id;
    await db.admin.query(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-other','other@example.invalid','customer',$1)`, [other]);
    expect((await itemsGet(req("/api/items", "GET", { token: "t-other" }))).status).toBe(200);
    expect((await json(await itemsGet(req("/api/items", "GET", { token: "t-other" })))).body.total).toBe(0);
    expect((await orderPatch(req("", "PATCH", { token: "t-other", body: { status: "Paid" } }), ctx({ id }))).status).toBe(403);
    expect((await json(await ordersGet(req("/api/orders", "GET", { token: "t-staff" })))).status).toBe(403);
    expect((await itemsPost(req("/api/items", "POST", { token: "t-cust", body: { customerId: custId, dateReceived: "2026-05-01" } }))).status).toBe(403);
    expect((await ordersPost(req("/api/orders", "POST", { token: "t-staff", body: { customerId: custId, itemIds: [i3.id] } }))).status).toBe(403);
    await db.admin.query("UPDATE customers SET status = 'inactive' WHERE id = $1", [custId]);
    expect((await itemsGet(req("/api/items", "GET", { token: "t-cust" }))).status).toBe(401);                   // an inactive customer is locked out at once
  });
});
