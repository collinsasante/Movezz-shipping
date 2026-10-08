// Hardening regressions on the PostgreSQL backend: bad values are 400 (not 500), bodies are size-capped, expensive routes are throttled, lists are bounded.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, packageRates, fxRate, item, carton, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));
import { POST as itemsPost } from "../../src/app/api/items/route";
import { POST as ordersPost } from "../../src/app/api/orders/route";
import { POST as containersPost } from "../../src/app/api/containers/route";
import { GET as reportsGet } from "../../src/app/api/reports/route";
import { POST as keepupSync } from "../../src/app/api/orders/keepup-sync/route";
import { GET as cartonsGet } from "../../src/app/api/cartons/route";
import { GET as sortingGet } from "../../src/app/api/sorting/route";

function req(url: string, method: string, token: string, body?: unknown, raw?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "x-forwarded-for": "198.51.100.60" };
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
}
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("hardening (PostgreSQL backend)", () => {
  let db: TestDb; let a: string;
  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app); await packageRates(db.admin); await fxRate(db.admin);
    await db.admin.query(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin'),('fb-admin2','admin2@example.invalid','super_admin'),('fb-staff','staff@example.invalid','warehouse_staff')`);
    a = await customer(db.admin);
    for (const [t, u] of [["t-admin", "fb-admin"], ["t-admin2", "fb-admin2"], ["t-staff", "fb-staff"]]) tokens.set(t, { uid: u, emailVerified: true });
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("malformed dates and values from the caller are 400, never 500", async () => {
    const base = { customerId: a, shippingType: "sea", length: 10, width: 10, height: 10 };
    expect((await itemsPost(req("/api/items", "POST", "t-staff", { ...base, dateReceived: "2026-13-45" }))).status).toBe(400);
    expect((await itemsPost(req("/api/items", "POST", "t-staff", { ...base, dateReceived: "2026-02-31" }))).status).toBe(400);
    const it1 = await item(db.admin, a);
    expect((await ordersPost(req("/api/orders", "POST", "t-admin", { customerId: a, itemIds: [it1], invoiceDate: "2026-99-99" }))).status).toBe(400);
    expect((await containersPost(req("/api/containers", "POST", "t-admin", { trackingNumber: "C1", eta: "2026-00-10" }))).status).toBe(400);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM items WHERE customer_id = $1", [a])).rows[0].n).toBe(1);     // nothing half-created
  });

  it("request bodies are size-capped (declared and actual)", async () => {
    const big = JSON.stringify({ customerId: a, dateReceived: "2026-05-01", description: "x".repeat(300_000) });
    const r = await json(await itemsPost(req("/api/items", "POST", "t-staff", undefined, big)));
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/too large/);
    expect((await itemsPost(req("/api/items", "POST", "t-staff", undefined, "{not json"))).status).toBe(400);
  });

  it("expensive routes are throttled per user (reports 30/min, Keepup sync 6/min)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await reportsGet(req("/api/reports", "GET", "t-admin2"))).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true); expect(codes.slice(30)).toEqual([429, 429]);
    expect((await reportsGet(req("/api/reports", "GET", "t-admin"))).status).toBe(200);                      // another user is unaffected
    const k: number[] = []; for (let i = 0; i < 8; i++) k.push((await keepupSync(req("/api/orders/keepup-sync", "POST", "t-admin"))).status);
    expect(k.slice(0, 6).every((c) => c === 200)).toBe(true); expect(k.slice(6)).toEqual([429, 429]);
  });

  it("the open-carton list is grouped correctly and bounded; the sorting list is capped with exact counts", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) { const c = await carton(db.admin, a); const it = await item(db.admin, a, { carton_id: c }); ids.push(it); }
    const list = await json(await cartonsGet(req("/api/cartons", "GET", "t-staff")));
    expect(list.status).toBe(200); expect(list.body.data.length).toBe(25);
    expect(list.body.data.every((c: { items: unknown[]; cartonNumber: string }) => c.items.length === 1 && /^CTN-/.test(c.cartonNumber))).toBe(true);
    await db.admin.query(`INSERT INTO items (item_ref, customer_id, status) SELECT 'SRT-' || g, $1, 'Sorting' FROM generate_series(1, 520) g`, [a]);
    const s = await json(await sortingGet(req("/api/sorting", "GET", "t-staff")));
    expect(s.body.data.sorting.length).toBe(500); expect(s.body.data.sortingCount).toBe(520);
  });
});
