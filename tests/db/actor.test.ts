// Phase 7C: trusted actor context and audit/status-history integrity.
// These tests attack the mechanism the way a compromised or buggy application would: through the RUNTIME role
// (movezz_app, plain SQL, no superuser) and through forged/replayed/tampered assertions.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import {
  dbDescribe, createTestDb, createBareTestDb, customer, item, staffUser, fxRate, packageRates, sqlstate, actorQuery,
  TEST_ACTOR_KEY, type TestDb,
} from "./helpers";
import {
  user, mintAssertion, withActorTransaction, currentActorId, actorKeyFromEnv,
} from "../../src/lib/db/actor";
import { recordAudit, recordStatusEvent } from "../../src/lib/db/audit";
import { createInvoice, recordPayment, voidPayment, cancelInvoice } from "../../src/lib/db/invoices";
import { priceItem } from "../../src/lib/db/pricing";
import { DomainError } from "../../src/lib/db/errors";
import { migrate } from "../../scripts/lib/migrate.mjs";

let kn = 0;
const key = () => `actor-${Date.now()}-${++kn}-abcdefgh`;
const code = async (p: Promise<unknown>) => {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : ((e as { code?: string }).code ?? `RAW:${(e as Error).message}`); }
};

/** Runs `fn` on a runtime-role connection inside a transaction that is always rolled back. Raw errors are NOT wrapped. */
async function rawTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("BEGIN"); return await fn(c); } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
}
const callBegin = (c: pg.PoolClient, a: ReturnType<typeof mintAssertion>) =>
  c.query("SELECT movezz_sec.begin_actor($1,$2,$3,$4,$5,$6)", [a.type, a.userId, a.requestId, a.jti, a.exp, a.sig]);

async function customerLogin(db: pg.Pool, customerId: string, active = true) {
  const i = Math.floor(Math.random() * 1e9);
  const r = await db.query(
    `INSERT INTO users (auth_uid,email,role,customer_id,is_active,deactivated_at) VALUES ($1,$2,'customer',$3,$4,CASE WHEN $4 THEN NULL ELSE now() END) RETURNING id`,
    [`uid-c${i}`, `cu${i}@example.invalid`, customerId, active]);
  return r.rows[0].id as string;
}
async function inactiveStaff(db: pg.Pool) {
  const id = await staffUser(db);
  await db.query("UPDATE users SET is_active=false, deactivated_at=now() WHERE id=$1", [id]);
  return id;
}

dbDescribe("HMAC primitive (PostgreSQL)", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.close(); });

  const pgMac = async (k: Buffer, m: Buffer) => (await db.admin.query("SELECT encode(movezz_sec.hmac_sha256($1,$2),'hex') AS h", [k, m])).rows[0].h as string;

  it("matches the RFC 4231 test vectors (including a key longer than the block size)", async () => {
    expect(await pgMac(Buffer.alloc(20, 0x0b), Buffer.from("Hi There"))).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    expect(await pgMac(Buffer.from("Jefe"), Buffer.from("what do ya want for nothing?"))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(await pgMac(Buffer.alloc(131, 0xaa), Buffer.from("Test Using Larger Than Block-Size Key - Hash Key First")))
      .toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });
  it("equals Node's HMAC-SHA256 for random keys and messages", async () => {
    for (let i = 0; i < 25; i++) {
      const k = randomBytes(1 + Math.floor(Math.random() * 150)); const m = randomBytes(Math.floor(Math.random() * 300));
      expect(await pgMac(k, m)).toBe(createHmac("sha256", k).update(m).digest("hex"));
    }
  });
  it("the TypeScript message layout equals the database message layout", async () => {
    const a = mintAssertion(user("11111111-1111-1111-1111-111111111111", "req-1"), TEST_ACTOR_KEY);
    const r = await db.admin.query("SELECT convert_from(movezz_sec.assertion_message($1,$2,$3,$4,$5),'UTF8') AS m", [a.type, a.userId, a.requestId, a.jti, a.exp]);
    expect(r.rows[0].m).toBe(`v1|user|${a.userId}|req-1|${a.jti}|${a.exp}`);
  });
});

