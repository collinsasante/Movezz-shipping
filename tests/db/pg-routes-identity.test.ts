// Phase 7L Group A through the REAL route handlers with MOVEZZ_DATA_BACKEND=postgres: sign-in, staff users, customers.
// Only Firebase and e-mail are faked; database, runtime role, actor mechanism and policies are real.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";
import { dataBackend } from "../../src/lib/backend";

const tokens = new Map<string, { uid: string; email?: string; emailVerified: boolean }>();
const fb = vi.hoisted(() => ({ createFirebaseUser: vi.fn(), deleteFirebaseUser: vi.fn(async () => {}), setCustomClaims: vi.fn(async () => {}), generatePasswordResetLink: vi.fn(async () => "https://example.invalid/reset") }));
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; }, ...fb }));
vi.mock("@/lib/email", () => ({ sendPasswordResetEmail: vi.fn(async () => {}), sendWelcomeEmail: vi.fn(async () => {}) }));

import { POST as verify, DELETE as signOut } from "../../src/app/api/auth/verify/route";
import { GET as verifyCookie } from "../../src/app/api/auth/verify-cookie/route";
import { GET as usersGet, POST as usersPost } from "../../src/app/api/users/route";
import { DELETE as userDelete } from "../../src/app/api/users/[id]/route";
import { GET as customersGet, POST as customersPost } from "../../src/app/api/customers/route";
import { GET as customerGet, PATCH as customerPatch, DELETE as customerDelete } from "../../src/app/api/customers/[id]/route";

