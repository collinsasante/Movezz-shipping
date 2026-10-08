// Phase 7L Groups D/E through the REAL route handlers: orders (= invoices), payments, cancellation, Keepup state.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, packageRates, fxRate, item, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));
const mail = vi.hoisted(() => ({ sendPaymentConfirmedEmail: vi.fn(async () => {}), sendPartialPaymentEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => mail);

import { GET as ordersGet, POST as ordersPost } from "../../src/app/api/orders/route";
import { GET as orderGet, PATCH as orderPatch, DELETE as orderDelete } from "../../src/app/api/orders/[id]/route";
import { POST as createInvoice, DELETE as clearInvoice } from "../../src/app/api/orders/[id]/create-invoice/route";
import { POST as keepupSync } from "../../src/app/api/orders/keepup-sync/route";
import { POST as cartonsPost } from "../../src/app/api/cartons/route";

function req(url: string, method: string, o: { token?: string; body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": "198.51.100.5" };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.key) headers["idempotency-key"] = o.key;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = <T extends Record<string, string>>(o: T) => ({ params: Promise.resolve(o) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("Groups D/E on PostgreSQL: orders, payments, cancellation (real routes)", () => {
  let db: TestDb; let n = 0; let custA: string, custB: string;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const tok = (uid: string) => { const t = `t-${uid}-${++n}`; tokens.set(t, { uid, emailVerified: true }); return t; };
  let admin: string, staff: string, ca: string, cb: string;
  const mkOrder = async (cust = custA, count = 1, token = admin) => {
    const ids: string[] = []; for (let i = 0; i < count; i++) ids.push(await item(db.admin, cust));
    return { ids, res: await json(await ordersPost(req("/api/orders", "POST", { token, body: { customerId: cust, itemIds: ids, invoiceDate: "2026-04-01", notes: "n" } }))) };
  };

  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app);
    await packageRates(db.admin, "basic", "350", "8"); await fxRate(db.admin, "12.50000000");
    await q(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin'),('fb-staff','staff@example.invalid','warehouse_staff')`);
    custA = await customer(db.admin); custB = await customer(db.admin);
    await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-ca','ca@example.invalid','customer',$1),('fb-cb','cb@example.invalid','customer',$2)`, [custA, custB]);
    admin = tok("fb-admin"); staff = tok("fb-staff"); ca = tok("fb-ca"); cb = tok("fb-cb");
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("only a super_admin creates orders; the server prices them with the frozen FX; client totals are ignored; other customers' items are refused", async () => {
    const ids = [await item(db.admin, custA)];
    const body = { customerId: custA, itemIds: ids, invoiceAmount: 1, invoiceDate: "2026-04-01" };
    expect((await ordersPost(req("/api/orders", "POST", { token: staff, body }))).status).toBe(403);
    expect((await ordersPost(req("/api/orders", "POST", { token: ca, body }))).status).toBe(403);
    expect((await ordersPost(req("/api/orders", "POST", { body }))).status).toBe(401);
    expect((await ordersPost(req("/api/orders", "POST", { token: admin, body: { ...body, itemIds: [] } }))).status).toBe(400);
    const foreign = await item(db.admin, custB);
    expect((await ordersPost(req("/api/orders", "POST", { token: admin, body: { ...body, itemIds: [foreign] } }))).status).toBe(400);
    const r = await json(await ordersPost(req("/api/orders", "POST", { token: admin, body })));
    expect(r.status).toBe(201); expect(r.body.data).toMatchObject({ orderRef: expect.stringMatching(/^ORD-/), invoiceAmount: 350, totalUsd: 350, totalGhs: 4375, fxRate: 12.5, status: "Pending", amountPaid: 0, balanceDue: 4375, currency: "GHS" });
    expect((await ordersPost(req("/api/orders", "POST", { token: admin, body }))).status).toBe(409);                  // items already invoiced
  });

  it("discounts: only a super_admin, with a reason, never above the subtotal", async () => {
    const ids = [await item(db.admin, custA)];
    const mk = (extra: Record<string, unknown>) => json(ordersPost(req("/api/orders", "POST", { token: admin, body: { customerId: custA, itemIds: ids, ...extra } })) as unknown as Response);
    void mk;
    const r = await json(await ordersPost(req("/api/orders", "POST", { token: admin, body: { customerId: custA, itemIds: ids, discount: 50, discountReason: "loyalty" } })));
    expect(r.status).toBe(201); expect(r.body.data).toMatchObject({ discount: 50, totalUsd: 300, totalGhs: 3750 });
    const ids2 = [await item(db.admin, custA)];
    expect((await ordersPost(req("/api/orders", "POST", { token: admin, body: { customerId: custA, itemIds: ids2, discount: 50 } }))).status).toBeGreaterThanOrEqual(400);   // no reason
    expect((await ordersPost(req("/api/orders", "POST", { token: admin, body: { customerId: custA, itemIds: ids2, discount: 500, discountReason: "x" } }))).status).toBeGreaterThanOrEqual(400);
  });

  it("reads: admin and the owning customer only; staff have no financial access; other customers get 404", async () => {
    const { res } = await mkOrder(); const id = res.body.data.id;
    expect((await ordersGet(req("/api/orders", "GET", { token: staff }))).status).toBe(403);
    expect((await orderGet(req("", "GET", { token: staff }), ctx({ id }))).status).toBe(403);
    expect((await json(await orderGet(req("", "GET", { token: ca }), ctx({ id })))).body.data).toMatchObject({ id, invoiceTotalGhs: 4375, items: expect.any(Array) });
    expect((await orderGet(req("", "GET", { token: cb }), ctx({ id }))).status).toBe(404);
    expect((await orderGet(req("", "GET", { token: admin }), ctx({ id: "zz" }))).status).toBe(404);
    const mine = await json(await ordersGet(req(`/api/orders?customerId=${custB}`, "GET", { token: ca })));
    expect(mine.body.data.every((o: { customerId: string }) => o.customerId === custA)).toBe(true);
    expect((await json(await ordersGet(req("/api/orders?status=Pending&search=ORD", "GET", { token: admin })))).body.total).toBeGreaterThan(0);
  });

  it("payments: partial then full, GHS, balance server-side; overpayment refused; idempotent repeat records once; only a super_admin", async () => {
    const { res } = await mkOrder(); const id = res.body.data.id; const pay = (token: string, amount: number, key?: string) => orderPatch(req("", "PATCH", { token, body: { paymentAmount: amount }, key }), ctx({ id }));
    expect((await pay(staff, 10)).status).toBe(403); expect((await pay(ca, 10)).status).toBe(403);
    const p1 = await json(await pay(admin, 1000, "pay-key-0001"));
    expect(p1.body.data).toMatchObject({ status: "Partial", amountPaid: 1000, balanceDue: 3375 });
    const again = await json(await pay(admin, 1000, "pay-key-0001"));                                                    // duplicate request
    expect(again.body.data.amountPaid).toBe(1000);
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1", [id]))[0].n).toBe(1);
    expect((await pay(admin, 1000, "pay-key-0001").then((r) => r.status))).toBe(200);
    expect((await orderPatch(req("", "PATCH", { token: admin, body: { paymentAmount: 2000 }, key: "pay-key-0001" }), ctx({ id }))).status).toBe(409);   // same key, different request
    expect((await pay(admin, 99999)).status).toBe(422);                                                                  // overpayment
    const full = await json(await orderPatch(req("", "PATCH", { token: admin, body: { status: "Paid" } }), ctx({ id })));
    expect(full.body.data).toMatchObject({ status: "Paid", amountPaid: 4375, balanceDue: 0 });
    expect(mail.sendPaymentConfirmedEmail).toHaveBeenCalled(); expect(mail.sendPartialPaymentEmail).toHaveBeenCalled();
    expect((await pay(admin, 1)).status).toBeGreaterThanOrEqual(400);
    expect((await createInvoice(req("", "POST", { token: admin }), ctx({ id }))).status).toBe(400);                      // paid order
  });

  it("concurrent payments never overpay: of two payments that cannot both fit, exactly one is recorded", async () => {
    const { res } = await mkOrder(); const id = res.body.data.id;
    const rs = await Promise.all([3000, 3000].map((a) => orderPatch(req("", "PATCH", { token: admin, body: { paymentAmount: a } }), ctx({ id }))));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 422]);
    expect((await q("SELECT amount_paid_ghs FROM invoices WHERE id = $1", [id]))[0].amount_paid_ghs).toBe("3000.00");
  });

  it("issued invoices are immutable: money, items and date cannot be edited, an unchanged echo and notes can", async () => {
    const { res, ids } = await mkOrder(); const id = res.body.data.id;
    const patch = (body: unknown) => orderPatch(req("", "PATCH", { token: admin, body }), ctx({ id }));
    expect((await patch({ invoiceAmount: 100 })).status).toBe(409); expect((await patch({ discount: 10 })).status).toBe(409);
    expect((await patch({ itemIds: [] })).status).toBe(409); expect((await patch({ invoiceDate: "2020-01-01" })).status).toBe(409);
    expect((await patch({ status: "Partial" })).status).toBe(409);
    expect((await patch({ invoiceAmount: 350, discount: 0, invoiceDate: "2026-04-01", itemIds: ids, status: "Pending" })).status).toBe(200);
    const noted = await json(await patch({ notes: "call customer" }));
    expect(noted.body.data.notes).toBe("call customer");
  });

  it("cancellation is admin-only, releases the items, keeps the invoice, and blocks while payments exist", async () => {
    const { res, ids } = await mkOrder(); const id = res.body.data.id;
    expect((await orderDelete(req("", "DELETE", { token: staff }), ctx({ id }))).status).toBe(403);
    await orderPatch(req("", "PATCH", { token: admin, body: { paymentAmount: 100 } }), ctx({ id }));
    expect((await orderDelete(req("", "DELETE", { token: admin }), ctx({ id }))).status).toBe(409);                     // a payment exists
    const { res: r2, ids: ids2 } = await mkOrder(); const id2 = r2.body.data.id;
    expect((await orderDelete(req("", "DELETE", { token: admin }), ctx({ id: id2 }))).status).toBe(200);
    expect((await q("SELECT invoice_id FROM items WHERE id = $1", [ids2[0]]))[0].invoice_id).toBeNull();
    expect((await q("SELECT status, cancel_reason FROM invoices WHERE id = $1", [id2]))[0].status).toBe("Cancelled");
    expect((await ordersPost(req("/api/orders", "POST", { token: admin, body: { customerId: custA, itemIds: ids2 } }))).status).toBe(201);   // the items can be invoiced again
    void ids;
  });

  it("cartons are invoiced through the carton line and need all their members", async () => {
    const a = await item(db.admin, custA), b = await item(db.admin, custA);
    const c = await json(await cartonsPost(req("/api/cartons", "POST", { token: staff, body: { customerId: custA, itemIds: [a, b], length: 100, width: 100, height: 100 } })));
    expect(c.status).toBe(201);
    expect((await ordersPost(req("/api/orders", "POST", { token: admin, body: { customerId: custA, itemIds: [a] } }))).status).toBe(400);
    const r = await json(await ordersPost(req("/api/orders", "POST", { token: admin, body: { customerId: custA, itemIds: [a, b] } })));
    expect(r.status).toBe(201); expect(r.body.data.invoiceAmount).toBe(350); expect(r.body.data.itemIds.sort()).toEqual([a, b].sort());
  });

  it("Keepup state: reported, never called from a route; clearing links and manual pulls are refused or inert", async () => {
    const { res } = await mkOrder(); const id = res.body.data.id;
    const s = await json(await createInvoice(req("", "POST", { token: admin }), ctx({ id })));
    expect(s.status).toBe(202); expect(s.body.data).toMatchObject({ saleId: null, existing: false });
    expect((await createInvoice(req("", "POST", { token: admin, body: { regenerate: true } }), ctx({ id }))).status).toBe(409);
    expect((await createInvoice(req("", "POST", { token: staff }), ctx({ id }))).status).toBeGreaterThanOrEqual(403);
    await q("UPDATE keepup_sync SET keepup_sale_id = 'S1', sync_state = 'synced' WHERE invoice_id = $1", [id]).catch(() => {});
    expect((await clearInvoice(req("", "DELETE", { token: admin }), ctx({ id }))).status).toBe(409);
    const k = await json(await keepupSync(req("", "POST", { token: admin })));
    expect(k.body).toMatchObject({ success: true, updated: 0 });
    expect((await keepupSync(req("", "POST", { token: staff }))).status).toBe(403);
  });
});