dbDescribe("trusted actor context (PostgreSQL)", () => {
  let db: TestDb; let alice: string; let bob: string; let warehouse: string;
  beforeAll(async () => {
    db = await createTestDb();
    alice = await staffUser(db.admin, "super_admin"); bob = await staffUser(db.admin, "super_admin"); warehouse = await staffUser(db.admin, "warehouse_staff");
    await packageRates(db.admin);
  });
  afterAll(async () => { await db?.close(); });

  const sessionFor = async (userId: string) => {
    const a = mintAssertion(user(userId), TEST_ACTOR_KEY);
    return rawTx(db.app, async (c) => {
      await callBegin(c, a);
      return (await c.query("SELECT movezz_sec.current_actor_id() AS id, movezz_sec.current_actor_type() AS t")).rows[0];
    });
  };

  describe("actor resolution", () => {
    it("a valid, active user resolves to exactly that user", async () => {
      expect(await sessionFor(alice)).toEqual({ id: alice, t: "user" });
    });
    it("the role and customer link come from the users table, never from the caller (there is no role argument at all)", async () => {
      const c = await customer(db.admin); const cu = await customerLogin(db.admin, c);
      const args = (await db.admin.query(`SELECT array_to_string(proargnames, ',') AS n FROM pg_proc WHERE proname='begin_actor' AND pronamespace='movezz_sec'::regnamespace`)).rows[0].n;
      expect(args).toBe("p_type,p_user,p_request_id,p_jti,p_exp,p_sig");
      for (const [uid, role, cust] of [[warehouse, "warehouse_staff", null], [cu, "customer", c]] as const) {
        const a = mintAssertion(user(uid), TEST_ACTOR_KEY);
        const s = await withActorTransaction(db.admin, { type: "user", userId: uid, requestId: a.requestId }, async (tx) => {
          return (await tx.query("SELECT role, customer_id FROM movezz_sec.actor_sessions WHERE txid = pg_current_xact_id_if_assigned()")).rows[0];
        }, TEST_ACTOR_KEY);
        expect(s).toEqual({ role, customer_id: cust });
      }
    });
    it("a user that does not exist is rejected (MV007)", async () => {
      expect(await sqlstate(sessionFor("00000000-0000-4000-8000-000000000001"))).toBe("MV007");
    });
    it("an inactive user is rejected", async () => {
      expect(await sqlstate(sessionFor(await inactiveStaff(db.admin)))).toBe("MV007");
    });
    it("a customer login whose customer is not active is rejected; an active one is accepted", async () => {
      const c = await customer(db.admin); const cu = await customerLogin(db.admin, c);
      expect((await sessionFor(cu)).id).toBe(cu);
      await db.admin.query("UPDATE customers SET status='inactive' WHERE id=$1", [c]);
      expect(await sqlstate(sessionFor(cu))).toBe("MV007");
    });
    it("a client cannot impersonate: an assertion signed for Alice cannot be re-pointed at Bob", async () => {
      const a = mintAssertion(user(alice), TEST_ACTOR_KEY);
      const forged = { ...a, userId: bob };
      expect(await sqlstate(rawTx(db.app, (c) => callBegin(c, forged)))).toBe("MV007");
    });
    it("a client cannot impersonate by signing with a key of its own", async () => {
      const a = mintAssertion(user(bob), randomBytes(32));
      expect(await sqlstate(rawTx(db.app, (c) => callBegin(c, a)))).toBe("MV007");
    });
    it("a client cannot turn a user assertion into a service assertion (or the reverse) by changing the type", async () => {
      const a = mintAssertion(user(alice), TEST_ACTOR_KEY);
      expect(await sqlstate(rawTx(db.app, (c) => callBegin(c, { ...a, type: "system" })))).toBe("MV007");
      const s = mintAssertion({ type: "system" }, TEST_ACTOR_KEY);
      expect(await sqlstate(rawTx(db.app, (c) => callBegin(c, { ...s, type: "user", userId: alice })))).toBe("MV007");
    });
    it("tampering with request id, jti, expiry or signature is rejected", async () => {
      const a = mintAssertion(user(alice), TEST_ACTOR_KEY);
      const flipped = (a.sig[0] === "0" ? "1" : "0") + a.sig.slice(1);
      for (const bad of [{ ...a, requestId: "other-request" }, { ...a, jti: randomBytes(16).toString("hex") }, { ...a, exp: a.exp + 1 }, { ...a, sig: flipped }, { ...a, sig: "zz" }]) {
        expect(await sqlstate(rawTx(db.app, (c) => callBegin(c, bad)))).toBe("MV007");
      }
    });
    it("an expired assertion and a far-future (long-lived) assertion are rejected", async () => {
      const now = new Date();
      expect(await sqlstate(rawTx(db.app, (c) => callBegin(c, mintAssertion(user(alice), TEST_ACTOR_KEY, new Date(now.getTime() - 3_600_000)))))).toBe("MV007");
      expect(await sqlstate(rawTx(db.app, (c) => callBegin(c, mintAssertion(user(alice), TEST_ACTOR_KEY, new Date(now.getTime() + 3_600_000)))))).toBe("MV007");
    });
    it("an assertion is single-use: replaying it in a later transaction is rejected", async () => {
      const a = mintAssertion(user(alice), TEST_ACTOR_KEY);
      const c = await db.app.connect();
      try {
        await c.query("BEGIN"); await callBegin(c, a); await c.query("COMMIT");
        await c.query("BEGIN");
        expect(await sqlstate(callBegin(c, a))).toBe("MV007");
      } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
    });
    it("one transaction has one actor: a second begin_actor (even for the same user) is rejected, so the actor cannot be swapped mid-transaction", async () => {
      await rawTx(db.app, async (c) => {
        await callBegin(c, mintAssertion(user(alice), TEST_ACTOR_KEY));
        expect(await sqlstate(callBegin(c, mintAssertion(user(bob), TEST_ACTOR_KEY)))).toBe("MV007");
      });
    });
    it("missing actor context is rejected: no audit, no status event, no invoice, no payment, no idempotency key without a verified actor", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(db.app.query("SELECT movezz_sec.append_audit('x.y','t','1',NULL,NULL)"))).toBe("MV007");
      expect(await sqlstate(db.app.query("SELECT movezz_sec.append_status_event('item',gen_random_uuid(),NULL,'x')"))).toBe("MV007");
      expect(await sqlstate(db.app.query("SELECT movezz_sec.require_actor()"))).toBe("MV007");
      expect(await sqlstate(db.admin.query(`INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, total_ghs) VALUES ('ORD-NOACT',$1,100,12.5,1250)`, [c]))).toBe("MV007");
      expect(await sqlstate(db.app.query(`INSERT INTO idempotency_keys (scope, key) VALUES ('s','${key()}')`))).toBe("MV007");
      expect((await db.app.query("SELECT movezz_sec.current_actor_id() AS id")).rows[0].id).toBeNull();
    });
    it("the service layer fails closed without a signing key, and refuses malformed actors", async () => {
      const saved = process.env.ACTOR_CONTEXT_KEY;
      try {
        delete process.env.ACTOR_CONTEXT_KEY;
        expect(() => actorKeyFromEnv()).toThrow(DomainError);
        process.env.ACTOR_CONTEXT_KEY = Buffer.alloc(8).toString("base64");
        expect(() => actorKeyFromEnv()).toThrow(/at least 32 bytes/);
      } finally { process.env.ACTOR_CONTEXT_KEY = saved; }
      expect(() => mintAssertion({ type: "user" }, TEST_ACTOR_KEY)).toThrow(DomainError);
      expect(() => mintAssertion({ type: "system", userId: alice }, TEST_ACTOR_KEY)).toThrow(DomainError);
      expect(await code(withActorTransaction(db.app, user(alice), async () => 1, randomBytes(32)))).toBe("ACTOR_INVALID");
    });
  });

  describe("runtime-role boundary (direct SQL)", () => {
    it("the runtime role is an ordinary role: no superuser, no bypassRLS, no createrole/createdb, member of no other role", async () => {
      const r = (await db.admin.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
        (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships FROM pg_roles r WHERE rolname='movezz_app'`)).rows[0];
      expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, memberships: 0 });
    });
    it("cannot become another database role or user", async () => {
      expect(await sqlstate(db.app.query("SET ROLE postgres"))).toBe("42501");
      expect(await sqlstate(db.app.query("SET SESSION AUTHORIZATION postgres"))).toBe("42501");
      expect(await sqlstate(db.app.query("SET ROLE movezz_app_nonexistent"))).toMatch(/22023|42704/);
    });
    it("cannot read or change the signing keys or the actor sessions", async () => {
      for (const sql of ["SELECT * FROM movezz_sec.actor_keys", "SELECT * FROM movezz_sec.actor_sessions", "UPDATE movezz_sec.actor_keys SET is_active=false",
        "INSERT INTO movezz_sec.actor_keys (key) VALUES (decode(repeat('ab',32),'hex'))", "DELETE FROM movezz_sec.actor_sessions",
        `INSERT INTO movezz_sec.actor_sessions (txid, jti, actor_type, request_id) VALUES (pg_current_xact_id(), 'forged-jti-forged-jti', 'system', 'r')`]) {
        expect(await sqlstate(db.app.query(sql)), sql).toBe("42501");
      }
    });
    it("cannot call key management, the HMAC primitive, or the trigger-only status writer", async () => {
      for (const sql of ["SELECT movezz_sec.set_actor_key(decode(repeat('ab',32),'hex'))", "SELECT movezz_sec.retire_actor_key(1::smallint)", "SELECT movezz_sec.prune_actor_sessions()",
        "SELECT movezz_sec.hmac_sha256('k'::bytea,'m'::bytea)", "SELECT movezz_sec.assertion_message('system',NULL,'r','j',1)",
        "SELECT movezz_sec.append_status_event_internal('item',gen_random_uuid(),NULL,'x',NULL)",
        "SELECT recompute_invoice_payments(gen_random_uuid())"]) {
        expect(await sqlstate(db.app.query(sql)), sql).toBe("42501");
      }
    });
    it("cannot insert, update, delete or truncate audit_logs or status_events directly", async () => {
      for (const t of ["audit_logs", "status_events"]) {
        const ins = t === "audit_logs" ? "(actor_user_id, actor_type, entity_type, action)" : "(actor_user_id, actor_type, entity_type, new_status)";
        expect(await sqlstate(db.app.query(`INSERT INTO ${t} ${ins} VALUES ('${alice}','user','x','y')`)), `${t} insert`).toBe("42501");
        expect(await sqlstate(db.app.query(`UPDATE ${t} SET actor_user_id = '${bob}'`)), `${t} update`).toBe("42501");
        expect(await sqlstate(db.app.query(`DELETE FROM ${t}`)), `${t} delete`).toBe("42501");
        expect(await sqlstate(db.app.query(`TRUNCATE ${t}`)), `${t} truncate`).toBe("42501");
      }
    });
    it("setting a session variable does not create or change an actor (current_setting is never trusted)", async () => {
      await rawTx(db.app, async (c) => {
        await c.query(`SELECT set_config('app.actor_user_id', '${alice}', true), set_config('movezz.actor', '${alice}', true), set_config('request.jwt.claim.sub', '${alice}', true)`);
        expect((await c.query("SELECT movezz_sec.current_actor_id() AS id")).rows[0].id).toBeNull();
        expect(await sqlstate(c.query("SELECT movezz_sec.append_audit('x.y','t','1',NULL,NULL)"))).toBe("MV007");
      });
    });
    it("cannot disable triggers, create temp tables or objects, or shadow functions to hijack trigger code", async () => {
      expect(await sqlstate(db.app.query("SET session_replication_role = replica"))).toBe("42501");
      expect(await sqlstate(db.app.query("ALTER TABLE audit_logs DISABLE TRIGGER ALL"))).toBe("42501");
      expect(await sqlstate(db.app.query("CREATE TEMP TABLE users (id uuid)"))).toBe("42501");
      expect(await sqlstate(db.app.query("CREATE TABLE public.shadow (id int)"))).toBe("42501");
      expect(await sqlstate(db.app.query("CREATE FUNCTION public.shadow() RETURNS int LANGUAGE sql AS 'SELECT 1'"))).toBe("42501");
      expect(await sqlstate(db.app.query("CREATE SCHEMA evil"))).toBe("42501");
      expect(await sqlstate(db.app.query("CREATE FUNCTION movezz_sec.begin_actor() RETURNS int LANGUAGE sql AS 'SELECT 1'"))).toBe("42501");
    });
    it("a fabricated actor in a hand-written audit/status INSERT is rejected even for the table owner (defence in depth)", async () => {
      await withActorTransaction(db.admin, user(alice), async (tx) => {
        for (const t of ["audit_logs", "status_events"]) {
          const cols = t === "audit_logs" ? "action, entity_type" : "new_status, entity_type";
          await tx.query("SAVEPOINT s");
          expect(await sqlstate(tx.query(`INSERT INTO ${t} (actor_user_id, actor_type, ${cols}) VALUES ($1,'user','a','item')`, [bob])), `${t}: other user`).toBe("MV007");
          await tx.query("ROLLBACK TO s");
          expect(await sqlstate(tx.query(`INSERT INTO ${t} (actor_type, ${cols}) VALUES ('user','a','item')`)), `${t}: user without id`).toBe("MV007");
          await tx.query("ROLLBACK TO s");
          expect(await sqlstate(tx.query(`INSERT INTO ${t} (actor_user_id, actor_type, ${cols}) VALUES ($1,'system','a','item')`, [alice])), `${t}: system with a user id`).toBe("MV007");
          await tx.query("ROLLBACK TO s");
        }
      }, TEST_ACTOR_KEY);
      // and with no actor at all
      expect(await sqlstate(db.admin.query(`INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type) VALUES ($1,'user','a','item')`, [alice]))).toBe("MV007");
      expect(await sqlstate(db.admin.query(`INSERT INTO status_events (actor_user_id, actor_type, new_status, entity_type) VALUES ($1,'user','a','item')`, [alice]))).toBe("MV007");
    });

    it("SECURITY DEFINER inventory: owner, pinned search_path, no PUBLIC execute, runtime execute only on the allow-list", async () => {
      const own = (await db.admin.query("SELECT current_user AS u")).rows[0].u;
      const fns = (await db.admin.query(`
        SELECT p.oid, n.nspname AS schema, p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS cfg, p.prorettype::regtype::text AS ret,
               has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('movezz_app', p.oid, 'EXECUTE') AS app
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prosecdef AND n.nspname IN ('public','movezz_sec') ORDER BY 2,3`)).rows;
      expect(fns.length).toBeGreaterThanOrEqual(12);
      const allow = new Set(["begin_actor", "current_actor_id", "current_actor_type", "require_actor", "append_audit", "append_status_event", "actor_role",
        "actor_customer_id", "actor_context", "is_operator", "actor_owns_entity", "admin_create_user", "admin_set_user_role", "admin_set_user_active",
        "submit_registration", "approve_registration", "reject_registration", "activate_registration",
        // Phase 7H operational functions: each checks the verified actor itself (service identity or super_admin)
        "keepup_claim", "keepup_complete", "keepup_fail", "keepup_ambiguous", "keepup_reap_expired", "keepup_resolve", "keepup_manual_retry",
        "outbox_claim", "outbox_complete", "outbox_fail", "outbox_reap_expired", "outbox_requeue_dead"]);
      const refAlloc = new Set(["allocate_reference", "allocate_container_reference"]); // intentionally runtime-callable (reference numbers; no actor, no data read)
      for (const f of fns) {
        const label = `${f.schema}.${f.name}`;
        expect(f.owner, `${label} owner`).toBe(own);
        const sp = ((f.cfg ?? []) as string[]).find((x) => x.startsWith("search_path="));
        expect(sp, `${label} search_path`).toBeDefined();
        expect(sp, `${label} search_path`).toMatch(/^search_path=pg_catalog, (public, )?pg_temp$|^search_path="?pg_catalog"?, "?pg_temp"?$/);
        expect(f.pub, `${label} PUBLIC execute`).toBe(false);
        // trigger functions cannot be called as functions; for everything else only the allow-list is executable by the runtime role
        if (f.schema === "movezz_sec") expect(f.app, `${label} runtime execute`).toBe(allow.has(f.name));
        else if (f.ret !== "trigger") expect(f.app, `${label} runtime execute`).toBe(refAlloc.has(f.name));
      }
      // nothing in movezz_sec is executable by PUBLIC, definer or not
      const pub = (await db.admin.query(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace='movezz_sec'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')`)).rows;
      expect(pub).toEqual([]);
      // the schema itself is closed to PUBLIC and the tables are owned by the migrator
      expect((await db.admin.query(`SELECT has_schema_privilege('public','movezz_sec','USAGE') AS u`)).rows[0].u).toBe(false);
      expect((await db.admin.query(`SELECT DISTINCT pg_get_userbyid(relowner) AS o FROM pg_class WHERE relnamespace='movezz_sec'::regnamespace AND relkind='r'`)).rows).toEqual([{ o: own }]);
    });
    it("the accessor/writer functions take no actor argument, so there is nothing to spoof", async () => {
      const r = (await db.admin.query(`SELECT proname, array_to_string(proargnames, ',') AS n FROM pg_proc WHERE pronamespace='movezz_sec'::regnamespace AND proname IN ('append_audit','append_status_event','current_actor_id','require_actor')`)).rows;
      for (const f of r) expect(f.n ?? "", f.proname).not.toMatch(/actor|user_id|role/);
    });
  });

  describe("audit records carry the real actor", () => {
    let c: string; let inv: { id: string };
    beforeAll(async () => {
      await fxRate(db.admin); c = await customer(db.admin);
      const i = await item(db.admin, c);
      inv = (await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(alice, "req-alice-1"), request: { ip: "203.0.113.7", userAgent: "vitest" }, idempotencyKey: key() })).invoice;
    });
    it("createInvoice attributes audit, status events, created_by and the idempotency key to the verified actor", async () => {
      const a = (await db.admin.query("SELECT actor_user_id, actor_type, request_id, host(ip_address) AS ip FROM audit_logs WHERE entity_id=$1", [inv.id])).rows;
      expect(a).toEqual([{ actor_user_id: alice, actor_type: "user", request_id: "req-alice-1", ip: "203.0.113.7" }]);
      const s = (await db.admin.query("SELECT DISTINCT actor_user_id, actor_type FROM status_events WHERE entity_type='invoice' AND entity_id=$1", [inv.id])).rows;
      expect(s).toEqual([{ actor_user_id: alice, actor_type: "user" }]);
      expect((await db.admin.query("SELECT created_by FROM invoices WHERE id=$1", [inv.id])).rows[0].created_by).toBe(alice);
      expect((await db.admin.query("SELECT DISTINCT actor_user_id FROM idempotency_keys WHERE result_entity_id=$1", [inv.id])).rows).toEqual([{ actor_user_id: alice }]);
    });
    it("a payment, a void and a cancellation are each attributed to the user who did them, and created_by cannot be passed in", async () => {
      const i = await item(db.admin, c);
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(alice), idempotencyKey: key() });
      const { payment } = await recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "10.00", actor: user(bob), idempotencyKey: key() });
      expect((await db.admin.query("SELECT created_by FROM payments WHERE id=$1", [payment.id])).rows[0].created_by).toBe(bob);
      await voidPayment(db.app, { paymentId: payment.id, reason: "entered twice", actor: user(alice) });
      expect((await db.admin.query("SELECT voided_by FROM payments WHERE id=$1", [payment.id])).rows[0].voided_by).toBe(alice);
      const ev = (await db.admin.query("SELECT action, actor_user_id FROM audit_logs WHERE entity_id = ANY($1) ORDER BY id", [[payment.id, invoice.id]])).rows;
      expect(ev).toEqual(expect.arrayContaining([{ action: "payment.create", actor_user_id: bob }, { action: "payment.void", actor_user_id: alice }]));
      const j = await item(db.admin, c);
      const other = (await createInvoice(db.app, { customerId: c, itemIds: [j], actor: user(alice), idempotencyKey: key() })).invoice;
      await cancelInvoice(db.app, { invoiceId: other.id, reason: "customer asked", actor: user(bob) });
      expect((await db.admin.query("SELECT cancelled_by, created_by FROM invoices WHERE id=$1", [other.id])).rows[0]).toEqual({ cancelled_by: bob, created_by: alice });
      expect((await db.admin.query("SELECT actor_user_id FROM status_events WHERE entity_id=$1 AND new_status='Cancelled'", [other.id])).rows).toEqual([{ actor_user_id: bob }]);
    });
    it("the payment that settles an invoice records the invoice status change under the actor who paid", async () => {
      const i = await item(db.admin, c);
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(alice), idempotencyKey: key() });
      await recordPayment(db.app, { invoiceId: invoice.id, amountGhs: String(invoice.total_ghs), actor: user(bob), idempotencyKey: key() });
      expect((await db.admin.query("SELECT new_status, actor_user_id, actor_type FROM status_events WHERE entity_type='invoice' AND entity_id=$1 ORDER BY id", [invoice.id])).rows)
        .toEqual([{ new_status: "Pending", actor_user_id: alice, actor_type: "user" }, { new_status: "Paid", actor_user_id: bob, actor_type: "user" }]);
    });
    it("a hand-supplied created_by / voided_by / cancelled_by that is not the verified actor is rejected", async () => {
      const i = await item(db.admin, c);
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(alice), idempotencyKey: key() });
      const asAlice = actorQuery(db.admin, user(alice));
      expect(await sqlstate(asAlice.query(`INSERT INTO payments (invoice_id, amount_ghs, created_by) VALUES ($1, 1, $2)`, [invoice.id, bob]))).toBe("MV007");
      expect(await sqlstate(asAlice.query(`INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, total_ghs, created_by) VALUES ('ORD-SPOOF',$1,100,12.5,1250,$2)`, [c, bob]))).toBe("MV007");
      expect(await sqlstate(asAlice.query(`UPDATE invoices SET status='Cancelled', cancelled_at=now(), cancel_reason='x', cancelled_by=$2 WHERE id=$1`, [invoice.id, bob]))).toBe("MV007");
    });
    it("pricing an item is audited with the actor", async () => {
      const i = await item(db.admin, c, { package_tier: null, tier_rate_usd: null, tier_price_usd: null });
      await withActorTransaction(db.app, user(bob), (tx) => priceItem(tx, i));
      expect((await db.admin.query("SELECT actor_user_id, action FROM audit_logs WHERE entity_id=$1", [i])).rows).toEqual([{ actor_user_id: bob, action: "item.price" }]);
    });
    it("audit and status rows cannot be changed or removed afterwards: the actor cannot be rewritten, even by the owner", async () => {
      for (const t of ["audit_logs", "status_events"]) {
        expect(await sqlstate(db.admin.query(`UPDATE ${t} SET actor_user_id = $1`, [bob])), `${t} update`).toBe("MV004");
        expect(await sqlstate(db.admin.query(`DELETE FROM ${t}`)), `${t} delete`).toBe("MV004");
        expect(await sqlstate(db.admin.query(`TRUNCATE ${t}`)), `${t} truncate`).toBe("MV004");
        expect(await sqlstate(db.app.query(`UPDATE ${t} SET actor_user_id = $1`, [bob])), `${t} update (runtime)`).toBe("42501");
        expect(await sqlstate(db.app.query(`DELETE FROM ${t}`)), `${t} delete (runtime)`).toBe("42501");
      }
    });
    it("a status event written through the service has the real actor, and an explicit status event is attributed to the caller only", async () => {
      const i = await item(db.admin, c);
      await withActorTransaction(db.app, user(warehouse), (tx) => recordStatusEvent(tx, { entityType: "item", entityId: i, from: null, to: "Arrived at Transit Warehouse", reason: "scan", metadata: { dock: 3 } }));
      expect((await db.admin.query("SELECT actor_user_id, actor_type, reason FROM status_events WHERE entity_id=$1", [i])).rows).toEqual([{ actor_user_id: warehouse, actor_type: "user", reason: "scan" }]);
    });
    it("service actors (system / import) are recorded as such, with no user id", async () => {
      const i = await item(db.admin, c);
      for (const t of ["system", "import", "integration"] as const) {
        await withActorTransaction(db.app, { type: t }, async (tx) => {
          // the integration identity may only record keepup/notification history (Phase 7H); system/import may record any
          const entityType = t === "integration" ? "keepup_sync" : "item";
          await recordAudit(tx, { action: t === "integration" ? "keepup.heartbeat" : `svc.${t}`, entityType, entityId: i });
          await recordStatusEvent(tx, { entityType, entityId: i, from: null, to: `via ${t}` });
          expect(await currentActorId(tx)).toBeNull();
        });
      }
      expect((await db.admin.query("SELECT actor_type, actor_user_id FROM audit_logs WHERE entity_id=$1 ORDER BY id", [i])).rows)
        .toEqual([{ actor_type: "system", actor_user_id: null }, { actor_type: "import", actor_user_id: null }, { actor_type: "integration", actor_user_id: null }]);
    });
  });

  describe("no secrets in audit metadata", () => {
    it("credentials, tokens and the actor assertion itself never reach audit/status rows", async () => {
      const a = mintAssertion(user(alice, "req-secret-check"), TEST_ACTOR_KEY);
      const c = await db.app.connect();
      try {
        await c.query("BEGIN"); await callBegin(c, a);
        await recordAudit(c, {
          action: "secret.check", entityType: "user", entityId: "s1",
          before: { password: "hunter2", Authorization: "Bearer abc", cookie: "sid=xyz", ok: 1 },
          after: { idToken: "eyJhbGciOi", nested: { apiKey: "k-1", client_secret: "cs", sessionToken: "st" }, list: [{ refresh_token: "rt" }] },
        });
        await c.query("COMMIT");
      } finally { c.release(); }
      const dump = JSON.stringify((await db.admin.query("SELECT * FROM audit_logs WHERE entity_id='s1'")).rows);
      expect(dump).not.toMatch(/hunter2|Bearer abc|sid=xyz|eyJhbGciOi|k-1|"cs"|"st"|"rt"/);
      expect(dump).toContain("[REDACTED]");
      // the signature, jti and the signing key are not stored in any history table (they live only in the private schema)
      const hist = JSON.stringify((await db.admin.query("SELECT to_jsonb(a) FROM audit_logs a")).rows) + JSON.stringify((await db.admin.query("SELECT to_jsonb(s) FROM status_events s")).rows);
      expect(hist).not.toContain(a.sig); expect(hist).not.toContain(a.jti); expect(hist).not.toContain(TEST_ACTOR_KEY.toString("hex"));
    });
    it("business audit records (invoice create) contain no secret-looking keys", async () => {
      await fxRate(db.admin); const c = await customer(db.admin); const i = await item(db.admin, c);
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(alice), idempotencyKey: key() });
      const row = (await db.admin.query("SELECT before_data, after_data, user_agent FROM audit_logs WHERE entity_id=$1", [invoice.id])).rows[0];
      expect(JSON.stringify(row)).not.toMatch(/password|token|secret|authorization|cookie|api[_-]?key|signature|jti/i);
    });
  });

  describe("transactions", () => {
    const counts = async (entityId?: string) => ({
      audit: (await db.admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE ($1::text IS NULL OR entity_id=$1)", [entityId ?? null])).rows[0].n as number,
      status: (await db.admin.query("SELECT count(*)::int AS n FROM status_events WHERE ($1::uuid IS NULL OR entity_id=$1)", [entityId ?? null])).rows[0].n as number,
    });
    it("a successful mutation commits business rows, audit and status events together", async () => {
      await fxRate(db.admin); const c = await customer(db.admin); const i = await item(db.admin, c);
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(alice), idempotencyKey: key() });
      expect((await counts(invoice.id)).audit).toBe(1);
      expect((await counts(invoice.id)).status).toBe(1);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM invoices WHERE id=$1", [invoice.id])).rows[0].n).toBe(1);
    });
    it("a failed mutation (overpayment) leaves no payment, no audit and no status event", async () => {
      await fxRate(db.admin); const c = await customer(db.admin); const i = await item(db.admin, c);
      const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(alice), idempotencyKey: key() });
      const before = { all: await counts(), mine: await counts(invoice.id) };
      expect(await code(recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "999999.00", actor: user(bob), idempotencyKey: key() }))).toBe("OVERPAYMENT");
      expect(await counts()).toEqual(before.all);
      expect(await counts(invoice.id)).toEqual(before.mine);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoice.id])).rows[0].n).toBe(0);
    });
    it("a rollback after writing audit and status removes both (and the business change)", async () => {
      const c = await customer(db.admin); const i = await item(db.admin, c);
      const before = await counts();
      const err = await withActorTransaction(db.app, user(alice), async (tx) => {
        await recordAudit(tx, { action: "will.rollback", entityType: "item", entityId: i });
        await recordStatusEvent(tx, { entityType: "item", entityId: i, from: null, to: "Sorting" });
        await tx.query("UPDATE items SET description='changed in rolled back tx' WHERE id=$1", [i]);
        throw new Error("boom");
      }).catch((e) => e as Error);
      expect(err.message).toBe("boom");
      expect(await counts()).toEqual(before);
      expect((await db.admin.query("SELECT description FROM items WHERE id=$1", [i])).rows[0].description).not.toBe("changed in rolled back tx");
    });
    it("the actor is gone as soon as the transaction ends (commit or rollback): it cannot be reused for later statements", async () => {
      const c = await db.app.connect();
      try {
        await c.query("BEGIN"); await callBegin(c, mintAssertion(user(alice), TEST_ACTOR_KEY)); await c.query("COMMIT");
        expect((await c.query("SELECT movezz_sec.current_actor_id() AS id")).rows[0].id).toBeNull();
        expect(await sqlstate(c.query("SELECT movezz_sec.append_audit('late.write','t','1',NULL,NULL)"))).toBe("MV007");
        await c.query("BEGIN"); await callBegin(c, mintAssertion(user(bob), TEST_ACTOR_KEY)); await c.query("ROLLBACK");
        expect((await c.query("SELECT movezz_sec.current_actor_id() AS id")).rows[0].id).toBeNull();
      } finally { c.release(); }
    });
    it("a transaction that never wrote anything before begin_actor still gets the right actor (xid assigned lazily)", async () => {
      expect(await withActorTransaction(db.app, user(bob), async (tx) => currentActorId(tx))).toBe(bob);
    });
  });

  describe("concurrency and pooling", () => {
    it("parallel mutations by different users keep separate identities", async () => {
      await fxRate(db.admin);
      const work = Array.from({ length: 24 }, async (_, n) => {
        const who = n % 2 ? alice : bob;
        const c = await customer(db.admin); const i = await item(db.admin, c);
        const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(who), idempotencyKey: key() });
        return { id: invoice.id as string, who };
      });
      const done = await Promise.all(work);
      for (const d of done) {
        expect((await db.admin.query("SELECT created_by FROM invoices WHERE id=$1", [d.id])).rows[0].created_by, "created_by").toBe(d.who);
        expect((await db.admin.query("SELECT DISTINCT actor_user_id FROM audit_logs WHERE entity_id=$1", [d.id])).rows, "audit").toEqual([{ actor_user_id: d.who }]);
        expect((await db.admin.query("SELECT DISTINCT actor_user_id FROM status_events WHERE entity_id=$1", [d.id])).rows, "status").toEqual([{ actor_user_id: d.who }]);
      }
    });
    it("two open transactions on different connections interleave without overwriting each other's identity", async () => {
      const [ca, cb] = [await db.app.connect(), await db.app.connect()];
      try {
        await ca.query("BEGIN"); await cb.query("BEGIN");
        await callBegin(ca, mintAssertion(user(alice), TEST_ACTOR_KEY));
        await callBegin(cb, mintAssertion(user(bob), TEST_ACTOR_KEY));
        await recordAudit(ca, { action: "interleave.a", entityType: "t", entityId: "ia" });
        await recordAudit(cb, { action: "interleave.b", entityType: "t", entityId: "ib" });
        await recordAudit(ca, { action: "interleave.a2", entityType: "t", entityId: "ia" });
        expect((await ca.query("SELECT movezz_sec.current_actor_id() AS id")).rows[0].id).toBe(alice);
        expect((await cb.query("SELECT movezz_sec.current_actor_id() AS id")).rows[0].id).toBe(bob);
        await cb.query("COMMIT"); await ca.query("COMMIT");
      } finally { ca.release(); cb.release(); }
      expect((await db.admin.query("SELECT entity_id, actor_user_id FROM audit_logs WHERE entity_id IN ('ia','ib') ORDER BY id")).rows)
        .toEqual([{ entity_id: "ia", actor_user_id: alice }, { entity_id: "ib", actor_user_id: bob }, { entity_id: "ia", actor_user_id: alice }]);
    });
    it("a pooled connection never carries an actor into the next request (single-connection pool)", async () => {
      const pool = new pg.Pool({ connectionString: db.appUrl, max: 1 });
      pool.on("error", () => {});
      try {
        const pid = async () => (await pool.query("SELECT pg_backend_pid() AS p")).rows[0].p;
        const p0 = await pid();
        await withActorTransaction(pool, user(alice), async (tx) => { await recordAudit(tx, { action: "pool.a", entityType: "t", entityId: "pa" }); });
        // the very same backend serves the next call: it has NO actor
        expect(await pid()).toBe(p0);
        expect((await pool.query("SELECT movezz_sec.current_actor_id() AS id")).rows[0].id).toBeNull();
        { // (a client is used here: pool.query() destroys the connection on error, which would hide a leak)
          const cl = await pool.connect();
          try { expect(await sqlstate(cl.query("SELECT movezz_sec.append_audit('pool.leak','t','pl',NULL,NULL)"))).toBe("MV007"); } finally { cl.release(); }
        }
        expect(await pid()).toBe(p0);
        // a failed request does not leak either
        await withActorTransaction(pool, user(alice), async () => { throw new Error("x"); }).catch(() => {});
        expect((await pool.query("SELECT movezz_sec.current_actor_id() AS id")).rows[0].id).toBeNull();
        // and the next actor on the same backend is exactly the next actor
        await withActorTransaction(pool, user(bob), async (tx) => { await recordAudit(tx, { action: "pool.b", entityType: "t", entityId: "pb" }); });
        expect(await pid()).toBe(p0);
      } finally { await pool.end(); }
      expect((await db.admin.query("SELECT entity_id, actor_user_id FROM audit_logs WHERE entity_id IN ('pa','pb','pl') ORDER BY id")).rows)
        .toEqual([{ entity_id: "pa", actor_user_id: alice }, { entity_id: "pb", actor_user_id: bob }]);
    });
    it("racing the same assertion on many connections lets exactly one transaction use it", async () => {
      const a = mintAssertion(user(alice), TEST_ACTOR_KEY);
      const results = await Promise.all(Array.from({ length: 10 }, async () => {
        const c = await db.app.connect();
        try { await c.query("BEGIN"); await callBegin(c, a); await c.query("COMMIT"); return "OK"; }
        catch (e) { return (e as { code?: string }).code ?? "ERR"; }
        finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
      }));
      expect(results.filter((r) => r === "OK")).toHaveLength(1);
      expect(results.filter((r) => r === "MV007")).toHaveLength(9);
    });
  });
});

