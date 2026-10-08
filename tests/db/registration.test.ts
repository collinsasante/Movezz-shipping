// Phase 7G: registration request -> approval -> verified activation, against real PostgreSQL through the RUNTIME role.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { dbDescribe, createTestDb, customer, staffUser, sqlstate, type TestDb } from "./helpers";
import { user, withActorTransaction, type ActorAssertion } from "../../src/lib/db/actor";
import * as reg from "../../src/lib/db/registration";
import * as repo from "../../src/lib/db/ownership";
import { DomainError } from "../../src/lib/db/errors";

let kn = 0;
const code = async (p: Promise<unknown>) => {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : ((e as { code?: string }).code ?? `RAW:${(e as Error).message}`); }
};

dbDescribe("registration lifecycle (PostgreSQL)", () => {
  let db: TestDb; let admin: string, admin2: string, staff: string, custLogin: string;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const as = <T>(a: string | ActorAssertion, fn: (tx: pg.PoolClient) => Promise<T>) => withActorTransaction(db.app, typeof a === "string" ? user(a) : a, fn);
  const input = (over: Partial<reg.PublicRegistrationInput> = {}): reg.PublicRegistrationInput => {
    const n = ++kn;
    return { name: `Ada  Mensah ${n}`, email: `Applicant${n}@Example.INVALID`, phone: `+233 24 ${String(1000000 + n)}`, location: "12 Palm Street, Accra", ...over };
  };
  const submit = (over: Partial<reg.PublicRegistrationInput> = {}, key: string | null = `k${kn}`) => reg.submitRegistration(db.app, input(over), key);
  const rows = (email: string) => q("SELECT * FROM registration_requests WHERE lower(email)=lower($1)", [email]);
  const pending = async (over: Partial<reg.PublicRegistrationInput> = {}) => {
    const i = input(over); await reg.submitRegistration(db.app, i, `k${kn}`);
    return { i, id: (await rows(i.email))[0].id as string };
  };
  const approved = async (over: Partial<reg.PublicRegistrationInput> = {}) => {
    const p = await pending(over); const { customerId } = await reg.approveRegistration(db.app, user(admin), p.id);
    return { ...p, customerId };
  };
  const ident = (p: { i: reg.PublicRegistrationInput }, over: Partial<reg.VerifiedIdentity> = {}): reg.VerifiedIdentity =>
    ({ uid: `fb-${++kn}`, email: p.i.email.toLowerCase(), emailVerified: true, ...over });
  const counts = async () => ({
    cust: (await q("SELECT count(*)::int AS n FROM customers"))[0].n, usr: (await q("SELECT count(*)::int AS n FROM users"))[0].n,
    reg: (await q("SELECT count(*)::int AS n FROM registration_requests"))[0].n, aud: (await q("SELECT count(*)::int AS n FROM audit_logs"))[0].n,
    ev: (await q("SELECT count(*)::int AS n FROM status_events"))[0].n, out: (await q("SELECT count(*)::int AS n FROM notification_outbox"))[0].n,
  });

  beforeAll(async () => {
    db = await createTestDb();
    admin = await staffUser(db.admin, "super_admin"); admin2 = await staffUser(db.admin, "super_admin"); staff = await staffUser(db.admin, "warehouse_staff");
    const c0 = await customer(db.admin);
    custLogin = (await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('uc','uc@example.invalid','customer',$1) RETURNING id`, [c0]))[0].id;
  });
  afterAll(async () => { await db?.close(); });

  describe("public submission", () => {
    it("stores a pending request with normalized data, a system-actor audit row without personal data, and no password anywhere", async () => {
      const i = input({ name: "  Kofi   Boateng ", phone: " 0244 123 456 7", phone2: " 0200 000 111 ", notes: "  call me  " });
      expect(await reg.submitRegistration(db.app, i, "key-a")).toBe("received");
      const r = (await rows(i.email))[0];
      expect(r).toMatchObject({ status: "pending", name: "Kofi Boateng", email: i.email.toLowerCase(), phone: "024412345 67".replace(" ", ""), phone2: "0200000111", notes: "call me", reviewed_by: null, resulting_customer_id: null, resulting_user_id: null });
      expect(r.client_key).toBe("key-a");
      const a = await q("SELECT actor_type, actor_user_id, action, after_data FROM audit_logs WHERE entity_id=$1", [r.id]);
      expect(a).toEqual([{ actor_type: "system", actor_user_id: null, action: "registration.submit", after_data: { status: "pending" } }]);
      expect(JSON.stringify(a)).not.toMatch(/@|0244|Kofi/);
      const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name='registration_requests'")).map((c) => c.column_name);
      expect(cols.filter((c) => /pass|secret|token|credential/i.test(c))).toEqual([]);
    });
    it("rejects malformed and incomplete requests without storing anything", async () => {
      const before = await counts();
      for (const bad of [{ email: "not-an-email" }, { email: "a@b" }, { name: "A" }, { name: "   " }, { phone: "123" }, { phone: "" }, { location: "" }, { location: " " },
        { name: "x".repeat(201) }, { notes: "x".repeat(1001) }, { email: `${"a".repeat(250)}@example.invalid` }]) {
        expect(await code(submit(bad as never)), JSON.stringify(bad).slice(0, 60)).toBe("INVALID_INPUT");
      }
      const missing = { name: "Ada Mensah", email: "m@example.invalid" } as unknown as reg.PublicRegistrationInput;
      expect(await code(reg.submitRegistration(db.app, missing, null))).toBe("INVALID_INPUT");
      expect(await counts()).toEqual(before);
    });
    it("rejects privilege-bearing fields (role, status, customer_id, auth_uid, user_id, is_active, actor, created_by ...) and stores nothing", async () => {
      const before = await counts();
      for (const field of ["role", "status", "customer_id", "customerId", "auth_uid", "authUid", "user_id", "is_active", "reviewed_by", "approved_by", "created_by", "actor_id", "packageTier", "warehouseId", "rate", "password"]) {
        expect(await code(reg.submitRegistration(db.app, { ...input(), [field]: "super_admin" } as never, null)), field).toBe("INVALID_INPUT");
      }
      expect(await counts()).toEqual(before);
    });
    it("is callable only under the server's system actor: not by a user, not anonymously, not by raw SQL", async () => {
      const i = input();
      const call = (a: ActorAssertion | null) => code(a ? as(a, (tx) => tx.query("SELECT movezz_sec.submit_registration($1,$2,$3,NULL,NULL,$4,NULL,NULL)", [i.name, i.email, i.phone, i.location]))
        : db.app.query("SELECT movezz_sec.submit_registration($1,$2,$3,NULL,NULL,$4,NULL,NULL)", [i.name, i.email, i.phone, i.location]).then(() => "OK"));
      expect(await call(user(admin))).toBe("NOT_AUTHORIZED");
      expect(await call({ type: "integration" })).toBe("NOT_AUTHORIZED");
      expect(await sqlstate(db.app.query("SELECT movezz_sec.submit_registration('Ada Mensah','x@example.invalid','0244000000',NULL,NULL,'Accra',NULL,NULL)"))).toBe("MV012");   // no actor at all
      expect((await rows(i.email)).length).toBe(0);
      for (const sql of [`INSERT INTO registration_requests (email, name, status, reviewed_by, reviewed_at, resulting_customer_id) VALUES ('x@example.invalid','X','approved',NULL,now(),NULL)`,
        "UPDATE registration_requests SET status='approved'", "DELETE FROM registration_requests"]) {
        expect(await sqlstate(db.app.query(sql)), sql).toBe("42501");
        expect(await code(as(admin, (tx) => tx.query(sql))), `admin: ${sql}`).toBe("42501");           // not even a super_admin edits the table directly
      }
    });
    it("duplicates: an open request for the same e-mail or phone is not stored twice, and the caller cannot tell", async () => {
      const i = input();
      expect(await reg.submitRegistration(db.app, i, null)).toBe("received");
      expect(await reg.submitRegistration(db.app, { ...i, email: i.email.toUpperCase() }, null)).toBe("received");           // same e-mail, different case
      expect(await reg.submitRegistration(db.app, { ...input(), phone: `+233${i.phone.replace(/\D/g, "").slice(3)}` }, null)).toBe("received");   // same phone digits formatted differently, other e-mail
      expect((await rows(i.email)).length).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM registration_requests WHERE phone_digits = $1", [i.phone.replace(/\D/g, "")]))[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action='registration.ignored' AND after_data->>'reason'='open_request'"))[0].n).toBeGreaterThanOrEqual(2);
    });
    it("concurrent duplicate submissions create exactly one request", async () => {
      const i = input();
      const res = await Promise.all(Array.from({ length: 12 }, () => code(reg.submitRegistration(db.app, i, null))));
      expect(res.every((r) => r === "OK")).toBe(true);
      expect((await rows(i.email)).length).toBe(1);
    });
    it("a person who already has a login or customer record (active or not) creates nothing and gets the same answer", async () => {
      const c = await customer(db.admin, { email: "known@example.invalid", phone: "0555123456" });
      const before = await counts();
      for (const over of [{ email: "KNOWN@example.invalid" }, { phone: "0555 123 456" }, { email: "uc@example.invalid" }]) {
        expect(await reg.submitRegistration(db.app, input(over), null)).toBe("received");
      }
      await q("UPDATE customers SET status='inactive' WHERE id=$1", [c]);
      expect(await reg.submitRegistration(db.app, input({ email: "known@example.invalid" }), null)).toBe("received");
      expect((await counts()).reg).toBe(before.reg);
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action='registration.ignored' AND after_data->>'reason'='existing_account'"))[0].n).toBe(4);
    });
    it("database throttles: per source, per e-mail per day, and the error is reported as RATE_LIMITED", async () => {
      for (let n = 0; n < 5; n++) expect(await code(submit({}, "same-source"))).toBe("OK");
      expect(await code(submit({}, "same-source"))).toBe("RATE_LIMITED");
      expect(await code(submit({}, "other-source"))).toBe("OK");
      // one e-mail may re-apply at most 3 times a day (even after rejections)
      const email = "retry@example.invalid";
      for (let n = 0; n < 3; n++) {
        const i = input({ email }); expect(await code(reg.submitRegistration(db.app, i, null))).toBe("OK");
        const r = (await rows(email)).find((x) => x.status === "pending"); await reg.rejectRegistration(db.app, user(admin), r.id, "test");
      }
      expect(await code(reg.submitRegistration(db.app, input({ email }), null))).toBe("RATE_LIMITED");
    });
    it("the client key is a salted hash, never the address", () => {
      const k = reg.clientKeyFor("203.0.113.9", "pepper");
      expect(k).toMatch(/^[0-9a-f]{32}$/);
      expect(k).not.toContain("203");
      expect(reg.clientKeyFor("203.0.113.9", "pepper")).toBe(k);
      expect(reg.clientKeyFor("203.0.113.10", "pepper")).not.toBe(k);
    });
  });

  describe("data isolation", () => {
    it("only a super_admin can read the queue: staff, customers and anonymous sessions get nothing, even by raw SQL", async () => {
      const p = await pending();
      for (const who of [staff, custLogin]) {
        expect(await code(reg.listRegistrations(db.app, user(who))), who).toBe("NOT_AUTHORIZED");
        expect(await code(reg.getRegistration(db.app, user(who), p.id)), who).toBe("NOT_AUTHORIZED");
        expect((await as(who, (tx) => tx.query("SELECT id FROM registration_requests"))).rows).toEqual([]);                 // row-level security
      }
      expect((await db.app.query("SELECT id FROM registration_requests")).rows).toEqual([]);
      expect((await as({ type: "system" }, (tx) => tx.query("SELECT id FROM registration_requests"))).rows).toEqual([]);
      expect((await reg.listRegistrations(db.app, user(admin))).some((r) => r.id === p.id)).toBe(true);
      expect((await reg.getRegistration(db.app, user(admin), p.id))?.email).toBe(p.i.email.toLowerCase());
    });
    it("malformed and unknown ids look the same (null), and a status filter cannot be abused", async () => {
      for (const bad of ["x", "", "' OR 1=1 --", "00000000-0000-4000-8000-000000000000", "../../etc"]) expect(await reg.getRegistration(db.app, user(admin), bad), bad).toBeNull();
      expect(await code(reg.listRegistrations(db.app, user(admin), { status: "pending' OR '1'='1" }))).toBe("INVALID_INPUT");
      expect((await reg.listRegistrations(db.app, user(admin), { status: "rejected" })).every((r) => r.status === "rejected")).toBe(true);
    });
  });

  describe("approval", () => {
    it("a super_admin approves: the customer is created from the request's own data, with audit, status event and an applicant notification", async () => {
      const p = await pending({ name: "Efua Owusu", phone: "0201112222", location: "5 Ring Road, Accra", notes: "Prefers WhatsApp" });
      const before = await counts();
      const { customerId } = await reg.approveRegistration(db.app, user(admin), p.id);
      const c = (await q("SELECT * FROM customers WHERE id=$1", [customerId]))[0];
      expect(c).toMatchObject({ name: "Efua Owusu", email: p.i.email.toLowerCase(), phone: "0201112222", shipping_address: "5 Ring Road, Accra", notes: "Prefers WhatsApp", status: "active", archived_at: null, package_tier: "basic", preferred_warehouse_id: null });
      expect(c.shipping_mark).toBe("MOVEZZ-EO2222");
      const r = (await rows(p.i.email))[0];
      expect(r).toMatchObject({ status: "approved", reviewed_by: admin, resulting_customer_id: customerId, resulting_user_id: null });
      expect(r.reviewed_at).toBeTruthy();
      expect((await q("SELECT actor_user_id, actor_type, before_data, after_data FROM audit_logs WHERE entity_id=$1 AND action='registration.approve'", [r.id]))).toMatchObject([{ actor_user_id: admin, actor_type: "user", before_data: { status: "pending" }, after_data: { status: "approved", customer_id: customerId } }]);
      expect((await q("SELECT old_status, new_status FROM status_events WHERE entity_type='registration_request' AND entity_id=$1", [r.id]))).toEqual([{ old_status: "pending", new_status: "approved" }]);
      expect((await q("SELECT event_type, recipient, payload FROM notification_outbox WHERE dedupe_key=$1", [`registration.approved:${r.id}`]))).toEqual([{ event_type: "registration.approved", recipient: p.i.email.toLowerCase(), payload: { registration_id: r.id } }]);
      const after = await counts();
      expect({ cust: after.cust - before.cust, usr: after.usr - before.usr, out: after.out - before.out }).toEqual({ cust: 1, usr: 0, out: 1 });     // a customer record, but NO login yet
    });
    it("staff, customers and anonymous sessions cannot approve; nothing is created", async () => {
      const p = await pending(); const before = await counts();
      expect(await code(reg.approveRegistration(db.app, user(staff), p.id))).toBe("NOT_AUTHORIZED");
      expect(await code(reg.approveRegistration(db.app, user(custLogin), p.id))).toBe("NOT_AUTHORIZED");
      expect(await code(reg.approveRegistration(db.app, { type: "system" }, p.id))).toBe("NOT_AUTHORIZED");
      expect(await code(withActorTransaction(db.app, user(staff), (tx) => tx.query("SELECT movezz_sec.approve_registration($1)", [p.id])))).toBe("NOT_AUTHORIZED");   // bypassing the service does not help
      expect(await sqlstate(db.app.query("SELECT movezz_sec.approve_registration($1)", [p.id]))).toBe("MV012");
      expect(await counts()).toEqual(before);
      expect((await rows(p.i.email))[0].status).toBe("pending");
    });
    it("is idempotent: approving again returns the same customer and creates no second customer, audit row or notification", async () => {
      const a = await approved(); const before = await counts();
      expect((await reg.approveRegistration(db.app, user(admin2), a.id)).customerId).toBe(a.customerId);
      expect(await counts()).toEqual(before);
      expect((await q("SELECT count(*)::int AS n FROM customers WHERE lower(email)=lower($1)", [a.i.email]))[0].n).toBe(1);
    });
    it("concurrent approvals by two administrators create exactly one customer", async () => {
      const p = await pending(); const before = await counts();
      const res = await Promise.all([reg.approveRegistration(db.app, user(admin), p.id), reg.approveRegistration(db.app, user(admin2), p.id), reg.approveRegistration(db.app, user(admin), p.id)]);
      expect(new Set(res.map((r) => r.customerId)).size).toBe(1);
      const after = await counts();
      expect({ cust: after.cust - before.cust, aud: after.aud - before.aud }).toEqual({ cust: 1, aud: 1 });
      expect((await q("SELECT reviewed_by FROM registration_requests WHERE id=$1", [p.id]))[0].reviewed_by).toMatch(/^[0-9a-f-]{36}$/);
    });
    it("a rejected or activated request cannot be approved; an unknown or malformed id is REGISTRATION_NOT_ELIGIBLE", async () => {
      const r = await pending(); await reg.rejectRegistration(db.app, user(admin), r.id, "not a real business");
      expect(await code(reg.approveRegistration(db.app, user(admin), r.id))).toBe("INVALID_STATE");
      const a = await approved(); await reg.activateRegistration(db.app, ident(a));
      expect(await code(reg.approveRegistration(db.app, user(admin), a.id))).toBe("INVALID_STATE");   // approve is idempotent only while the request is 'approved'
    });
    it("approving does not merge with or revive an existing record: a conflicting customer blocks it (REGISTRATION_CONFLICT)", async () => {
      const p = await pending({ phone: "0277001122" }); const before = await counts();
      await customer(db.admin, { phone: "0277001122", email: "someone-else@example.invalid" });     // appeared after the request was made
      expect(await code(reg.approveRegistration(db.app, user(admin), p.id))).toBe("REGISTRATION_CONFLICT");
      expect((await counts()).cust).toBe(before.cust + 1 /* the fixture itself */);
      expect((await rows(p.i.email))[0]).toMatchObject({ status: "pending", resulting_customer_id: null });
    });
    it("unknown / malformed ids", async () => {
      for (const id of ["00000000-0000-4000-8000-000000000000", "nope", "1' OR '1'='1"]) {
        expect(await code(reg.approveRegistration(db.app, user(admin), id)), id).toBe("REGISTRATION_NOT_ELIGIBLE");
        expect(await code(reg.rejectRegistration(db.app, user(admin), id, "x")), id).toBe("REGISTRATION_NOT_ELIGIBLE");
      }
    });
  });

  describe("rejection", () => {
    it("a super_admin rejects with a reason: the request is kept, with reviewer, timestamp, reason, audit and status event", async () => {
      const p = await pending(); const before = await counts();
      await reg.rejectRegistration(db.app, user(admin), p.id, "Could not verify the business");
      const r = (await rows(p.i.email))[0];
      expect(r).toMatchObject({ status: "rejected", reviewed_by: admin, rejection_reason: "Could not verify the business", resulting_customer_id: null, resulting_user_id: null });
      expect(r.reviewed_at).toBeTruthy();
      expect((await q("SELECT actor_user_id, after_data FROM audit_logs WHERE entity_id=$1 AND action='registration.reject'", [r.id]))).toMatchObject([{ actor_user_id: admin, after_data: { status: "rejected", reason: "Could not verify the business" } }]);
      const after = await counts();
      expect({ cust: after.cust - before.cust, usr: after.usr - before.usr, reg: after.reg - before.reg }).toEqual({ cust: 0, usr: 0, reg: 0 });           // nothing deleted, nothing created
      expect(await code(reg.rejectRegistration(db.app, user(admin), p.id, "again"))).toBe("INVALID_STATE");
      expect(await code(reg.activateRegistration(db.app, ident(p)))).toBe("REGISTRATION_NOT_ELIGIBLE");
    });
    it("a reason is mandatory and must contain a non-whitespace character", async () => {
      const p = await pending();
      for (const bad of ["", "   ", "\t", "\n", " \n\t ", "x".repeat(1001)]) expect(await code(reg.rejectRegistration(db.app, user(admin), p.id, bad)), JSON.stringify(bad).slice(0, 20)).toBe("INVALID_INPUT");
      expect(await code(reg.rejectRegistration(db.app, user(admin), p.id, null as never))).toBe("INVALID_INPUT");
      expect((await rows(p.i.email))[0].status).toBe("pending");
    });
    it("staff, customers and anonymous sessions cannot reject; an approved request cannot be rejected", async () => {
      const p = await pending();
      expect(await code(reg.rejectRegistration(db.app, user(staff), p.id, "no"))).toBe("NOT_AUTHORIZED");
      expect(await code(reg.rejectRegistration(db.app, user(custLogin), p.id, "no"))).toBe("NOT_AUTHORIZED");
      expect(await sqlstate(db.app.query("SELECT movezz_sec.reject_registration($1,'x')", [p.id]))).toBe("MV012");
      await reg.approveRegistration(db.app, user(admin), p.id);
      expect(await code(reg.rejectRegistration(db.app, user(admin), p.id, "changed my mind"))).toBe("INVALID_STATE");
    });
  });

  describe("activation (verified Firebase identity)", () => {
    it("a verified identity activates its approved registration: one active customer login, linked, role customer, audited", async () => {
      const a = await approved(); const f = ident(a); const before = await counts();
      const r = await reg.activateRegistration(db.app, f);
      expect(r).toMatchObject({ customerId: a.customerId, alreadyActive: false });
      const u = (await q("SELECT * FROM users WHERE id=$1", [r.userId]))[0];
      expect(u).toMatchObject({ auth_uid: f.uid, email: a.i.email.toLowerCase(), role: "customer", customer_id: a.customerId, is_active: true, deactivated_at: null });
      expect((await rows(a.i.email))[0]).toMatchObject({ status: "activated", resulting_user_id: r.userId, resulting_customer_id: a.customerId });
      expect((await rows(a.i.email))[0].activated_at).toBeTruthy();
      expect((await q("SELECT action, actor_type, actor_user_id FROM audit_logs WHERE entity_id = ANY($1) ORDER BY id", [[a.id, r.userId]])).map((x) => `${x.action}:${x.actor_type}:${x.actor_user_id}`))
        .toEqual(expect.arrayContaining(["registration.activate:system:null", "user.create:system:null"]));
      const after = await counts();
      expect({ usr: after.usr - before.usr, cust: after.cust - before.cust }).toEqual({ usr: 1, cust: 0 });
      // the new login works and is confined to its own customer
      expect((await as(r.userId, (tx) => repo.getCustomer(tx, a.customerId)))?.id).toBe(a.customerId);
      const other = await customer(db.admin);
      expect(await as(r.userId, (tx) => repo.getCustomer(tx, other))).toBeNull();
      expect(await code(as(r.userId, (tx) => tx.query("SELECT movezz_sec.admin_set_user_role($1,'warehouse_staff',NULL)", [r.userId])))).toBe("NOT_AUTHORIZED");
    });
    it("pending, rejected, unknown, unverified, wrong-email and empty identities are all the same REGISTRATION_NOT_ELIGIBLE and create nothing", async () => {
      const p = await pending(); const rj = await pending(); await reg.rejectRegistration(db.app, user(admin), rj.id, "no");
      const a = await approved(); const before = await counts();
      const attempts: reg.VerifiedIdentity[] = [ident(p), ident(rj), ident(a, { emailVerified: false }), ident(a, { email: "someone-else@example.invalid" }), ident(a, { email: null }), ident(a, { uid: "" }),
        { uid: "u", email: "nobody@example.invalid", emailVerified: true }];
      for (const f of attempts) expect(await code(reg.activateRegistration(db.app, f)), JSON.stringify(f)).toBe("REGISTRATION_NOT_ELIGIBLE");
      expect(await counts()).toEqual(before);
    });
    it("is idempotent for the same identity (no duplicate user, customer or audit) and refuses any other identity for that registration", async () => {
      const a = await approved(); const f = ident(a);
      const first = await reg.activateRegistration(db.app, f); const before = await counts();
      const again = await reg.activateRegistration(db.app, f);
      expect(again).toEqual({ userId: first.userId, customerId: first.customerId, alreadyActive: true });
      expect(await counts()).toEqual(before);
      expect(await code(reg.activateRegistration(db.app, ident(a)))).toBe("REGISTRATION_NOT_ELIGIBLE");                // another uid cannot claim it
      expect(await counts()).toEqual(before);
    });
    it("concurrent activation: exactly one customer login and one successful creation, however many requests race", async () => {
      const a = await approved(); const f = ident(a); const before = await counts();
      const res = await Promise.all(Array.from({ length: 10 }, () => reg.activateRegistration(db.app, f)));
      expect(res.filter((r) => !r.alreadyActive)).toHaveLength(1);
      expect(new Set(res.map((r) => r.userId)).size).toBe(1);
      const after = await counts();
      expect({ usr: after.usr - before.usr, cust: after.cust - before.cust }).toEqual({ usr: 1, cust: 0 });
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='registration.activate'", [a.id]))[0].n).toBe(1);
      // two DIFFERENT identities racing for the same verified e-mail: still one login
      const b = await approved(); const r2 = await Promise.all([reg.activateRegistration(db.app, ident(b)), reg.activateRegistration(db.app, ident(b))].map((p) => code(p)));
      expect(r2.sort()).toEqual(["OK", "REGISTRATION_NOT_ELIGIBLE"]);
      expect((await q("SELECT count(*)::int AS n FROM users WHERE customer_id=$1", [b.customerId]))[0].n).toBe(1);
    });
    it("one Firebase identity can never be linked to two users, and an existing user with that e-mail is never adopted", async () => {
      const a = await approved(); const used = ident(a);
      const owner = await approved(); await reg.activateRegistration(db.app, ident(owner, { uid: used.uid }));          // the uid now belongs to `owner`
      expect(await code(reg.activateRegistration(db.app, used))).toBe("REGISTRATION_CONFLICT");
      expect((await rows(a.i.email))[0].status).toBe("approved");
      expect((await q("SELECT count(*)::int AS n FROM users WHERE auth_uid=$1", [used.uid]))[0].n).toBe(1);
      const b = await approved();
      await q(`INSERT INTO users (auth_uid,email,role) VALUES ('squatter',$1,'warehouse_staff')`, [b.i.email.toLowerCase()]);
      expect(await code(reg.activateRegistration(db.app, ident(b)))).toBe("REGISTRATION_CONFLICT");
      expect((await q("SELECT role FROM users WHERE auth_uid='squatter'"))[0].role).toBe("warehouse_staff");            // untouched
    });
    it("is callable only under the system actor", async () => {
      const a = await approved(); const f = ident(a);
      for (const who of [user(admin), user(staff), { type: "integration" as const }, { type: "import" as const }]) {
        expect(await code(as(who, (tx) => tx.query("SELECT * FROM movezz_sec.activate_registration($1,$2,true)", [f.uid, f.email]))), JSON.stringify(who)).toBe("NOT_AUTHORIZED");
      }
      expect(await sqlstate(db.app.query("SELECT * FROM movezz_sec.activate_registration($1,$2,true)", [f.uid, f.email]))).toBe("MV012");
      expect((await rows(a.i.email))[0].status).toBe("approved");
    });
  });

  describe("account state", () => {
    it("an inactive or archived customer cannot be activated into a login (explicit super_admin resolution required)", async () => {
      const a = await approved(); await q("UPDATE customers SET status='inactive' WHERE id=$1", [a.customerId]);
      const b = await approved(); await q("UPDATE customers SET status='inactive', archived_at=now() WHERE id=$1", [b.customerId]);
      const before = await counts();
      expect(await code(reg.activateRegistration(db.app, ident(a)))).toBe("REGISTRATION_CONFLICT");
      expect(await code(reg.activateRegistration(db.app, ident(b)))).toBe("REGISTRATION_CONFLICT");
      expect(await counts()).toEqual(before);
      expect((await rows(a.i.email))[0].status).toBe("approved");
    });
    it("deactivation sticks: an inactive user cannot act; reactivating the customer does not reactivate the login; activation never revives anything", async () => {
      const a = await approved(); const r = await reg.activateRegistration(db.app, ident(a));
      expect((await as(r.userId, (tx) => repo.getCustomer(tx, a.customerId)))?.id).toBe(a.customerId);
      await q("UPDATE customers SET status='inactive' WHERE id=$1", [a.customerId]);
      expect((await q("SELECT is_active FROM users WHERE id=$1", [r.userId]))[0].is_active).toBe(false);
      expect(await code(as(r.userId, (tx) => repo.getCustomer(tx, a.customerId)))).toBe("ACTOR_INVALID");
      await q("UPDATE customers SET status='active' WHERE id=$1", [a.customerId]);
      expect((await q("SELECT is_active FROM users WHERE id=$1", [r.userId]))[0].is_active).toBe(false);                 // no implicit reactivation
      expect(await code(as(r.userId, (tx) => repo.getCustomer(tx, a.customerId)))).toBe("ACTOR_INVALID");
      // a retry by the same identity does not revive the login either (it just reports the existing activation)
      await reg.activateRegistration(db.app, { uid: (await q("SELECT auth_uid FROM users WHERE id=$1", [r.userId]))[0].auth_uid, email: a.i.email.toLowerCase(), emailVerified: true });
      expect((await q("SELECT is_active FROM users WHERE id=$1", [r.userId]))[0].is_active).toBe(false);
      // only a super_admin can reactivate, explicitly
      await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_active($1,true,'confirmed with customer')", [r.userId]));
      expect((await as(r.userId, (tx) => repo.getCustomer(tx, a.customerId)))?.id).toBe(a.customerId);
    });
    it("a customer who already has a login (even a disabled one) is never given a second one through registration", async () => {
      const a = await approved();
      await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('old-login','old-login@example.invalid','customer',$1)`, [a.customerId]);
      await q("UPDATE users SET is_active=false, deactivated_at=now() WHERE auth_uid='old-login'");
      expect(await code(reg.activateRegistration(db.app, ident(a)))).toBe("REGISTRATION_CONFLICT");
      expect((await q("SELECT count(*)::int AS n FROM users WHERE customer_id=$1", [a.customerId]))[0].n).toBe(1);
    });
  });

  describe("no partial state (rollback)", () => {
    const inject = async (table: string, when: string, label: string, fn: () => Promise<unknown>) => {
      await q(`CREATE OR REPLACE FUNCTION test_boom_${label}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END $$`);
      await q(`CREATE TRIGGER test_boom_${label} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION test_boom_${label}()`);
      try { return await fn(); } finally { await q(`DROP TRIGGER test_boom_${label} ON ${table}`); }
    };
    it("approval: a failure after the customer is created, after the registration update, after the audit row, or after the status event leaves no customer, no state change, no audit", async () => {
      for (const [table, when, label] of [["registration_requests", "NEW.status = 'approved'", "a1"], ["notification_outbox", "NEW.event_type = 'registration.approved'", "a2"],
        ["audit_logs", "NEW.action = 'registration.approve'", "a3"], ["status_events", "NEW.entity_type = 'registration_request'", "a4"]] as const) {
        const p = await pending(); const before = await counts();
        const err = await inject(table, when, label, () => reg.approveRegistration(db.app, user(admin), p.id).catch((e) => e as Error));
        expect(String((err as Error).message), label).toMatch(/injected failure/);
        expect(await counts(), label).toEqual(before);
        expect((await rows(p.i.email))[0], label).toMatchObject({ status: "pending", resulting_customer_id: null, reviewed_by: null });
        expect(await code(reg.approveRegistration(db.app, user(admin), p.id)), `${label} retry`).toBe("OK");              // and it is retryable
      }
    });
    it("activation: a failure after the user is created, after the registration update, after the audit rows, or after the status event leaves no user and an approved request", async () => {
      for (const [table, when, label] of [["registration_requests", "NEW.status = 'activated'", "b1"], ["audit_logs", "NEW.action = 'registration.activate'", "b2"],
        ["audit_logs", "NEW.action = 'user.create'", "b3"], ["status_events", "NEW.entity_type = 'registration_request' AND NEW.new_status = 'activated'", "b4"]] as const) {
        const a = await approved(); const before = await counts();
        const err = await inject(table, when, label, () => reg.activateRegistration(db.app, ident(a)).catch((e) => e as Error));
        expect(String((err as Error).message), label).toMatch(/injected failure/);
        expect(await counts(), label).toEqual(before);
        expect((await rows(a.i.email))[0], label).toMatchObject({ status: "approved", resulting_user_id: null });
        expect(await code(reg.activateRegistration(db.app, ident(a))), `${label} retry`).toBe("OK");
      }
    });
    it("the cross-system recovery state is explicit: Firebase accounts are created BY THE APPLICANT, so a failed activation leaves the request 'approved' and the applicant simply retries (idempotent); an orphan Firebase login has no Movezz user and therefore no access", async () => {
      const a = await approved(); const f = ident(a);
      await inject("users", "true", "c1", () => reg.activateRegistration(db.app, f).catch(() => null));
      expect((await rows(a.i.email))[0].status).toBe("approved");
      expect((await q("SELECT count(*)::int AS n FROM users WHERE auth_uid=$1", [f.uid]))[0].n).toBe(0);
      expect(await code(as(admin, (tx) => repo.getCustomer(tx, a.customerId)))).toBe("OK");
      expect((await reg.activateRegistration(db.app, f)).alreadyActive).toBe(false);
    });
  });

  describe("lifecycle invariants in the database", () => {
    it("transitions only go forward and terminal states cannot be edited, even by the owner", async () => {
      const rj = await pending(); await reg.rejectRegistration(db.app, user(admin), rj.id, "no");
      const a = await approved(); await reg.activateRegistration(db.app, ident(a));
      const ap = await approved();
      for (const [id, sql] of [[rj.id, "UPDATE registration_requests SET status='approved' WHERE id=$1"], [rj.id, "UPDATE registration_requests SET status='activated', activated_at=now() WHERE id=$1"],
        [a.id, "UPDATE registration_requests SET status='pending' WHERE id=$1"], [a.id, "UPDATE registration_requests SET status='approved' WHERE id=$1"], [a.id, "UPDATE registration_requests SET notes='x' WHERE id=$1"],
        [ap.id, "UPDATE registration_requests SET status='pending' WHERE id=$1"], [ap.id, "UPDATE registration_requests SET status='rejected', rejection_reason='x', reviewed_at=now() WHERE id=$1"]]) {
        expect(await sqlstate(db.admin.query(sql, [id])), sql).toBe("MV005");
      }
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET resulting_customer_id = $2 WHERE id=$1", [ap.id, (await q("SELECT id FROM customers LIMIT 1"))[0].id]))).toBe("MV005");   // cannot be re-bound
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET status='activated', activated_at=now() WHERE id=$1", [(await pending()).id]))).toBe("MV005");   // no activation without approval
    });
    it("unique e-mail, unique auth uid and one login per customer are enforced by the database", async () => {
      const a = await approved(); const r = await reg.activateRegistration(db.app, ident(a));
      const u = (await q("SELECT * FROM users WHERE id=$1", [r.userId]))[0];
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role) VALUES ($1,'x1@example.invalid','warehouse_staff')", [u.auth_uid]))).toBe("23505");
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role) VALUES ('x2',upper($1),'warehouse_staff')", [u.email]))).toBe("23505");
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('x3','x3@example.invalid','customer',$1)", [u.customer_id]))).toBe("23505");
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('x4','x4@example.invalid','customer',gen_random_uuid())"))).toBe("23503");
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role) VALUES ('x5','x5@example.invalid','customer')"))).toBe("23514");
    });
    it("registration never creates a privileged account, whatever the data says", async () => {
      const a = await approved({ name: "Root Admin", email: "root-admin@example.invalid", notes: "role=super_admin" });
      const r = await reg.activateRegistration(db.app, ident(a));
      expect((await q("SELECT role FROM users WHERE id=$1", [r.userId]))[0].role).toBe("customer");
      expect((await q("SELECT count(*)::int AS n FROM users WHERE role <> 'customer' AND auth_uid LIKE 'fb-%'"))[0].n).toBe(0);
    });
    it("every lifecycle mutation is audited and no audit row contains a credential", async () => {
      const actions = (await q("SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'registration.%' OR action = 'user.create' ORDER BY 1")).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(["registration.submit", "registration.ignored", "registration.approve", "registration.reject", "registration.activate", "user.create"]));
      expect(JSON.stringify(await q("SELECT before_data, after_data FROM audit_logs WHERE action LIKE 'registration.%'"))).not.toMatch(/password|token|secret|credential/i);
    });
  });
});
