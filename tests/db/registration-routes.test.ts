// Phase 7G through the REAL route handlers: HTTP request -> auth -> trusted actor -> policy -> service -> repository -> PostgreSQL.
// Only the Firebase boundary (token verification) is faked; the database, the runtime role, the actor mechanism and the policies are real.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; email?: string; emailVerified: boolean }>();
const firebase = vi.hoisted(() => ({ createFirebaseUser: vi.fn(), deleteFirebaseUser: vi.fn(), generatePasswordResetLink: vi.fn(), generateEmailVerificationLink: vi.fn(), setCustomClaims: vi.fn() }));
vi.mock("@/lib/firebase-admin", () => ({
  verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; },
  ...firebase,
}));

import { POST as onboard } from "../../src/app/api/onboard/route";
import { POST as signup } from "../../src/app/api/auth/signup/route";
import { POST as activate } from "../../src/app/api/auth/activate/route";
import { GET as listRoute } from "../../src/app/api/admin/registrations/route";
import { GET as getRoute, PATCH as patchRoute, DELETE as deleteRoute } from "../../src/app/api/admin/registrations/[id]/route";

let ipn = 0;
const ip = () => `198.51.100.${++ipn}`;
const NIL = "00000000-0000-4000-8000-000000000000";

function req(url: string, method: string, opts: { token?: string; body?: unknown; ip?: string; headers?: Record<string, string>; cookie?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? ip(), ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = `auth-token=${opts.cookie}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("registration through the real routes (PostgreSQL)", () => {
  let db: TestDb; let n = 0;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const form = (over: Record<string, unknown> = {}) => { const k = ++n; return { name: `Ada Mensah ${k}`, email: `rt${k}@example.invalid`, phone: `0244${String(2000000 + k)}`, location: "12 Palm Street, Accra", ...over }; };
  const tok = (uid: string, email?: string, emailVerified = true) => { const t = `t-${uid}-${++n}`; tokens.set(t, { uid, email, emailVerified }); return t; };
  const mkUser = async (uid: string, role: "super_admin" | "warehouse_staff") =>
    (await q(`INSERT INTO users (auth_uid,email,role) VALUES ($1,$2,$3) RETURNING id`, [uid, `${uid}@example.invalid`, role]))[0].id as string;
  let adminTok: string, staffTok: string, custTok: string, adminId: string;

  const submit = async (over: Record<string, unknown> = {}) => { const f = form(over); const r = await json(await onboard(req("/api/onboard", "POST", { body: f }))); return { f, r, row: (await q("SELECT * FROM registration_requests WHERE lower(email)=lower($1)", [String(f.email)]))[0] }; };
  const approve = async (id: string) => json(await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { token: adminTok, body: { action: "approve" } }), ctx(id)));
  const approvedReg = async () => { const s = await submit(); await approve(s.row.id); return s; };

  beforeAll(async () => {
    db = await createTestDb();
    setPoolForTests(db.app);
    adminId = await mkUser("fb-admin", "super_admin"); await mkUser("fb-staff", "warehouse_staff");
    const c = await customer(db.admin);
    await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-cust','cust@example.invalid','customer',$1)`, [c]);
    adminTok = tok("fb-admin"); staffTok = tok("fb-staff"); custTok = tok("fb-cust");
  });
  afterAll(async () => { setPoolForTests(undefined); await db?.close(); });

  describe("POST /api/onboard (public request)", () => {
    it("stores a pending request, answers with a generic message, and provisions NOTHING (no Firebase account, customer, user or password)", async () => {
      const before = (await q("SELECT (SELECT count(*) FROM customers)::int AS c, (SELECT count(*) FROM users)::int AS u"))[0];
      const s = await submit();
      expect(s.r).toEqual({ status: 201, body: { success: true, message: "Your registration request has been received." } });
      expect(s.row).toMatchObject({ status: "pending", reviewed_by: null, resulting_customer_id: null, resulting_user_id: null });
      expect((await q("SELECT (SELECT count(*) FROM customers)::int AS c, (SELECT count(*) FROM users)::int AS u"))[0]).toEqual(before);
      for (const fn of Object.values(firebase)) expect(fn).not.toHaveBeenCalled();
      expect(JSON.stringify(s.r)).not.toMatch(/password|uid|role|customerId|shippingMark/i);
    });
    it("rejects malformed input (400) and stores nothing", async () => {
      const cnt = async () => (await q("SELECT count(*)::int AS n FROM registration_requests"))[0].n;
      const before = await cnt();
      for (const body of [{}, { ...form(), email: "nope" }, { ...form(), name: "A" }, { ...form(), phone: "12" }, { ...form(), location: "" }, { name: "Ada Mensah" }, "not json", null, [], { ...form(), notes: "x".repeat(1001) }]) {
        const r = await onboard(req("/api/onboard", "POST", { body }));
        expect(r.status, JSON.stringify(body).slice(0, 50)).toBe(400);
      }
      expect(await cnt()).toBe(before);
    });
    it("rejects every privilege-bearing field (role, status, customerId, authUid, userId, isActive, packageTier, actor, approvedBy, password ...) and stores nothing", async () => {
      const before = (await q("SELECT count(*)::int AS n FROM registration_requests"))[0].n;
      for (const [k, v] of Object.entries({ role: "super_admin", status: "approved", customerId: NIL, customer_id: NIL, authUid: "x", auth_uid: "x", userId: NIL, user_id: NIL, isActive: true, is_active: true,
        packageTier: "special", warehouseId: NIL, rate: 0.01, actorId: NIL, actor_id: NIL, createdBy: NIL, created_by: NIL, approvedBy: NIL, approved_by: NIL, reviewedBy: NIL, password: "hunter22hunter22", resultingCustomerId: NIL })) {
        const r = await json(await onboard(req("/api/onboard", "POST", { body: { ...form(), [k]: v } })));
        expect(r.status, k).toBe(400);
      }
      expect((await q("SELECT count(*)::int AS n FROM registration_requests"))[0].n).toBe(before);
      expect((await q("SELECT count(*)::int AS n FROM users WHERE role <> 'customer'"))[0].n).toBe(2);       // only the two fixtures (admin, staff)
    });
    it("gives the same answer for a new applicant, an existing customer, an existing login and an open duplicate (no account enumeration)", async () => {
      const fresh = await submit();
      const c = await customer(db.admin, { email: "exists@example.invalid", phone: "0555009999" });
      const a = await json(await onboard(req("/api/onboard", "POST", { body: form({ email: "exists@example.invalid" }) })));
      const b = await json(await onboard(req("/api/onboard", "POST", { body: form({ phone: "0555009999" }) })));
      const d = await json(await onboard(req("/api/onboard", "POST", { body: fresh.f })));
      const e = await json(await onboard(req("/api/onboard", "POST", { body: form({ email: "cust@example.invalid" }) })));
      for (const r of [a, b, d, e]) expect(r).toEqual(fresh.r);
      expect((await q("SELECT count(*)::int AS n FROM registration_requests WHERE lower(email) IN ('exists@example.invalid','cust@example.invalid')"))[0].n).toBe(0);
      void c;
    });
    it("is rate limited: per source address (in-memory layer) and per e-mail; the database throttle is a second, independent layer", async () => {
      const same = ip();
      const codes: number[] = [];
      for (let k = 0; k < 7; k++) codes.push((await onboard(req("/api/onboard", "POST", { body: form(), ip: same }))).status);
      expect(codes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(codes.slice(5)).toEqual([429, 429]);
      const email = "burst@example.invalid";
      const e: number[] = [];
      for (let k = 0; k < 4; k++) e.push((await onboard(req("/api/onboard", "POST", { body: form({ email }), ip: ip() }))).status);
      expect(e).toEqual([201, 201, 201, 429]);
    });
    it("concurrent identical submissions from different sources create exactly one request", async () => {
      const f = form();
      const res = await Promise.all(Array.from({ length: 8 }, () => onboard(req("/api/onboard", "POST", { body: f }))));
      expect(res.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(res.every((r) => r.status === 201 || r.status === 429)).toBe(true);        // beyond 3 per e-mail the in-memory limiter answers 429
      expect((await q("SELECT count(*)::int AS n FROM registration_requests WHERE lower(email)=$1", [String(f.email)]))[0].n).toBe(1);
    });
  });

  describe("POST /api/auth/signup (legacy immediate provisioning is gone)", () => {
    it("answers 410, ignores any password, and creates nothing", async () => {
      const before = (await q("SELECT (SELECT count(*) FROM customers)::int AS c, (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM registration_requests)::int AS r"))[0];
      const r = await json(await signup());
      expect(r.status).toBe(410);
      expect(JSON.stringify(r.body)).not.toMatch(/password/i);
      expect((await q("SELECT (SELECT count(*) FROM customers)::int AS c, (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM registration_requests)::int AS r"))[0]).toEqual(before);
      expect(firebase.createFirebaseUser).not.toHaveBeenCalled();
    });
  });

  describe("admin queue and review (super_admin only)", () => {
    it("anonymous 401, staff 403, customer 403, admin 200 - for list, view, approve and reject", async () => {
      const s = await submit(); const id = s.row.id as string;
      const call = async (who: string | undefined) => ({
        list: (await listRoute(req("/api/admin/registrations", "GET", { token: who }))).status,
        get: (await getRoute(req(`/api/admin/registrations/${id}`, "GET", { token: who }), ctx(id))).status,
        patch: (await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { token: who, body: { action: "reject", reason: "r" } }), ctx(id))).status,
      });
      expect(await call(undefined)).toEqual({ list: 401, get: 401, patch: 401 });
      expect(await call("garbage-token")).toEqual({ list: 401, get: 401, patch: 401 });
      expect(await call(staffTok)).toEqual({ list: 403, get: 403, patch: 403 });
      expect(await call(custTok)).toEqual({ list: 403, get: 403, patch: 403 });
      expect((await q("SELECT status FROM registration_requests WHERE id=$1", [id]))[0].status).toBe("pending");
      const l = await json(await listRoute(req("/api/admin/registrations?status=pending", "GET", { token: adminTok })));
      expect(l.status).toBe(200);
      expect(l.body.data.some((r: { id: string }) => r.id === id)).toBe(true);
      expect(l.body.data.every((r: { status: string }) => r.status === "pending")).toBe(true);
      const g = await json(await getRoute(req(`/api/admin/registrations/${id}`, "GET", { token: adminTok }), ctx(id)));
      expect(g.body.data).toMatchObject({ id, status: "pending", email: String(s.f.email).toLowerCase() });
    });
    it("approve: the customer is created exactly once even when repeated, the actor is the authenticated admin, and a body cannot choose anything", async () => {
      const s = await submit(); const id = s.row.id as string;
      const evil = await json(await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { token: adminTok, body: { action: "approve", status: "activated", customerId: NIL, reviewedBy: NIL, role: "super_admin" } }), ctx(id)));
      expect(evil.status).toBe(400);
      expect((await q("SELECT status FROM registration_requests WHERE id=$1", [id]))[0].status).toBe("pending");
      expect((await approve(id)).status).toBe(200);
      expect((await approve(id)).status).toBe(200);
      const r = (await q("SELECT * FROM registration_requests WHERE id=$1", [id]))[0];
      expect(r).toMatchObject({ status: "approved", reviewed_by: adminId });
      expect((await q("SELECT count(*)::int AS n FROM customers WHERE lower(email)=$1", [String(s.f.email)]))[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='registration.approve'", [id]))[0].n).toBe(1);
    });
    it("reject: reason validated, request kept, public learns nothing; approving a rejected one is a 409", async () => {
      const s = await submit(); const id = s.row.id as string;
      for (const reason of ["", "   ", "\n\t"]) expect((await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { token: adminTok, body: { action: "reject", reason } }), ctx(id))).status, JSON.stringify(reason)).toBe(400);
      expect((await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { token: adminTok, body: { action: "reject" } }), ctx(id))).status).toBe(400);
      expect((await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { token: adminTok, body: { action: "reject", reason: "Could not verify" } }), ctx(id))).status).toBe(200);
      expect((await q("SELECT status, rejection_reason, reviewed_by FROM registration_requests WHERE id=$1", [id]))[0]).toEqual({ status: "rejected", rejection_reason: "Could not verify", reviewed_by: adminId });
      expect((await approve(id)).status).toBe(409);
      expect((await q("SELECT count(*)::int AS n FROM customers WHERE lower(email)=$1", [String(s.f.email)]))[0].n).toBe(0);
      // the applicant (anonymous) cannot tell: the same generic answer on a resubmission
      expect((await json(await onboard(req("/api/onboard", "POST", { body: s.f })))).body.message).toBe("Your registration request has been received.");
    });
    it("IDOR / malformed input: unknown and malformed ids are 404 (never 500, never a hint), bad actions and bodies are 400, DELETE is 405", async () => {
      for (const id of [NIL, "x", "1' OR '1'='1", "../1"]) {
        expect((await getRoute(req(`/api/admin/registrations/${encodeURIComponent(id)}`, "GET", { token: adminTok }), ctx(id))).status, id).toBe(404);
        expect((await patchRoute(req(`/api/admin/registrations/${encodeURIComponent(id)}`, "PATCH", { token: adminTok, body: { action: "approve" } }), ctx(id))).status, id).toBe(404);
      }
      const s = await submit(); const id = s.row.id as string;
      for (const body of [{ action: "delete" }, { action: "activate" }, {}, "x", null, { action: "approve", extra: 1 }]) {
        expect((await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { token: adminTok, body }), ctx(id))).status, JSON.stringify(body)).toBe(400);
      }
      expect((await deleteRoute()).status).toBe(405);
      expect((await listRoute(req("/api/admin/registrations?status=bogus", "GET", { token: adminTok }))).status).toBe(400);
      expect((await q("SELECT count(*)::int AS n FROM registration_requests WHERE id=$1", [id]))[0].n).toBe(1);
    });
    it("a cookie-authenticated cross-site write is refused; a deactivated admin loses access on the very next request (no cache)", async () => {
      const s = await submit(); const id = s.row.id as string;
      const x = await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { cookie: adminTok, headers: { origin: "https://evil.example" }, body: { action: "approve" } }), ctx(id));
      expect(x.status).toBe(403);
      expect((await q("SELECT status FROM registration_requests WHERE id=$1", [id]))[0].status).toBe("pending");
      const boss2 = await mkUser("fb-boss2", "super_admin");
      const t2 = tok("fb-boss2");
      expect((await listRoute(req("/api/admin/registrations", "GET", { token: t2 }))).status).toBe(200);
      await q("UPDATE users SET is_active=false, deactivated_at=now() WHERE id=$1", [boss2]);
      expect((await listRoute(req("/api/admin/registrations", "GET", { token: t2 }))).status).toBe(401);
      expect((await patchRoute(req(`/api/admin/registrations/${id}`, "PATCH", { token: t2, body: { action: "approve" } }), ctx(id))).status).toBe(401);
    });
  });

  describe("POST /api/auth/activate (the applicant, with their own verified Firebase login)", () => {
    const act = async (token?: string, body?: unknown) => json(await activate(req("/api/auth/activate", "POST", { token, body })));

    it("a verified identity activates its approved registration: a customer login is created, linked and active; the customer then reaches only their own data", async () => {
      const s = await approvedReg(); const email = String(s.f.email).toLowerCase();
      const r = await act(tok("fb-new-1", email));
      expect(r).toEqual({ status: 201, body: { success: true, data: { activated: true, alreadyActive: false } } });
      const u = (await q("SELECT * FROM users WHERE auth_uid='fb-new-1'"))[0];
      expect(u).toMatchObject({ role: "customer", is_active: true, email });
      expect(u.customer_id).toBe((await q("SELECT resulting_customer_id FROM registration_requests WHERE id=$1", [s.row.id]))[0].resulting_customer_id);
      expect((await q("SELECT status, resulting_user_id FROM registration_requests WHERE id=$1", [s.row.id]))[0]).toEqual({ status: "activated", resulting_user_id: u.id });
      // the new customer is authenticated by the PG chain and is NOT an administrator
      expect((await listRoute(req("/api/admin/registrations", "GET", { token: tok("fb-new-1", email) }))).status).toBe(403);
      expect(JSON.stringify(r)).not.toMatch(/password/i);
    });
    it("retry by the same identity is a 200 with no duplicate user, customer or audit", async () => {
      const s = await approvedReg(); const email = String(s.f.email).toLowerCase(); const t = tok("fb-new-2", email);
      expect((await act(t)).status).toBe(201);
      const before = (await q("SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM customers)::int AS c, (SELECT count(*) FROM audit_logs)::int AS a"))[0];
      expect(await act(t)).toEqual({ status: 200, body: { success: true, data: { activated: true, alreadyActive: true } } });
      expect((await q("SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM customers)::int AS c, (SELECT count(*) FROM audit_logs)::int AS a"))[0]).toEqual(before);
    });
    it("concurrent activation requests create exactly one login", async () => {
      const s = await approvedReg(); const email = String(s.f.email).toLowerCase(); const t = tok("fb-new-3", email);
      const res = await Promise.all(Array.from({ length: 8 }, () => activate(req("/api/auth/activate", "POST", { token: t }))));
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status === 200)).toHaveLength(7);
      expect((await q("SELECT count(*)::int AS n FROM users WHERE lower(email)=$1", [email]))[0].n).toBe(1);
    });
    it("refuses: no token (401), an unverified e-mail (403), a pending or rejected request, a different e-mail, and another uid for an already-activated request (all 404, no hint)", async () => {
      const p = await submit(); const rj = await submit(); await json(await patchRoute(req(`/api/admin/registrations/${rj.row.id}`, "PATCH", { token: adminTok, body: { action: "reject", reason: "no" } }), ctx(rj.row.id)));
      const a = await approvedReg(); const email = String(a.f.email).toLowerCase();
      const before = (await q("SELECT count(*)::int AS n FROM users"))[0].n;
      expect((await act(undefined)).status).toBe(401);
      expect((await act("bogus")).status).toBe(401);
      expect((await act(tok("fb-x1", email, false))).status).toBe(403);
      expect((await act(tok("fb-x2", String(p.f.email).toLowerCase()))).status).toBe(404);
      expect((await act(tok("fb-x3", String(rj.f.email).toLowerCase()))).status).toBe(404);
      expect((await act(tok("fb-x4", "stranger@example.invalid"))).status).toBe(404);
      expect((await act(tok("fb-x5", undefined))).status).toBe(404);   // a verified identity without any e-mail has nothing to match
      expect((await q("SELECT count(*)::int AS n FROM users"))[0].n).toBe(before);
      expect((await act(tok("fb-x6", email))).status).toBe(201);
      expect((await act(tok("fb-x7", email))).status).toBe(404);                       // somebody else cannot take over an activated request
    });
    it("the request body is ignored: uid, email, role, customerId, status and userId in it change nothing", async () => {
      const s = await approvedReg(); const email = String(s.f.email).toLowerCase(); const other = await customer(db.admin);
      const r = await act(tok("fb-new-4", email), { uid: "fb-admin", auth_uid: "fb-admin", email: "cust@example.invalid", role: "super_admin", customerId: other, customer_id: other, status: "approved", userId: adminId, isActive: false });
      expect(r.status).toBe(201);
      const u = (await q("SELECT * FROM users WHERE lower(email)=$1", [email]))[0];
      expect(u).toMatchObject({ auth_uid: "fb-new-4", role: "customer", is_active: true });
      expect(u.customer_id).not.toBe(other);
      expect((await q("SELECT role, auth_uid FROM users WHERE id=$1", [adminId]))[0]).toEqual({ role: "super_admin", auth_uid: "fb-admin" });
    });
    it("a Firebase identity already linked to another user cannot be reused (409), and nothing is changed", async () => {
      const s = await approvedReg(); const email = String(s.f.email).toLowerCase();
      const r = await act(tok("fb-staff", email));                                      // 'fb-staff' belongs to the warehouse-staff fixture
      expect(r.status).toBe(409);
      expect((await q("SELECT status FROM registration_requests WHERE id=$1", [s.row.id]))[0].status).toBe("approved");
      expect((await q("SELECT role FROM users WHERE auth_uid='fb-staff'"))[0].role).toBe("warehouse_staff");
    });
    it("a customer who was deactivated after approval cannot be activated (409: needs administrator attention), and an inactive login stays inactive", async () => {
      const s = await approvedReg(); const email = String(s.f.email).toLowerCase();
      const cid = (await q("SELECT resulting_customer_id FROM registration_requests WHERE id=$1", [s.row.id]))[0].resulting_customer_id;
      await q("UPDATE customers SET status='inactive' WHERE id=$1", [cid]);
      expect((await act(tok("fb-new-5", email))).status).toBe(409);
      expect((await q("SELECT count(*)::int AS n FROM users WHERE customer_id=$1", [cid]))[0].n).toBe(0);
      const t = await approvedReg(); const tEmail = String(t.f.email).toLowerCase(); const tt = tok("fb-new-6", tEmail);
      await act(tt);
      await q("UPDATE users SET is_active=false, deactivated_at=now() WHERE auth_uid='fb-new-6'");
      expect((await listRoute(req("/api/admin/registrations", "GET", { token: tt }))).status).toBe(401);          // inactive user cannot use any PG route
      expect((await act(tt)).status).toBe(200);                                                                  // retry reports the activation ...
      expect((await q("SELECT is_active FROM users WHERE auth_uid='fb-new-6'"))[0].is_active).toBe(false);       // ... but never revives the login
    });
  });
});