dbDescribe("actor keys: rotation and fail-closed behaviour (PostgreSQL)", () => {
  let db: TestDb; let alice: string;
  beforeAll(async () => { db = await createTestDb(); alice = await staffUser(db.admin); });
  afterAll(async () => { await db?.close(); });
  const tryBegin = (k: Buffer) => sqlstate(rawTx(db.app, (c) => callBegin(c, mintAssertion(user(alice), k))));
  const activeIds = async () => (await db.admin.query("SELECT id FROM movezz_sec.actor_keys WHERE is_active ORDER BY id")).rows.map((r) => r.id as number);

  it("key management rejects short keys; rotation accepts both keys until the old one is retired", async () => {
    expect(await sqlstate(db.admin.query("SELECT movezz_sec.set_actor_key(decode('abcd','hex'))"))).toBeTruthy();
    const k2 = randomBytes(32);
    expect(await tryBegin(k2)).toBe("MV007");
    const id2 = (await db.admin.query("SELECT movezz_sec.set_actor_key($1) AS id", [k2])).rows[0].id;
    expect(await tryBegin(k2)).toBe("OK");
    expect(await tryBegin(TEST_ACTOR_KEY)).toBe("OK");        // old key still valid during the rotation window
    const [old] = await activeIds();
    await db.admin.query("SELECT movezz_sec.retire_actor_key($1)", [old]);
    expect(await tryBegin(TEST_ACTOR_KEY)).toBe("MV007");     // retired key no longer verifies
    expect(await tryBegin(k2)).toBe("OK");
    expect(await activeIds()).toEqual([id2]);
  });
  it("with no active key every actor is refused (fail closed), and the error does not reveal which part failed", async () => {
    for (const id of await activeIds()) await db.admin.query("SELECT movezz_sec.retire_actor_key($1)", [id]);
    const e = await rawTx(db.app, (c) => callBegin(c, mintAssertion(user(alice), TEST_ACTOR_KEY))).catch((x) => x as Error & { code?: string });
    expect((e as { code?: string }).code).toBe("MV007");
    expect(String((e as Error).message)).not.toMatch(/[0-9a-f]{64}/);
  });
  it("expired session rows can be pruned by the owner only", async () => {
    await db.admin.query("SELECT movezz_sec.set_actor_key($1)", [TEST_ACTOR_KEY]);
    await withActorTransaction(db.admin, user(alice), async () => 1, TEST_ACTOR_KEY);
    await db.admin.query("UPDATE movezz_sec.actor_sessions SET created_at = now() - interval '30 days'");
    expect(Number((await db.admin.query("SELECT movezz_sec.prune_actor_sessions(interval '7 days') AS n")).rows[0].n)).toBeGreaterThan(0);
    expect(await sqlstate(db.app.query("SELECT movezz_sec.prune_actor_sessions()"))).toBe("42501");
  });
});

dbDescribe("migration 0010 upgrade (PostgreSQL)", () => {
  it("applies on an empty database and is recorded; the status runner sees every migration applied", async () => {
    const bare = await createBareTestDb();
    try {
      const r = await migrate(bare.url);
      expect(r.applied).toContain("0010_trusted_actor_context.sql");
      expect((await migrate(bare.url)).applied).toEqual([]);
      expect((await bare.admin.query("SELECT to_regclass('movezz_sec.actor_keys') IS NOT NULL AS ok")).rows[0].ok).toBe(true);
    } finally { await bare.close(); }
  });
});
