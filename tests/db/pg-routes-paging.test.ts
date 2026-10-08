// Lists are paged in SQL (count + LIMIT/OFFSET): a page never loads the whole table, totals are exact, ownership still applies.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, packageRates, fxRate, item, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));
import { GET as itemsGet } from "../../src/app/api/items/route";
import { GET as ordersGet, POST as ordersPost } from "../../src/app/api/orders/route";

const get = (url: string, token: string) => new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "198.51.100.44" } });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

dbDescribe("SQL paging of lists (PostgreSQL backend)", () => {
  let db: TestDb; let a: string, b: string;
  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app); await packageRates(db.admin); await fxRate(db.admin);
    await db.admin.query(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin')`);
    a = await customer(db.admin); b = await customer(db.admin);
    await db.admin.query(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-ca','ca@example.invalid','customer',$1)`, [a]);
    tokens.set("t-admin", { uid: "fb-admin", emailVerified: true }); tokens.set("t-ca", { uid: "fb-ca", emailVerified: true });
    for (let i = 0; i < 120; i++) await item(db.admin, a, { description: `bulk ${i}` });
    for (let i = 0; i < 5; i++) await item(db.admin, b);
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("items: exact totals, stable pages, limit capped at 500, scope kept", async () => {
    const p1 = await json(await itemsGet(get("/api/items?limit=50&page=1", "t-admin"))), p3 = await json(await itemsGet(get("/api/items?limit=50&page=3", "t-admin")));
    expect(p1.body).toMatchObject({ total: 125, totalPages: 3, page: 1 }); expect(p1.body.data.length).toBe(50); expect(p3.body.data.length).toBe(25);
    const ids1 = p1.body.data.map((i: { id: string }) => i.id), ids2 = (await json(await itemsGet(get("/api/items?limit=50&page=2", "t-admin")))).body.data.map((i: { id: string }) => i.id);
    expect(new Set([...ids1, ...ids2]).size).toBe(100);                                                  // no overlap between pages
    expect((await json(await itemsGet(get("/api/items?limit=99999", "t-admin")))).body.data.length).toBe(125);   // capped at 500, here fewer rows exist
    const own = await json(await itemsGet(get(`/api/items?customerId=${b}&limit=10`, "t-ca")));
    expect(own.body.total).toBe(120); expect(own.body.data.length).toBe(10); expect(own.body.data.every((i: { customerId: string }) => i.customerId === a)).toBe(true);
    expect((await json(await itemsGet(get("/api/items?search=bulk%2011&limit=50", "t-admin")))).body.total).toBeGreaterThan(0);
    expect((await json(await itemsGet(get("/api/items?page=99", "t-admin")))).body.data).toEqual([]);
  });
  it("orders: paged in SQL with exact totals", async () => {
    for (let i = 0; i < 3; i++) await ordersPost(new NextRequest("http://localhost/api/orders", { method: "POST", headers: { authorization: "Bearer t-admin", "content-type": "application/json", "x-forwarded-for": "198.51.100.45" }, body: JSON.stringify({ customerId: a, itemIds: [(await db.admin.query("SELECT id FROM items WHERE customer_id = $1 AND invoice_id IS NULL AND description = $2", [a, `bulk ${i}`])).rows[0].id] }) }));
    const r = await json(await ordersGet(get("/api/orders", "t-admin")));
    expect(r.body).toMatchObject({ total: 3, totalPages: 1, page: 1 }); expect(r.body.data.length).toBe(3);
  });
});
