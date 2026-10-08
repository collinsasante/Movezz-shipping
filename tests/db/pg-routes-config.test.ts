// Phase 7L Group C through the REAL route handlers: package rates, special rates, FX settings, warehouses, suppliers.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));

import { GET as ratesGet, PUT as ratesPut } from "../../src/app/api/package-rates/route";
import { GET as specGet, POST as specPost } from "../../src/app/api/special-rates/route";
import { PATCH as specPatch, DELETE as specDelete } from "../../src/app/api/special-rates/[id]/route";
import { GET as settingsGet, PUT as settingsPut } from "../../src/app/api/settings/route";
import { GET as whGet, POST as whPost } from "../../src/app/api/warehouses/route";
import { PATCH as whPatch, DELETE as whDelete } from "../../src/app/api/warehouses/[id]/route";
import { GET as supGet, POST as supPost } from "../../src/app/api/suppliers/route";
import { GET as supOne, PATCH as supPatch, DELETE as supDelete } from "../../src/app/api/suppliers/[id]/route";
import { POST as itemsPost } from "../../src/app/api/items/route";

function req(url: string, method: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": "198.51.100.7" };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = <T extends Record<string, string>>(o: T) => ({ params: Promise.resolve(o) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("Group C on PostgreSQL: configuration (real routes)", () => {
  let db: TestDb; let n = 0; let custA: string;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const tok = (uid: string) => { const t = `t-${uid}-${++n}`; tokens.set(t, { uid, emailVerified: true }); return t; };
  let admin: string, staff: string, ca: string;
  const T = { basic: { sea: 350, air: 8 }, business: { sea: 280, air: 6 }, enterprise: { sea: 450, air: 12 }, special: { sea: 500, air: 15 } };

  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app);
    await q(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin'),('fb-staff','staff@example.invalid','warehouse_staff')`);
    custA = await customer(db.admin);
    await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-ca','ca@example.invalid','customer',$1)`, [custA]);
    admin = tok("fb-admin"); staff = tok("fb-staff"); ca = tok("fb-ca");
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("package rates: everyone reads, only a super_admin writes; a change is versioned and drives the next price", async () => {
    expect((await ratesPut(req("/api/package-rates", "PUT", { token: staff, body: T }))).status).toBe(403);
    expect((await ratesPut(req("/api/package-rates", "PUT", { token: ca, body: T }))).status).toBe(403);
    expect((await ratesPut(req("/api/package-rates", "PUT", { token: admin, body: { basic: T.basic } }))).status).toBe(400);
    expect((await ratesPut(req("/api/package-rates", "PUT", { token: admin, body: { ...T, basic: { sea: -1, air: 1 } } }))).status).toBe(400);
    const w = await json(await ratesPut(req("/api/package-rates", "PUT", { token: admin, body: T })));
    expect(w.status).toBe(200); expect(w.body.data.basic).toEqual({ sea: 350, air: 8 });
    await q(`SELECT 1`);
    await q(`INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at) VALUES ('USD','GHS',12,'test', now() - interval '1 hour')`);
    const it1 = await json(await itemsPost(req("/api/items", "POST", { token: staff, body: { customerId: custA, dateReceived: "2026-03-01", shippingType: "sea", length: 100, width: 100, height: 100 } })));
    expect(it1.body.data.pkgEstShipping).toBe(350);
    await ratesPut(req("/api/package-rates", "PUT", { token: admin, body: { ...T, basic: { sea: 400, air: 8 } } }));
    const it2 = await json(await itemsPost(req("/api/items", "POST", { token: staff, body: { customerId: custA, dateReceived: "2026-03-01", shippingType: "sea", length: 100, width: 100, height: 100 } })));
    expect(it2.body.data.pkgEstShipping).toBe(400);
    expect((await q("SELECT tier_price_usd FROM items WHERE id = $1", [it1.body.data.id]))[0].tier_price_usd).toBe("350.00");     // the old item keeps its snapshot
    expect((await q("SELECT count(*)::int AS n FROM package_rates WHERE tier='basic' AND freight_type='sea'"))[0].n).toBe(2);       // history kept
    expect((await json(await ratesGet(req("/api/package-rates", "GET", { token: ca })))).body.data.basic.sea).toBe(400);
    expect((await ratesGet(req("/api/package-rates", "GET"))).status).toBe(401);
  });

  it("special rates: staff read, only a super_admin writes; invalid input refused; delete retires the card", async () => {
    expect((await specPost(req("/api/special-rates", "POST", { token: staff, body: { name: "VIP", sea: 300, air: 6 } }))).status).toBe(403);
    expect((await specGet(req("/api/special-rates", "GET", { token: ca }))).status).toBe(403);
    expect((await specPost(req("/api/special-rates", "POST", { token: admin, body: { name: "", sea: 1 } }))).status).toBe(400);
    expect((await specPost(req("/api/special-rates", "POST", { token: admin, body: { name: "Zero", sea: 0, air: 0 } }))).status).toBe(400);
    const c = await json(await specPost(req("/api/special-rates", "POST", { token: admin, body: { name: "VIP", sea: 300, air: 6 } })));
    expect(c.status).toBe(201); expect(c.body.data).toMatchObject({ name: "VIP", sea: 300, air: 6 });
    const id = c.body.data.id;
    expect((await specPost(req("/api/special-rates", "POST", { token: admin, body: { name: "VIP", sea: 1, air: 1 } }))).status).toBe(409);   // overlapping duplicate
    expect((await json(await specPatch(req("", "PATCH", { token: admin, body: { name: "VIP", sea: 310, air: 6 } }), ctx({ id })))).body.data.sea).toBe(310);
    expect((await specPatch(req("", "PATCH", { token: staff, body: { name: "VIP", sea: 1, air: 1 } }), ctx({ id }))).status).toBe(403);
    expect((await json(await specGet(req("/api/special-rates", "GET", { token: staff })))).body.data.length).toBe(1);
    expect((await specDelete(req("", "DELETE", { token: admin }), ctx({ id }))).status).toBe(200);
    expect((await json(await specGet(req("/api/special-rates", "GET", { token: staff })))).body.data.length).toBe(0);
    expect((await specDelete(req("", "DELETE", { token: admin }), ctx({ id }))).status).toBe(404);
  });

  it("settings: staff read the current USD->GHS rate, only a super_admin sets it (a new row, bounded); history is kept", async () => {
    expect((await settingsPut(req("/api/settings", "PUT", { token: staff, body: { usdToGhs: 15, shippingRatePerCbm: 200 } }))).status).toBe(403);
    expect((await settingsPut(req("/api/settings", "PUT", { token: admin, body: { usdToGhs: 5000, shippingRatePerCbm: 200 } }))).status).toBe(400);
    expect((await settingsPut(req("/api/settings", "PUT", { token: admin, body: { usdToGhs: 15.5, shippingRatePerCbm: 200 } }))).status).toBe(200);
    expect((await json(await settingsGet(req("/api/settings", "GET", { token: staff })))).body.data.usdToGhs).toBe(15.5);
    expect((await settingsGet(req("/api/settings", "GET", { token: ca }))).status).toBe(403);
    expect((await q("SELECT count(*)::int AS n FROM fx_rates WHERE base_currency='USD' AND quote_currency='GHS'"))[0].n).toBeGreaterThanOrEqual(2);
  });

  it("warehouses: customers see only active ones; only a super_admin writes; delete retires", async () => {
    expect((await whPost(req("/api/warehouses", "POST", { token: staff, body: { name: "W", address: "A" } }))).status).toBe(403);
    expect((await whPost(req("/api/warehouses", "POST", { token: admin, body: { name: "" } }))).status).toBe(400);
    const w1 = (await json(await whPost(req("/api/warehouses", "POST", { token: admin, body: { name: "Accra", address: "Adenta", country: "GH" } })))).body.data;
    const w2 = (await json(await whPost(req("/api/warehouses", "POST", { token: admin, body: { name: "Kumasi", address: "Ahodwo" } })))).body.data;
    expect((await whPatch(req("", "PATCH", { token: admin, body: { isActive: false } }), ctx({ id: w2.id }))).status).toBe(200);
    expect((await json(await whGet(req("/api/warehouses", "GET", { token: ca })))).body.data.map((w: { name: string }) => w.name)).toEqual(["Accra"]);
    expect((await json(await whGet(req("/api/warehouses", "GET", { token: staff })))).body.data.length).toBe(2);
    expect((await whPatch(req("", "PATCH", { token: staff, body: { name: "x" } }), ctx({ id: w1.id }))).status).toBe(403);
    expect((await whPatch(req("", "PATCH", { token: admin, body: {} }), ctx({ id: w1.id }))).status).toBe(400);
    expect((await whDelete(req("", "DELETE", { token: admin }), ctx({ id: w1.id }))).status).toBe(200);
    expect((await whDelete(req("", "DELETE", { token: admin }), ctx({ id: "zz" }))).status).toBe(404);
  });

  it("suppliers: staff read, only a super_admin writes; references are sequential; delete archives", async () => {
    expect((await supPost(req("/api/suppliers", "POST", { token: staff, body: { name: "S" } }))).status).toBe(403);
    expect((await supGet(req("/api/suppliers", "GET", { token: ca }))).status).toBe(403);
    expect((await supPost(req("/api/suppliers", "POST", { token: admin, body: { name: "" } }))).status).toBe(400);
    expect((await supPost(req("/api/suppliers", "POST", { token: admin, body: { name: "S", rating: 9 } }))).status).toBe(400);
    const s = (await json(await supPost(req("/api/suppliers", "POST", { token: admin, body: { name: "Guangzhou Gadgets", platform: "1688", rating: 4 } })))).body.data;
    expect(s.supplierId).toMatch(/^SUP-\d+$/);
    expect((await json(await supOne(req("", "GET", { token: staff }), ctx({ id: s.id })))).body.data.name).toBe("Guangzhou Gadgets");
    expect((await json(await supPatch(req("", "PATCH", { token: admin, body: { rating: 5 } }), ctx({ id: s.id })))).body.data.rating).toBe(5);
    expect((await json(await supGet(req("/api/suppliers?search=guang", "GET", { token: staff })))).body.total).toBe(1);
    expect((await supDelete(req("", "DELETE", { token: staff }), ctx({ id: s.id }))).status).toBe(403);
    expect((await supDelete(req("", "DELETE", { token: admin }), ctx({ id: s.id }))).status).toBe(200);
    expect((await supOne(req("", "GET", { token: staff }), ctx({ id: s.id }))).status).toBe(404);
  });
});