let ipn = 0;
function req(url: string, method: string, o: { token?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": `198.51.100.${++ipn}`, ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = `auth-token=${o.cookie}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("Group A on PostgreSQL: auth, users, customers (real routes)", () => {
  let db: TestDb; let n = 0; let adminId: string, staffId: string, custA: string, custB: string;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const tok = (uid: string, emailVerified = true) => { const t = `t-${uid}-${++n}`; tokens.set(t, { uid, emailVerified }); return t; };
  let admin: string, staff: string, ca: string, cb: string;

  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app);
    adminId = (await q(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin') RETURNING id`))[0].id;
    staffId = (await q(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-staff','staff@example.invalid','warehouse_staff') RETURNING id`))[0].id;
    custA = await customer(db.admin); custB = await customer(db.admin);
    await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-ca','ca@example.invalid','customer',$1),('fb-cb','cb@example.invalid','customer',$2)`, [custA, custB]);
    admin = tok("fb-admin"); staff = tok("fb-staff"); ca = tok("fb-ca"); cb = tok("fb-cb");
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  it("backend selection is explicit: default airtable, postgres only when asked, anything else throws", () => {
    const v = process.env.MOVEZZ_DATA_BACKEND;
    try {
      delete process.env.MOVEZZ_DATA_BACKEND; expect(dataBackend()).toBe("airtable");
      process.env.MOVEZZ_DATA_BACKEND = "postgres"; expect(dataBackend()).toBe("postgres");
      process.env.MOVEZZ_DATA_BACKEND = "pg"; expect(() => dataBackend()).toThrow(/must be/);
    } finally { process.env.MOVEZZ_DATA_BACKEND = v; }
  });

  it("no mixed sources: with the PostgreSQL backend, shared auth helpers use PostgreSQL and any Airtable access fails loudly", async () => {
    const { requireAuth } = await import("../../src/lib/auth");
    const { usersApi } = await import("../../src/lib/airtable");
    const okAuth = await requireAuth(req("/api/upload/sign", "POST", { token: staff }), ["super_admin", "warehouse_staff"]);
    expect(okAuth instanceof Response).toBe(false); expect((okAuth as { user: { role: string } }).user.role).toBe("warehouse_staff");
    expect(((await requireAuth(req("/x", "POST", { token: ca }), ["super_admin", "warehouse_staff"])) as Response).status).toBe(403);
    expect(((await requireAuth(req("/x", "POST", { token: "bogus" }), ["super_admin"])) as Response).status).toBe(401);
    await expect(usersApi.getByFirebaseUid("anything")).rejects.toThrow(/Airtable is disabled/);
  });

  describe("sign-in", () => {
    it("known users get their profile and a cookie; unknown identities are NOT_REGISTERED (no e-mail claiming, no first-user admin)", async () => {
      const r = await json(await verify(req("/api/auth/verify", "POST", { body: { idToken: ca } })));
      expect(r.status).toBe(200); expect(r.body.data.user).toMatchObject({ role: "customer", customerId: custA }); expect(Object.keys(r.body.data.user)).toContain("shippingMark");
      expect((await verify(req("/api/auth/verify", "POST", { body: { idToken: tok("ghost") } }))).status).toBe(404);
      expect((await verify(req("/api/auth/verify", "POST", { body: { idToken: "nope" } }))).status).toBe(401);
      expect((await verify(req("/api/auth/verify", "POST", { body: {} }))).status).toBe(400);
      expect((await q("SELECT count(*)::int AS n FROM users"))[0].n).toBe(4);
      expect((await signOut()).headers.get("set-cookie")).toMatch(/Max-Age=0/);
    });
    it("verify-cookie accepts a valid cookie and refuses missing or unknown ones", async () => {
      expect((await verifyCookie(req("/api/auth/verify-cookie", "GET", { cookie: admin }))).status).toBe(200);
      expect((await verifyCookie(req("/api/auth/verify-cookie", "GET"))).status).toBe(401);
      expect((await verifyCookie(req("/api/auth/verify-cookie", "GET", { cookie: tok("ghost") }))).status).toBe(401);
    });
  });

  describe("staff users (super_admin only)", () => {
    it("list/create/delete are admin-only; role comes from the database, never from headers", async () => {
      expect((await usersGet(req("/api/users", "GET"))).status).toBe(401);
      for (const t of [staff, ca]) expect((await usersGet(req("/api/users", "GET", { token: t }))).status).toBe(403);
      expect((await usersGet(req("/api/users", "GET", { token: staff, headers: { "x-role": "super_admin" } }))).status).toBe(403);
      const list = await json(await usersGet(req("/api/users", "GET", { token: admin })));
      expect(list.status).toBe(200); expect(list.body.data.length).toBe(4);

      fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-new-staff" });
      const c = await json(await usersPost(req("/api/users", "POST", { token: admin, body: { email: "new.staff@example.invalid", role: "warehouse_staff" } })));
      expect(c.status).toBe(201); expect(c.body.data.user).toMatchObject({ role: "warehouse_staff", email: "new.staff@example.invalid" }); expect(c.body.data.emailSent).toBe(true);
      expect(JSON.stringify(c.body)).not.toMatch(/_email|_role/);
      expect((await usersPost(req("/api/users", "POST", { token: staff, body: { email: "x@example.invalid", role: "super_admin" } }))).status).toBe(403);   // no escalation by staff
      expect((await usersPost(req("/api/users", "POST", { token: admin, body: { email: "bad", role: "super_admin" } }))).status).toBe(400);
      expect((await usersPost(req("/api/users", "POST", { token: admin, body: { email: "c@example.invalid", role: "customer" } }))).status).toBe(400);
      expect((await usersPost(req("/api/users", "POST", { token: admin, body: { email: "boss@example.invalid", role: "super_admin" } }))).status).toBe(400);   // administrators come from the bootstrap procedure only

      fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-admin" });                      // collides with an existing login -> the Firebase user is removed again
      const dup = await usersPost(req("/api/users", "POST", { token: admin, body: { email: "dup@example.invalid", role: "warehouse_staff" } }));
      expect(dup.status).toBe(409); expect(fb.deleteFirebaseUser).toHaveBeenCalledWith("fb-admin");

      const del = await json(await userDelete(req(`/api/users/${c.body.data.user.id}`, "DELETE", { token: admin }), ctx(c.body.data.user.id)));
      expect(del.status).toBe(200);
      expect((await verify(req("/api/auth/verify", "POST", { body: { idToken: tok("fb-new-staff") } }))).status).toBe(403);   // deleted = deactivated
      expect((await userDelete(req(`/api/users/${adminId}`, "DELETE", { token: admin }), ctx(adminId))).status).toBe(403);    // nobody removes their own account (the last-super-admin rule is tested at the database level)
      expect((await userDelete(req(`/api/users/${staffId}`, "DELETE", { token: staff }), ctx(staffId))).status).toBe(403);
      expect((await userDelete(req("/api/users/not-a-uuid", "DELETE", { token: admin }), ctx("not-a-uuid"))).status).toBe(404);
    });
  });

  describe("customers", () => {
    it("staff and admin list; customers cannot; search and pagination work", async () => {
      expect((await customersGet(req("/api/customers", "GET", { token: staff }))).status).toBe(200);
      expect((await customersGet(req("/api/customers", "GET", { token: ca }))).status).toBe(403);
      expect((await customersGet(req("/api/customers", "GET"))).status).toBe(401);
      const r = await json(await customersGet(req("/api/customers?limit=1&page=1", "GET", { token: admin })));
      expect(r.body).toMatchObject({ success: true, page: 1 }); expect(r.body.data.length).toBe(1); expect(r.body.total).toBeGreaterThanOrEqual(2);
      const s = await json(await customersGet(req("/api/customers?search=%25", "GET", { token: admin })));
      expect(s.status).toBe(200);
    });
    it("a customer reads only their own record (IDOR/BOLA -> 404); staff read any; malformed ids are 404", async () => {
      const own = await json(await customerGet(req(`/api/customers/${custA}`, "GET", { token: ca }), ctx(custA)));
      expect(own.status).toBe(200); expect(own.body.data).toMatchObject({ id: custA, totalItems: 0, totalOrders: 0 });
      expect((await customerGet(req(`/api/customers/${custB}`, "GET", { token: ca }), ctx(custB))).status).toBe(404);
      expect((await customerGet(req(`/api/customers/${custA}`, "GET", { token: staff }), ctx(custA))).status).toBe(200);
      expect((await customerGet(req("/api/customers/zzz", "GET", { token: admin }), ctx("zzz"))).status).toBe(404);
      expect((await customerGet(req(`/api/customers/${custA}`, "GET"), ctx(custA))).status).toBe(401);
    });
    it("only a super_admin creates customers; the mark is generated, the phone is unique, a login is linked", async () => {
      fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-newcust" });
      const body = { name: "Kofi Mensah", phone: "+233244555123", email: "kofi@example.invalid" };
      const c = await json(await customersPost(req("/api/customers", "POST", { token: admin, body })));
      expect(c.body.error ?? c.body.code).toBeUndefined(); expect(c.status).toBe(201); expect(c.body.data.customer.shippingMark).toMatch(/^MOVEZZ-KM5123/); expect(c.body.data.emailSent).toBe(true);
      expect((await q("SELECT role, customer_id FROM users WHERE auth_uid = 'fb-newcust'"))[0]).toMatchObject({ role: "customer", customer_id: c.body.data.customer.id });
      fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-newcust2" });
      expect((await customersPost(req("/api/customers", "POST", { token: admin, body }))).status).toBe(400);                               // duplicate phone
      expect((await customersPost(req("/api/customers", "POST", { token: staff, body: { ...body, phone: "+233244999000" } }))).status).toBe(403);
      expect((await customersPost(req("/api/customers", "POST", { token: ca, body: { ...body, phone: "+233244999001" } }))).status).toBe(403);
      expect((await customersPost(req("/api/customers", "POST", { token: admin, body: { name: "K" } }))).status).toBe(400);
    });
    it("customers may change only address and notes of their own record; admins change the rest; staff change nothing", async () => {
      const mine = (b: unknown, id = custA, t = ca) => customerPatch(req(`/api/customers/${id}`, "PATCH", { token: t, body: b }), ctx(id));
      expect((await json(await mine({ notes: "call me", shippingAddress: "Accra" }))).status).toBe(200);
      for (const bad of [{ status: "inactive" }, { name: "Mallory" }, { shippingMark: "X" }, { customerId: custB }, { role: "super_admin" }]) expect((await mine(bad)).status, JSON.stringify(bad)).toBe(400);
      expect((await mine({ notes: "x" }, custB)).status).toBe(404);
      expect((await mine({ notes: "x" }, custA, staff)).status).toBe(403);
      expect((await q("SELECT name, notes FROM customers WHERE id = $1", [custA]))[0].notes).toBe("call me");
      const a = await json(await mine({ package: "business", shippingType: "air", status: "active" }, custA, admin));
      expect(a.status).toBe(200); expect(a.body.data).toMatchObject({ package: "business", shippingType: "air" });
      expect((await mine({ exchangeRate: 14 }, custA, admin)).status).toBe(400);                                                      // central FX only
      expect((await mine({ package: "gold" }, custA, admin)).status).toBe(400);
    });
    it("deactivating a customer revokes its login at once; deleting archives (history is never lost) and is admin-only", async () => {
      const id = custB;
      expect((await customerPatch(req(`/api/customers/${id}`, "PATCH", { token: admin, body: { status: "inactive" } }), ctx(id))).status).toBe(200);
      expect((await customersGet(req("/api/customers", "GET", { token: cb }))).status).toBe(401);            // stale token, deactivated login
      expect((await verify(req("/api/auth/verify", "POST", { body: { idToken: tok("fb-cb") } }))).status).toBe(403);
      expect((await customerDelete(req(`/api/customers/${id}`, "DELETE", { token: staff }), ctx(id))).status).toBe(403);
      expect((await customerDelete(req(`/api/customers/${id}`, "DELETE", { token: admin }), ctx(id))).status).toBe(200);
      expect((await q("SELECT archived_at FROM customers WHERE id = $1", [id]))[0].archived_at).not.toBeNull();
      expect((await customerDelete(req(`/api/customers/${id}`, "DELETE", { token: admin }), ctx(id))).status).toBe(404);
    });
  });
});
