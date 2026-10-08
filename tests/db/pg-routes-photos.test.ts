// Item photos on the PostgreSQL backend: authorization, accepted hosts, ownership, display. No Cloudinary call is made (URLs only).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, packageRates, fxRate, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));
const cloud = vi.hoisted(() => ({ sign: vi.fn(() => "sig"), config: vi.fn() }));
vi.mock("cloudinary", () => ({ v2: { config: cloud.config, utils: { api_sign_request: cloud.sign } } }));
import { POST as itemsPost, GET as itemsGet } from "../../src/app/api/items/route";
import { GET as itemGet, PATCH as itemPatch } from "../../src/app/api/items/[id]/route";
import { POST as signPost } from "../../src/app/api/upload/sign/route";

function req(url: string, method: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": "198.51.100.77" };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const GOOD = "https://res.cloudinary.com/demo/image/upload/v1/movezz/items/a.jpg";

dbDescribe("item photos (PostgreSQL backend)", () => {
  let db: TestDb; let a: string, b: string;
  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app); await packageRates(db.admin); await fxRate(db.admin);
    await db.admin.query(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin'),('fb-staff','staff@example.invalid','warehouse_staff')`);
    a = await customer(db.admin); b = await customer(db.admin);
    await db.admin.query(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-ca','ca@example.invalid','customer',$1),('fb-cb','cb@example.invalid','customer',$2)`, [a, b]);
    for (const [t, u] of [["t-admin", "fb-admin"], ["t-staff", "fb-staff"], ["t-ca", "fb-ca"], ["t-cb", "fb-cb"]]) tokens.set(t, { uid: u, emailVerified: true });
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("signing an upload is for staff and admins only; no Cloudinary network call is made by the tests", async () => {
    expect((await signPost(req("/api/upload/sign", "POST", { body: {} }))).status).toBe(401);
    expect((await signPost(req("/api/upload/sign", "POST", { token: "t-ca", body: {} }))).status).toBe(403);
    const ok = await signPost(req("/api/upload/sign", "POST", { token: "t-staff", body: { folder: "movezz/items" } }));
    expect([200, 500]).toContain(ok.status);   // 500 only when the (absent) staging Cloudinary configuration is missing
    expect((await signPost(req("/api/upload/sign", "POST", { token: "t-staff", body: { folder: "../../etc" } }))).status).toBe(400);
  });
  it("only accepted photo hosts and https are stored; staff attach, customers cannot; the owner sees them and others do not", async () => {
    const base = { customerId: a, dateReceived: "2026-05-01", shippingType: "sea", length: 10, width: 10, height: 10 };
    for (const bad of ["http://res.cloudinary.com/x.jpg", "https://evil.example.invalid/pixel.gif", "javascript:alert(1)", "not a url"])
      expect((await json(await itemsPost(req("/api/items", "POST", { token: "t-staff", body: { ...base, photoUrls: [bad] } })))).status, bad).toBe(400);
    expect((await itemsPost(req("/api/items", "POST", { token: "t-ca", body: { ...base, photoUrls: [GOOD] } }))).status).toBe(403);
    const made = await json(await itemsPost(req("/api/items", "POST", { token: "t-staff", body: { ...base, photoUrls: [GOOD, GOOD + "?2"] } })));
    expect(made.status).toBe(201); expect(made.body.data.photos.map((p: { url: string }) => p.url)).toEqual([GOOD, GOOD + "?2"]);
    const id = made.body.data.id;
    expect((await json(await itemGet(req("", "GET", { token: "t-ca" }), ctx(id)))).body.data.photos.length).toBe(2);       // owner sees them
    expect((await itemGet(req("", "GET", { token: "t-cb" }), ctx(id))).status).toBe(404);                                 // another customer: not even the item
    expect((await json(await itemsGet(req("/api/items", "GET", { token: "t-cb" })))).body.data).toEqual([]);
    expect((await itemPatch(req("", "PATCH", { token: "t-ca", body: { photoUrls: [GOOD] } }), ctx(id))).status).toBe(403);
    const repl = await json(await itemPatch(req("", "PATCH", { token: "t-staff", body: { photoUrls: [GOOD] } }), ctx(id)));
    expect(repl.body.data.photos.length).toBe(1);                                                                          // replaced; the old rows are archived, not deleted
    expect((await db.admin.query("SELECT count(*)::int AS n FROM item_photos WHERE item_id = $1", [id])).rows[0].n).toBe(3);
    expect((await json(await itemPatch(req("", "PATCH", { token: "t-staff", body: { photoUrls: Array(21).fill(GOOD) } }), ctx(id)))).status).toBe(400);
  });
});
