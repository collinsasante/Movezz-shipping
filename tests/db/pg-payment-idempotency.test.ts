// Payment idempotency at the API boundary (PATCH /api/orders/[id] with an Idempotency-Key header), PostgreSQL backend.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, packageRates, fxRate, item, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));
vi.mock("@/lib/email", () => ({ sendPaymentConfirmedEmail: vi.fn(async () => {}), sendPartialPaymentEmail: vi.fn(async () => {}) }));
import { POST as ordersPost } from "../../src/app/api/orders/route";
import { PATCH as orderPatch } from "../../src/app/api/orders/[id]/route";

function req(body: unknown, key?: string, url = "/api/orders/x", method = "PATCH") {
  const headers: Record<string, string> = { "x-forwarded-for": "198.51.100.8", authorization: "Bearer t-admin", "content-type": "application/json" };
  if (key) headers["idempotency-key"] = key;
  return new NextRequest(`http://localhost${url}`, { method, headers, body: JSON.stringify(body) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

dbDescribe("payment idempotency (PostgreSQL)", () => {
  let db: TestDb; let cust: string;
  const payments = async (id: string) => (await db.admin.query("SELECT count(*)::int AS n, COALESCE(sum(amount_ghs),0)::text AS total FROM payments WHERE invoice_id = $1 AND status = 'completed'", [id])).rows[0];
  const newOrder = async () => (await (await ordersPost(req({ customerId: cust, itemIds: [await item(db.admin, cust)] }, undefined, "/api/orders", "POST"))).json()).data.id as string;
  const pay = (id: string, amount: number, key?: string) => orderPatch(req({ paymentAmount: amount }, key), ctx(id));

  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app);
    await packageRates(db.admin); await fxRate(db.admin, "10.00000000");
    await db.admin.query(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin')`);
    cust = await customer(db.admin); tokens.set("t-admin", { uid: "fb-admin", emailVerified: true });
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("same payment + same key (double click / retry after a successful response) -> one payment, same result", async () => {
    const id = await newOrder();
    const a = await pay(id, 500, "pay-key-aaaa-1"), b = await pay(id, 500, "pay-key-aaaa-1"), c = await pay(id, 500, "pay-key-aaaa-1");
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(jb.data).toMatchObject({ amountPaid: ja.data.amountPaid, balanceDue: ja.data.balanceDue, status: "Partial" });
    expect(await payments(id)).toEqual({ n: 1, total: "500.00" });
  });
  it("same key + different payload -> conflict, nothing recorded", async () => {
    const id = await newOrder();
    expect((await pay(id, 100, "pay-key-bbbb-2")).status).toBe(200);
    expect((await pay(id, 200, "pay-key-bbbb-2")).status).toBe(409);
    expect(await payments(id)).toEqual({ n: 1, total: "100.00" });
  });
  it("two concurrent requests with the same key -> exactly one payment", async () => {
    const id = await newOrder();
    const rs = await Promise.all(Array.from({ length: 5 }, () => pay(id, 300, "pay-key-cccc-3")));
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    expect(await payments(id)).toEqual({ n: 1, total: "300.00" });
  });
  it("two separate intentional payments (different keys) -> two payments", async () => {
    const id = await newOrder();
    expect((await pay(id, 100, "pay-key-dddd-4")).status).toBe(200);
    expect((await pay(id, 100, "pay-key-dddd-5")).status).toBe(200);
    expect(await payments(id)).toEqual({ n: 2, total: "200.00" });
  });
  it("without a key every request is a new intention (the UI always sends one); the database still refuses overpayment", async () => {
    const id = await newOrder();
    expect((await pay(id, 9999999, "pay-key-eeee-6")).status).toBe(422);
    expect(await payments(id)).toEqual({ n: 0, total: "0" });
  });
});
