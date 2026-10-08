// Phase 7F: authorization, RBAC, customer ownership and account-state enforcement.
// Every security-critical case runs against real PostgreSQL through the RUNTIME role (movezz_app) with real trusted actors:
// the owner/superuser pool is used only to build fixtures, because it is an "operator" path that the guards deliberately skip.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  dbDescribe, createTestDb, customer, item, carton, pricedItem, staffUser, fxRate, packageRates, specialRate, sqlstate, TEST_ACTOR_KEY,
  type TestDb,
} from "./helpers";
import { createInvoice, recordPayment, voidPayment, cancelInvoice } from "../../src/lib/db/invoices";
import { priceItem } from "../../src/lib/db/pricing";
import { user, mintAssertion, beginActor, withActorTransaction, type ActorAssertion } from "../../src/lib/db/actor";
import { isAllowed, POLICY, SERVICE_OPERATIONS, authorize, type ActorContext, type Operation, type Role } from "../../src/lib/db/authz";
import * as repo from "../../src/lib/db/ownership";
import { DomainError } from "../../src/lib/db/errors";

let kn = 0;
const key = () => `az-${Date.now()}-${++kn}-abcdefgh`;
const code = async (p: Promise<unknown>) => {
  try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : ((e as { code?: string }).code ?? `RAW:${(e as Error).message}`); }
};
const NIL = "00000000-0000-4000-8000-000000000000";

dbDescribe("authorization, ownership and account state (PostgreSQL)", () => {
  let db: TestDb;
  let admin: string, admin2: string, staff: string, staff2: string;
  let custA: string, custB: string, loginA: string, loginB: string;           // customers and their logins
  let itemA: string, itemB: string, refB: string, cartonA: string, cartonB: string, invA: string, invB: string, payA: string, payB: string;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  /** run fn as a verified actor through the runtime role; raw pg errors keep their SQLSTATE, mapped ones become DomainError codes */
  const as = <T>(a: string | ActorAssertion, fn: (tx: pg.PoolClient) => Promise<T>) => withActorTransaction(db.app, typeof a === "string" ? user(a) : a, fn);
  const login = async (c: string, tag: string) =>
    (await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ($1,$2,'customer',$3) RETURNING id`, [`uid-${tag}-${++kn}`, `${tag}${kn}@example.invalid`, c]))[0].id as string;

  beforeAll(async () => {
    db = await createTestDb();
    admin = await staffUser(db.admin, "super_admin"); admin2 = await staffUser(db.admin, "super_admin");
    staff = await staffUser(db.admin, "warehouse_staff"); staff2 = await staffUser(db.admin, "warehouse_staff");
    await packageRates(db.admin, "basic", "350", "8"); await fxRate(db.admin, "12.50000000");
    await q("INSERT INTO warehouses (name) VALUES ('Main')");
    custA = await customer(db.admin, { name: "Alpha", mark: "MOVEZZ-ALPHA" }); custB = await customer(db.admin, { name: "Bravo", mark: "MOVEZZ-BRAVO" });
    loginA = await login(custA, "a"); loginB = await login(custB, "b");
    itemA = await pricedItem(db.admin, custA, "100.00"); itemB = await pricedItem(db.admin, custB, "100.00");
    refB = (await q("SELECT item_ref FROM items WHERE id=$1", [itemB]))[0].item_ref;
    cartonA = await carton(db.admin, custA, { price_usd: "175.00" }); cartonB = await carton(db.admin, custB, { price_usd: "175.00" });
    const mk = (c: string, i: string) => createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(admin), idempotencyKey: key() }).then((r) => r.invoice.id as string);
    invA = await mk(custA, itemA); invB = await mk(custB, itemB);
    const pay = (inv: string) => recordPayment(db.app, { invoiceId: inv, amountGhs: "10.00", actor: user(admin), idempotencyKey: key() }).then((r) => r.payment.id as string);
    payA = await pay(invA); payB = await pay(invB);
    await q("INSERT INTO status_events (entity_type, entity_id, old_status, new_status, actor_type) VALUES ('item',$1,NULL,'Arrived at Transit Warehouse','system'), ('item',$2,NULL,'Arrived at Transit Warehouse','system')", [itemA, itemB]);
  });
  afterAll(async () => { await db?.close(); });

  describe("the policy matrix (real function, every role x operation)", () => {
    const ctx = (role: Role | null, over: Partial<ActorContext> = {}): ActorContext => ({ type: "user", userId: "u", role, customerId: role === "customer" ? "c" : null, ...over });
    it("allows exactly what POLICY lists, for each role", () => {
      for (const op of Object.keys(POLICY) as Operation[]) {
        for (const role of ["super_admin", "warehouse_staff", "customer"] as Role[]) {
          expect(isAllowed(ctx(role), op), `${role} ${op}`).toBe((POLICY[op] as readonly Role[]).includes(role));
        }
      }
    });
    it("final matrix: staff have no financial, rate, FX, user, customer-identity, warehouse or supplier authority; customers only their own/self operations", () => {
      const staffDenied: Operation[] = ["invoice.create", "invoice.discount", "invoice.cancel", "payment.create", "payment.void", "report.financial", "keepup.sync.manual",
        "rates.admin", "warehouse.admin", "supplier.admin", "user.admin", "customer.admin", "invoice.read.any", "customer.update_self"];
      for (const op of staffDenied) expect(isAllowed(ctx("warehouse_staff"), op), op).toBe(false);
      for (const op of ["item.price", "item.read.any", "carton.read.any", "customer.read.any"] as Operation[]) expect(isAllowed(ctx("warehouse_staff"), op), op).toBe(true);
      const adminOnly = Object.keys(POLICY).filter((o) => (POLICY[o as Operation] as readonly Role[]).includes("super_admin"));
      expect(adminOnly.length).toBe(Object.keys(POLICY).filter((o) => !["item.read.own", "carton.read.own", "invoice.read.own", "customer.update_self"].includes(o)).length);
      for (const op of Object.keys(POLICY) as Operation[]) {
        if (!["item.read.own", "carton.read.own", "invoice.read.own", "customer.update_self"].includes(op)) expect(isAllowed(ctx("customer"), op), `customer ${op}`).toBe(false);
      }
    });
    it("fails closed: a customer without a customer link, an unknown role, and service identities get nothing they were not given", () => {
      expect(isAllowed(ctx("customer", { customerId: null }), "item.read.own")).toBe(false);
      expect(isAllowed(ctx(null), "item.read.any")).toBe(false);
      expect(isAllowed(ctx("super_admin", { type: "import", userId: null, role: null }), "invoice.create")).toBe(false);
      expect(isAllowed(ctx(null, { type: "system", userId: null }), "rates.admin")).toBe(false);
      expect(isAllowed(ctx(null, { type: "integration", userId: null }), "keepup.sync.manual")).toBe(SERVICE_OPERATIONS.integration!.includes("keepup.sync.manual"));
      expect(isAllowed(ctx("super_admin"), "not.an.operation" as Operation)).toBe(false);
    });
    it("authorize() reads the role from the database session, not from the caller", async () => {
      expect(await code(as(staff, (tx) => authorize(tx, "payment.create")))).toBe("NOT_AUTHORIZED");
      expect(await code(as(admin, (tx) => authorize(tx, "payment.create")))).toBe("OK");
      expect(await code(db.app.connect().then(async (c) => { try { return await authorize(c, "payment.create"); } finally { c.release(); } }))).toBe("ACTOR_INVALID");   // no actor at all
    });
  });

  describe("role escalation and user administration", () => {
    it("no user column except last_login_at is writable through the runtime role, for any actor", async () => {
      for (const who of [loginA, staff, admin]) {
        for (const sql of [`UPDATE users SET role='super_admin' WHERE id='${staff}'`, `UPDATE users SET role='super_admin' WHERE id='${who}'`, `UPDATE users SET is_active=true WHERE id='${who}'`,
          `UPDATE users SET customer_id='${custB}' WHERE id='${loginA}'`, `UPDATE users SET auth_uid='hijack' WHERE id='${admin}'`, `UPDATE users SET email='x@example.invalid' WHERE id='${who}'`,
          `INSERT INTO users (auth_uid,email,role) VALUES ('evil','evil@example.invalid','super_admin')`, `DELETE FROM users WHERE id='${staff}'`]) {
          expect(await sqlstate(as(who, (tx) => tx.query(sql))), `${who === admin ? "admin" : who === staff ? "staff" : "customer"}: ${sql}`).toBe("42501");
        }
      }
    });
    it("customer -> staff/admin, staff -> admin, self-role change and self-reactivation through the admin functions are all refused", async () => {
      const fn = (who: string, sql: string, p: unknown[] = []) => code(as(who, (tx) => tx.query(sql, p)));
      expect(await fn(loginA, "SELECT movezz_sec.admin_set_user_role($1,'warehouse_staff',NULL)", [loginA])).toBe("NOT_AUTHORIZED");
      expect(await fn(loginA, "SELECT movezz_sec.admin_set_user_role($1,'warehouse_staff',NULL)", [staff])).toBe("NOT_AUTHORIZED");
      expect(await fn(staff, "SELECT movezz_sec.admin_set_user_role($1,'warehouse_staff',NULL)", [staff])).toBe("NOT_AUTHORIZED");
      expect(await fn(staff, "SELECT movezz_sec.admin_set_user_role($1,'customer',$2)", [staff2, custA])).toBe("NOT_AUTHORIZED");
      expect(await fn(staff, "SELECT movezz_sec.admin_set_user_active($1,true,'x')", [staff2])).toBe("NOT_AUTHORIZED");
      expect(await fn(staff, "SELECT movezz_sec.admin_create_user('u','u@example.invalid','U','warehouse_staff',NULL)")).toBe("NOT_AUTHORIZED");
      // even a super_admin: nobody promotes to super_admin here, touches another super_admin, or changes their own account
      expect(await fn(admin, "SELECT movezz_sec.admin_set_user_role($1,'super_admin',NULL)", [staff])).toBe("NOT_AUTHORIZED");
      expect(await fn(admin, "SELECT movezz_sec.admin_create_user('u','u@example.invalid','U','super_admin',NULL)")).toBe("NOT_AUTHORIZED");
      expect(await fn(admin, "SELECT movezz_sec.admin_set_user_role($1,'warehouse_staff',NULL)", [admin])).toBe("NOT_AUTHORIZED");
      expect(await fn(admin, "SELECT movezz_sec.admin_set_user_role($1,'warehouse_staff',NULL)", [admin2])).toBe("NOT_AUTHORIZED");
      expect(await fn(admin, "SELECT movezz_sec.admin_set_user_active($1,false,'x')", [admin])).toBe("NOT_AUTHORIZED");
      expect(await fn(admin, "SELECT movezz_sec.admin_set_user_active($1,false,'x')", [admin2])).toBe("NOT_AUTHORIZED");
      expect((await q("SELECT role, is_active FROM users WHERE id = ANY($1) ORDER BY id", [[admin, admin2]])).every((r) => r.role === "super_admin" && r.is_active)).toBe(true);
      expect((await q("SELECT role FROM users WHERE id=$1", [loginA]))[0].role).toBe("customer");
    });
    it("a super_admin administers staff and customer logins: create, re-role (with customer link), deactivate, reactivate - all audited with the actor", async () => {
      const id = (await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_create_user('uid-new','newstaff@example.invalid','New Staff','warehouse_staff',NULL) AS id"))).rows[0].id as string;
      expect(await q("SELECT role, customer_id, is_active FROM users WHERE id=$1", [id])).toEqual([{ role: "warehouse_staff", customer_id: null, is_active: true }]);
      expect(await code(as(admin, (tx) => tx.query("SELECT movezz_sec.admin_create_user('uid-bad','bad@example.invalid','B','customer',NULL)")))).toBe("INVALID_INPUT");     // customer login needs a customer
      expect(await code(as(admin, (tx) => tx.query("SELECT movezz_sec.admin_create_user('uid-bad2','bad2@example.invalid','B','warehouse_staff',$1)", [custB])))).toBe("INVALID_INPUT");
      const spare = await customer(db.admin);
      await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_role($1,'customer',$2)", [id, spare]));
      expect((await q("SELECT role, customer_id FROM users WHERE id=$1", [id]))[0]).toEqual({ role: "customer", customer_id: spare });
      await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_active($1,false,'left the company')", [id]));
      expect((await q("SELECT is_active, deactivated_at IS NOT NULL AS d FROM users WHERE id=$1", [id]))[0]).toEqual({ is_active: false, d: true });
      await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_active($1,true,NULL)", [id]));
      expect((await q("SELECT is_active FROM users WHERE id=$1", [id]))[0].is_active).toBe(true);
      const a = await q("SELECT action, actor_user_id, actor_type FROM audit_logs WHERE entity_id=$1 ORDER BY id", [id]);
      expect(a.map((r) => r.action)).toEqual(["user.create", "user.role_change", "user.deactivate", "user.activate"]);
      expect(a.every((r) => r.actor_user_id === admin && r.actor_type === "user")).toBe(true);
      expect((await q("SELECT before_data, after_data FROM audit_logs WHERE entity_id=$1 AND action='user.role_change'", [id]))[0]).toMatchObject({ before_data: { role: "warehouse_staff" }, after_data: { role: "customer", customer_id: spare } });
    });
    it("a customer login cannot be re-linked to an inactive/archived customer, and reactivating a login of an inactive customer is refused", async () => {
      const dead = await customer(db.admin); await q("UPDATE customers SET status='inactive' WHERE id=$1", [dead]);
      const id = (await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_create_user('uid-x','x1@example.invalid','X','warehouse_staff',NULL) AS id"))).rows[0].id as string;
      expect(await code(as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_role($1,'customer',$2)", [id, dead])))).toBe("INVALID_INPUT");
      const rc = await customer(db.admin); const l = await login(rc, "re"); await q("UPDATE customers SET status='inactive' WHERE id=$1", [rc]);
      expect((await q("SELECT is_active FROM users WHERE id=$1", [l]))[0].is_active).toBe(false);           // deactivation propagated
      expect(await code(as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_active($1,true,NULL)", [l])))).toBe("INVALID_STATE");
    });
    it("the last active super_admin can never be deactivated, demoted or deleted - not even by the owner; with a second one it is possible", async () => {
      const f = await createTestDb();
      try {
        const only = await staffUser(f.admin, "super_admin");
        for (const sql of [`UPDATE users SET is_active=false, deactivated_at=now() WHERE id='${only}'`, `UPDATE users SET role='warehouse_staff' WHERE id='${only}'`, `DELETE FROM users WHERE id='${only}'`]) {
          expect(await sqlstate(f.admin.query(sql)), sql).toBe("MV005");
        }
        expect(await sqlstate(f.admin.query(`UPDATE users SET auth_uid='other' WHERE id='${only}'`))).toBe("MV004");   // identity is immutable
        const second = await staffUser(f.admin, "super_admin");
        expect(await sqlstate(f.admin.query(`UPDATE users SET is_active=false, deactivated_at=now() WHERE id='${second}'`))).toBe("OK");
        expect(await sqlstate(f.admin.query(`UPDATE users SET is_active=false, deactivated_at=now() WHERE id='${only}'`))).toBe("MV005");   // second is inactive: `only` is the last again
      } finally { await f.close(); }
    });
  });

  describe("rates, FX, warehouses, suppliers: super_admin only (runtime role, real triggers)", () => {
    const writes = (card: string) => [
      "INSERT INTO package_rates (tier, freight_type, rate_usd, is_active) VALUES ('enterprise','sea',99,false)",
      "UPDATE package_rates SET rate_usd = 1 WHERE tier='basic'",
      "UPDATE package_rates SET effective_to = now() WHERE tier='basic'",
      "UPDATE package_rates SET is_active = false WHERE tier='basic'",
      "DELETE FROM package_rates WHERE tier='basic'",
      "INSERT INTO special_rates (name, sea_rate_usd) VALUES ('rogue', 1)",
      `UPDATE special_rates SET sea_rate_usd = 1 WHERE id='${card}'`,
      `UPDATE special_rates SET customer_id = '${custA}' WHERE id='${card}'`,
      `UPDATE special_rates SET effective_to = now() WHERE id='${card}'`,
      `UPDATE special_rates SET is_active = false WHERE id='${card}'`,
      "INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at) VALUES ('USD','GHS',1,'rogue', now())",
      "UPDATE fx_rates SET is_active = false",
      "INSERT INTO warehouses (name) VALUES ('Rogue Depot')", "UPDATE warehouses SET name = 'x'",
      "INSERT INTO suppliers (supplier_ref, name) VALUES ('SUP-ROGUE','Rogue')", "UPDATE suppliers SET name = 'x'",
    ];
    it("staff, customers and a session with no actor cannot create, update, deactivate or re-date rates, FX, warehouses or suppliers", async () => {
      const card = await specialRate(db.admin, { name: "Gold", sea_rate_usd: 300 });
      await q("INSERT INTO suppliers (supplier_ref, name) VALUES ('SUP-1','Acme')");
      const before = JSON.stringify([await q("SELECT * FROM package_rates ORDER BY id"), await q("SELECT * FROM special_rates ORDER BY id"), await q("SELECT * FROM fx_rates ORDER BY id"), await q("SELECT * FROM warehouses ORDER BY id"), await q("SELECT * FROM suppliers ORDER BY id")]);
      for (const sql of writes(card)) {
        expect(await code(as(staff, (tx) => tx.query(sql))), `staff: ${sql}`).toMatch(/^(NOT_AUTHORIZED|42501)$/);   // 42501: no DELETE privilege at all
        // a customer actor may not even see these rows (row-level security), so a write matches nothing or is refused; the snapshot below proves no change
        expect(await code(as(loginA, (tx) => tx.query(sql))), `customer: ${sql}`).toMatch(/^(NOT_AUTHORIZED|42501|OK)$/);
        expect(await sqlstate(db.app.query(sql)), `no actor: ${sql}`).toMatch(/^(MV012|42501)$/);
      }
      expect(JSON.stringify([await q("SELECT * FROM package_rates ORDER BY id"), await q("SELECT * FROM special_rates ORDER BY id"), await q("SELECT * FROM fx_rates ORDER BY id"), await q("SELECT * FROM warehouses ORDER BY id"), await q("SELECT * FROM suppliers ORDER BY id")])).toBe(before);
    });
    it("a super_admin can administer them (the guard is a role check, not a lock-out)", async () => {
      const card = await specialRate(db.admin, { name: "Silver", sea_rate_usd: 310 });
      expect(await code(as(admin, (tx) => tx.query("UPDATE special_rates SET sea_rate_usd = 305 WHERE id=$1", [card])))).toBe("OK");
      expect(await code(as(admin, (tx) => tx.query("INSERT INTO warehouses (name) VALUES ('Second Depot')")))).toBe("OK");
      expect(await code(as(admin, (tx) => tx.query("INSERT INTO suppliers (supplier_ref, name) VALUES ('SUP-2','Beta')")))).toBe("OK");
      expect(await code(as(admin, (tx) => tx.query("INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at) VALUES ('USD','GHS',12.5,'admin', now() - interval '1 year')")))).toBe("OK");
      expect((await q("SELECT sea_rate_usd FROM special_rates WHERE id=$1", [card]))[0].sea_rate_usd).toBe("305.0000");
    });
    it("a rate or FX change cannot touch a historical invoice (Phase 7D snapshots stay immutable even for the admin)", async () => {
      const snap = async () => (await q("SELECT subtotal_usd, fx_rate, total_ghs FROM invoices WHERE id=$1", [invA]))[0];
      const before = await snap();
      await as(admin, (tx) => tx.query("UPDATE package_rates SET rate_usd = 999 WHERE tier='basic'"));
      await q("UPDATE package_rates SET rate_usd = CASE freight_type WHEN 'sea' THEN 350 ELSE 8 END WHERE tier='basic'");
      expect(await snap()).toEqual(before);
      expect(await code(as(admin, (tx) => tx.query("UPDATE invoices SET subtotal_usd = 1 WHERE id=$1", [invA])))).toBe("IMMUTABLE_RECORD");
    });
  });

  describe("customers: identity is administrative, a customer edits only address and notes", () => {
    const protectedCols: Array<[string, string]> = [["name", "'Hacked'"], ["phone", "'0200000000'"], ["email", "'h@example.invalid'"], ["shipping_mark", "'MOVEZZ-HACK'"],
      ["package_tier", "'enterprise'"], ["preferred_warehouse_id", "(SELECT id FROM warehouses LIMIT 1)"], ["status", "'inactive'"], ["archived_at", "now()"], ["shipping_type", "'air'"], ["created_by", "'me'"], ["id", "gen_random_uuid()"]];
    it("a customer cannot change any protected field of their own record, through SQL or the repository", async () => {
      const before = JSON.stringify((await q("SELECT * FROM customers WHERE id=$1", [custA]))[0]);
      for (const [col, val] of protectedCols) {
        expect(await code(as(loginA, (tx) => tx.query(`UPDATE customers SET ${col} = ${val} WHERE id = $1`, [custA]))), col).toBe("NOT_AUTHORIZED");
      }
      expect(await code(as(loginA, (tx) => tx.query("UPDATE customers SET name='Hacked', notes='n' WHERE id=$1", [custA])))).toBe("NOT_AUTHORIZED");   // mixed: all or nothing
      expect(await code(as(loginA, (tx) => tx.query("DELETE FROM customers WHERE id=$1", [custA])))).toMatch(/42501/);
      for (const bad of [{ name: "x" }, { phone: "1" }, { email: "x@y.z" }, { shippingMark: "M" }, { packageTier: "special" }, { status: "inactive" }, { role: "super_admin" }, { customerId: custB }, { id: custB }, { created_by: "x" }, { notes: "ok", name: "no" }]) {
        expect(await code(as(loginA, (tx) => repo.updateCustomerSelf(tx, bad as never))), JSON.stringify(bad)).toBe("INVALID_INPUT");
      }
      expect(JSON.stringify((await q("SELECT * FROM customers WHERE id=$1", [custA]))[0])).toBe(before);
    });
    it("a customer can change their own address and notes - and only theirs, audited with the customer as actor", async () => {
      const r = await as(loginA, (tx) => repo.updateCustomerSelf(tx, { shippingAddress: "12 Palm Street, Accra", notes: "Call before delivery" }));
      expect(r).toMatchObject({ shipping_address: "12 Palm Street, Accra", notes: "Call before delivery" });
      expect((await q("SELECT shipping_address FROM customers WHERE id=$1", [custB]))[0].shipping_address).not.toBe("12 Palm Street, Accra");
      // another customer's row: not even visible, so nothing matches
      const res = await as(loginA, (tx) => tx.query("UPDATE customers SET notes='pwned' WHERE id=$1", [custB]));
      expect(res.rowCount).toBe(0);
      expect((await q("SELECT notes FROM customers WHERE id=$1", [custB]))[0].notes).not.toBe("pwned");
      const a = await q("SELECT actor_user_id, after_data FROM audit_logs WHERE action='customer.update_self' AND entity_id=$1", [custA]);
      expect(a).toMatchObject([{ actor_user_id: loginA, after_data: { fields: ["shippingAddress", "notes"] } }]);
      expect(await code(as(loginA, (tx) => repo.updateCustomerSelf(tx, {})))).toBe("INVALID_INPUT");
    });
    it("staff cannot edit or create customers (identity, tier, warehouse, status), nor can they use the self-service path", async () => {
      for (const [col, val] of [...protectedCols.slice(0, 7), ["notes", "'staff note'"], ["shipping_address", "'staff address'"]] as Array<[string, string]>) {
        expect(await code(as(staff, (tx) => tx.query(`UPDATE customers SET ${col} = ${val} WHERE id = $1`, [custA]))), col).toBe("NOT_AUTHORIZED");
      }
      expect(await code(as(staff, (tx) => tx.query("INSERT INTO customers (name, shipping_mark) VALUES ('Rogue','MOVEZZ-ROGUE')")))).toBe("NOT_AUTHORIZED");
      expect(await code(as(staff, (tx) => repo.updateCustomerSelf(tx, { notes: "x" })))).toBe("NOT_AUTHORIZED");
      expect(await code(as(staff, (tx) => repo.updateCustomerAdmin(tx, custA, { name: "x" })))).toBe("NOT_AUTHORIZED");
    });
    it("only a super_admin edits customer identity/configuration, through an allow-list (no shipping mark, no role/ownership fields)", async () => {
      await as(admin, (tx) => repo.updateCustomerAdmin(tx, custB, { name: "Bravo Ltd", phone: "0244000111", packageTier: "business", status: "active" }));
      expect((await q("SELECT name, package_tier FROM customers WHERE id=$1", [custB]))[0]).toEqual({ name: "Bravo Ltd", package_tier: "business" });
      for (const bad of [{ shippingMark: "X" }, { shipping_mark: "X" }, { role: "x" }, { id: NIL }, { created_by: "x" }, {}]) {
        expect(await code(as(admin, (tx) => repo.updateCustomerAdmin(tx, custB, bad))), JSON.stringify(bad)).toBe("INVALID_INPUT");
      }
      await q("UPDATE customers SET name='Bravo', package_tier='basic' WHERE id=$1", [custB]);
    });
  });

  describe("financial authorization", () => {
    it("staff and customers cannot create or cancel invoices, record or void payments, or discount - by service or by SQL", async () => {
      const i = await pricedItem(db.admin, custA, "40.00");
      for (const who of [staff, loginA]) {
        expect(await code(createInvoice(db.app, { customerId: custA, itemIds: [i], actor: user(who), idempotencyKey: key() })), "create").toBe("NOT_AUTHORIZED");
        expect(await code(createInvoice(db.app, { customerId: custA, itemIds: [i], discountUsd: "40.00", discountReason: "x", actor: user(who), idempotencyKey: key() })), "discount").toBe("NOT_AUTHORIZED");
        expect(await code(recordPayment(db.app, { invoiceId: invA, amountGhs: "1.00", actor: user(who), idempotencyKey: key() })), "pay").toBe("NOT_AUTHORIZED");
        expect(await code(voidPayment(db.app, { paymentId: payA, reason: "no", actor: user(who) })), "void").toBe("NOT_AUTHORIZED");
        expect(await code(cancelInvoice(db.app, { invoiceId: invA, reason: "no", actor: user(who) })), "cancel").toBe("NOT_AUTHORIZED");
        expect(await code(as(who, (tx) => tx.query("INSERT INTO payments (invoice_id, amount_ghs) VALUES ($1, 1)", [invA]))), "sql pay").toMatch(/NOT_AUTHORIZED|OK/);
        expect(await code(as(who, (tx) => tx.query("UPDATE payments SET status='voided', voided_at=now(), void_reason='x' WHERE id=$1", [payA]))), "sql void").not.toBe("OK");
      }
      expect((await q("SELECT status FROM payments WHERE id=$1", [payA]))[0].status).toBe("completed");
      expect((await q("SELECT status FROM invoices WHERE id=$1", [invA]))[0].status).not.toBe("Cancelled");
      expect((await q("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invA]))[0].n).toBe(1);
      expect((await q("SELECT invoice_id FROM items WHERE id=$1", [i]))[0].invoice_id).toBeNull();
    });
    it("super_admin keeps the financial operations (payment prerequisite for cancellation unchanged)", async () => {
      const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00");
      const inv = (await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(admin), idempotencyKey: key() })).invoice;
      const p = await recordPayment(db.app, { invoiceId: inv.id, amountGhs: "20.00", actor: user(admin2), idempotencyKey: key() });
      expect(await code(cancelInvoice(db.app, { invoiceId: inv.id, reason: "x", actor: user(admin) }))).toBe("ACTIVE_PAYMENT_EXISTS");
      await voidPayment(db.app, { paymentId: p.payment.id, reason: "wrong", actor: user(admin) });
      expect(await code(cancelInvoice(db.app, { invoiceId: inv.id, reason: "ok", actor: user(admin) }))).toBe("OK");
    });
    it("Keepup sync state: only super_admin or the integration/system service identity may change it; staff, customers and anonymous sessions cannot", async () => {
      const sql = "UPDATE keepup_sync SET sync_state='failed', last_error='x' WHERE invoice_id=$1";
      const before = (await q("SELECT sync_state FROM keepup_sync WHERE invoice_id=$1", [invA]))[0].sync_state;
      expect(await code(as(staff, (tx) => tx.query(sql, [invA])))).toBe("NOT_AUTHORIZED");
      await as(loginA, (tx) => tx.query(sql, [invA]));                          // a customer actor cannot even see the row (RLS): nothing changes
      expect((await q("SELECT sync_state FROM keepup_sync WHERE invoice_id=$1", [invA]))[0].sync_state).toBe(before);
      expect(await sqlstate(db.app.query(sql, [invA]))).toBe("MV012");
      expect(await code(as(staff, (tx) => tx.query("UPDATE keepup_sync SET sync_state='synced', keepup_sale_id='KU-FAKE' WHERE invoice_id=$1", [invA])))).toBe("NOT_AUTHORIZED");
      expect((await q("SELECT sync_state FROM keepup_sync WHERE invoice_id=$1", [invA]))[0].sync_state).toBe(before);
      expect(await code(as({ type: "integration" }, (tx) => tx.query(sql, [invA])))).toBe("OK");
      expect(await code(as(admin, (tx) => tx.query("UPDATE keepup_sync SET sync_state='pending', last_error=NULL WHERE invoice_id=$1", [invA])))).toBe("OK");
      expect(await code(as({ type: "import" }, (tx) => tx.query(sql, [invA])))).toBe("NOT_AUTHORIZED");
    });
    it("staff may still price items (operational), customers may not", async () => {
      const i = await item(db.admin, custA, { package_tier: null, tier_rate_usd: null, tier_price_usd: null });
      expect(await code(as(staff, (tx) => priceItem(tx, i)))).toBe("OK");
      expect(await code(as(loginA, (tx) => priceItem(tx, i)))).toBe("NOT_AUTHORIZED");
    });
  });

  describe("customer ownership: IDOR / BOLA through the repositories", () => {
    const same = async (a: Promise<unknown>, b: Promise<unknown>) => expect(JSON.stringify(await a)).toBe(JSON.stringify(await b));
    it("a customer reads their own resources and nobody else's; 'not yours' is indistinguishable from 'does not exist'", async () => {
      expect((await as(loginA, (tx) => repo.getItem(tx, itemA)))?.id).toBe(itemA);
      expect((await as(loginB, (tx) => repo.getItem(tx, itemB)))?.id).toBe(itemB);
      expect(await as(loginA, (tx) => repo.getItem(tx, itemB))).toBeNull();
      expect(await as(loginB, (tx) => repo.getItem(tx, itemA))).toBeNull();
      await same(as(loginA, (tx) => repo.getItem(tx, itemB)), as(loginA, (tx) => repo.getItem(tx, NIL)));
      await same(as(loginA, (tx) => repo.getCarton(tx, cartonB)), as(loginA, (tx) => repo.getCarton(tx, NIL)));
      await same(as(loginA, (tx) => repo.getInvoice(tx, invB)), as(loginA, (tx) => repo.getInvoice(tx, NIL)));
      await same(as(loginA, (tx) => repo.getInvoicePayments(tx, invB)), as(loginA, (tx) => repo.getInvoicePayments(tx, NIL)));
      await same(as(loginA, (tx) => repo.getItemHistory(tx, itemB)), as(loginA, (tx) => repo.getItemHistory(tx, NIL)));
      await same(as(loginA, (tx) => repo.getCustomer(tx, custB)), as(loginA, (tx) => repo.getCustomer(tx, NIL)));
      expect((await as(loginA, (tx) => repo.getCarton(tx, cartonA)))?.id).toBe(cartonA);
      const inv = await as(loginA, (tx) => repo.getInvoice(tx, invA));
      expect(inv).toMatchObject({ id: invA, lines: [{ item_id: itemA }] });
      expect((await as(loginA, (tx) => repo.getInvoicePayments(tx, invA)))?.map((p) => p.id)).toEqual([payA]);
      expect((await as(loginA, (tx) => repo.getItemHistory(tx, itemA)))?.length).toBeGreaterThan(0);
      expect((await as(loginA, (tx) => repo.getCustomer(tx, custA)))?.id).toBe(custA);
    });
    it("malformed ids, guessed reference numbers and foreign filters never reach another customer's data", async () => {
      for (const bad of ["", "abc", "1", "' OR 1=1 --", "00000000-0000-0000-0000-000000000000", "../etc/passwd", `${itemB};DROP TABLE items`, itemB.toUpperCase().replace(/-/g, "")]) {
        expect(await as(loginA, (tx) => repo.getItem(tx, bad)), bad).toBeNull();
        expect(await as(loginA, (tx) => repo.getInvoice(tx, bad)), bad).toBeNull();
      }
      expect(await as(loginA, (tx) => repo.getItemByRef(tx, refB))).toBeNull();                         // guessed reference number
      expect((await as(loginB, (tx) => repo.getItemByRef(tx, refB)))?.id).toBe(itemB);
      const listed = await as(loginA, (tx) => repo.listItems(tx, { customerId: custB, limit: 500 }));     // ?customerId=<other> is ignored for a customer
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.every((r) => r.customer_id === custA)).toBe(true);
      expect((await as(loginA, (tx) => repo.listCartons(tx, { customerId: custB }))).every((r) => r.customer_id === custA)).toBe(true);
      expect((await as(loginA, (tx) => repo.listInvoices(tx, { customerId: custB }))).every((r) => r.customer_id === custA)).toBe(true);
      expect((await as(loginA, (tx) => repo.listItems(tx, { limit: -5, offset: -5 }))).every((r) => r.customer_id === custA)).toBe(true);
    });
    it("staff see operational data (any customer, filterable) but have no financial read access; admins see everything", async () => {
      expect((await as(staff, (tx) => repo.getItem(tx, itemB)))?.id).toBe(itemB);
      expect((await as(staff, (tx) => repo.getCarton(tx, cartonA)))?.id).toBe(cartonA);
      const all = await as(staff, (tx) => repo.listItems(tx, { limit: 500 }));
      expect(new Set(all.map((r) => r.customer_id)).size).toBeGreaterThan(1);
      expect((await as(staff, (tx) => repo.listItems(tx, { customerId: custB }))).every((r) => r.customer_id === custB)).toBe(true);
      expect(await as(staff, (tx) => repo.listItems(tx, { customerId: "not-a-uuid" }))).toEqual([]);
      const financial: Array<(tx: pg.PoolClient) => Promise<unknown>> = [(tx) => repo.getInvoice(tx, invA), (tx) => repo.listInvoices(tx), (tx) => repo.getInvoicePayments(tx, invA)];
      for (const f of financial) expect(await code(as(staff, f))).toBe("NOT_AUTHORIZED");
      expect(((await as(admin, (tx) => repo.getInvoice(tx, invB))) as { id: string } | null)?.id).toBe(invB);
      expect((await as(admin, (tx) => repo.getInvoicePayments(tx, invB)))?.map((p) => p.id)).toEqual([payB]);
    });
    it("service identities cannot use the user repositories", async () => {
      for (const t of ["system", "integration", "import"] as const) expect(await code(as({ type: t }, (tx) => repo.getItem(tx, itemA))), t).toBe("NOT_AUTHORIZED");
    });
  });

  describe("defence in depth: row-level security binds a customer actor even to raw SQL", () => {
    const rows = (who: string, sql: string, p: unknown[] = []) => as(who, (tx) => tx.query(sql, p)).then((r) => r.rows);
    it("raw SELECTs by a customer actor return only their own rows; audit, keepup, outbox, containers, suppliers, rates are invisible", async () => {
      expect((await rows(loginA, "SELECT DISTINCT customer_id FROM items")).map((r) => r.customer_id)).toEqual([custA]);
      expect((await rows(loginA, "SELECT DISTINCT customer_id FROM cartons")).map((r) => r.customer_id)).toEqual([custA]);
      expect((await rows(loginA, "SELECT DISTINCT customer_id FROM invoices")).map((r) => r.customer_id)).toEqual([custA]);
      expect((await rows(loginA, "SELECT id FROM customers")).map((r) => r.id)).toEqual([custA]);
      expect((await rows(loginA, "SELECT id FROM users")).map((r) => r.id)).toEqual([loginA]);
      expect((await rows(loginA, "SELECT DISTINCT i.customer_id FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id")).map((r) => r.customer_id)).toEqual([custA]);
      expect((await rows(loginA, "SELECT invoice_id FROM payments")).every((r) => r.invoice_id === invA)).toBe(true);
      expect((await rows(loginA, "SELECT entity_id FROM status_events WHERE entity_type='item'")).map((r) => r.entity_id)).toEqual([itemA]);
      for (const t of ["audit_logs", "keepup_sync", "notification_outbox", "idempotency_keys", "containers", "suppliers", "special_rates", "registration_requests", "fx_rates"]) {
        expect(await rows(loginA, `SELECT 1 FROM ${t}`), t).toEqual([]);
      }
      expect((await rows(staff, "SELECT DISTINCT customer_id FROM items")).length).toBeGreaterThan(1);                       // staff are not scoped by RLS
      expect((await rows(loginA, `SELECT id FROM items WHERE id='${itemB}'`))).toEqual([]);                                  // direct id probe
    });
    it("a customer actor cannot write operational or financial tables at all", async () => {
      for (const sql of ["UPDATE items SET description='x'", "UPDATE cartons SET length=1", "INSERT INTO containers (container_ref) VALUES ('PMX-CON-2099-001')", "UPDATE invoice_lines SET description='x'",
        "INSERT INTO notification_outbox (event_type, channel, recipient, payload, dedupe_key) VALUES ('x','email','a@b.c','{}','k')", "UPDATE payments SET status='voided'", "UPDATE invoices SET notes='x'"]) {
        expect(await code(as(loginA, (tx) => tx.query(sql))), sql).toMatch(/NOT_AUTHORIZED|42501|OK/);
      }
      expect((await q("SELECT count(*)::int AS n FROM items WHERE description='x'"))[0].n).toBe(0);
      expect((await q("SELECT count(*)::int AS n FROM payments WHERE status='voided' AND invoice_id IN ($1,$2)", [invA, invB]))[0].n).toBe(0);
      expect((await q("SELECT count(*)::int AS n FROM invoices WHERE notes='x'"))[0].n).toBe(0);
    });
  });

  describe("account state: inactive users and customers, stale sessions, concurrent deactivation", () => {
    it("an inactive user cannot authenticate into any operation", async () => {
      const u = await staffUser(db.admin, "warehouse_staff"); await q("UPDATE users SET is_active=false, deactivated_at=now() WHERE id=$1", [u]);
      expect(await code(as(u, (tx) => repo.listItems(tx)))).toBe("ACTOR_INVALID");
      expect(await code(as(u, (tx) => priceItem(tx, itemA)))).toBe("ACTOR_INVALID");
    });
    it("an inactive/archived customer cannot access or mutate anything, and their login is deactivated with them; history stays intact", async () => {
      const c = await customer(db.admin); const l = await login(c, "gone"); const i = await pricedItem(db.admin, c, "40.00");
      const inv = (await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(admin), idempotencyKey: key() })).invoice;
      expect((await as(l, (tx) => repo.getItem(tx, i)))?.id).toBe(i);
      await q("UPDATE customers SET status='inactive' WHERE id=$1", [c]);
      expect((await q("SELECT is_active FROM users WHERE id=$1", [l]))[0].is_active).toBe(false);
      expect(await code(as(l, (tx) => repo.getItem(tx, i)))).toBe("ACTOR_INVALID");
      expect(await code(as(l, (tx) => repo.updateCustomerSelf(tx, { notes: "x" })))).toBe("ACTOR_INVALID");
      expect((await q("SELECT count(*)::int AS n FROM invoices WHERE id=$1", [inv.id]))[0].n).toBe(1);     // deactivation is not deletion (D8)
      // even if somebody flips only the login back on, an inactive customer still cannot get in
      expect(await sqlstate(db.admin.query("UPDATE users SET is_active=true, deactivated_at=NULL WHERE id=$1", [l]))).not.toBe("OK");   // the database refuses it
      expect(await code(as(l, (tx) => repo.getItem(tx, i)))).toBe("ACTOR_INVALID");
      const arch = await customer(db.admin); const la = await login(arch, "arch");
      await q("UPDATE customers SET status='inactive', archived_at=now() WHERE id=$1", [arch]);
      expect(await sqlstate(db.admin.query("UPDATE users SET is_active=true, deactivated_at=NULL WHERE id=$1", [la]))).not.toBe("OK");
      expect(await code(as(la, (tx) => repo.listItems(tx)))).toBe("ACTOR_INVALID");
    });
    it("a customer login can never exist without a customer, and an unlinked context is refused by the policy", async () => {
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid,email,role) VALUES ('nolink','nolink@example.invalid','customer')"))).toBe("23514");
      expect(await sqlstate(db.admin.query("UPDATE users SET customer_id = NULL WHERE id=$1", [loginA]))).toBe("23514");
      expect(await sqlstate(db.admin.query("UPDATE users SET customer_id = $2 WHERE id=$1", [staff, custA]))).toBe("23514");
      expect(isAllowed({ type: "user", userId: "u", role: "customer", customerId: null }, "item.read.own")).toBe(false);
    });
    it("a stale (pre-deactivation) session cannot be used afterwards; a role change applies to the very next transaction", async () => {
      const u = await staffUser(db.admin, "warehouse_staff");
      const stale = mintAssertion(user(u), TEST_ACTOR_KEY);                       // minted while the user is active, used after deactivation
      await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_active($1,false,'left')", [u]));
      const c = await db.app.connect();
      try {
        await c.query("BEGIN");
        expect(await sqlstate(c.query("SELECT movezz_sec.begin_actor($1,$2,$3,$4,$5,$6)", [stale.type, stale.userId, stale.requestId, stale.jti, stale.exp, stale.sig]))).toBe("MV007");
      } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
      await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_active($1,true,NULL)", [u]));
      expect(await code(as(u, (tx) => priceItem(tx, itemA)))).toBe("OK");
      const cz = await customer(db.admin); const iz = await pricedItem(db.admin, cz, "40.00");
      await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_role($1,'customer',$2)", [u, cz]));
      expect(await code(as(u, (tx) => priceItem(tx, itemA)))).toBe("NOT_AUTHORIZED");                // new role is in force immediately
      expect((await as(u, (tx) => repo.getItem(tx, itemA)))).toBeNull();                           // and they are now scoped to their customer only
      expect((await as(u, (tx) => repo.getItem(tx, iz)))?.id).toBe(iz);
    });
    it("deactivation racing in-flight requests: a request that already began finishes; every later request is refused; none slips through", async () => {
      const u = await staffUser(db.admin, "warehouse_staff");
      const gate = await db.app.connect();
      try {
        await gate.query("BEGIN");
        await beginActor(gate, user(u), TEST_ACTOR_KEY);                           // request 1 is mid-flight (holds a share lock on the user row)
        let deactivated = false;
        const off = as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_active($1,false,'race')", [u])).then(() => { deactivated = true; });
        await new Promise((r) => setTimeout(r, 300));
        expect(deactivated).toBe(false);                                           // the deactivation waits for the in-flight request
        expect((await gate.query("SELECT movezz_sec.actor_role() AS r")).rows[0].r).toBe("warehouse_staff");
        await gate.query("COMMIT");
        await off;
      } finally { await gate.query("ROLLBACK").catch(() => {}); gate.release(); }
      const results = await Promise.all(Array.from({ length: 10 }, () => code(as(u, (tx) => repo.listItems(tx)))));
      expect(results.every((r) => r === "ACTOR_INVALID")).toBe(true);
      // and many requests in flight while it happens: each is either fully served or fully refused
      const v = await staffUser(db.admin, "warehouse_staff");
      const burst = Promise.all(Array.from({ length: 20 }, () => code(as(v, (tx) => repo.listItems(tx, { limit: 5 })))));
      await as(admin, (tx) => tx.query("SELECT movezz_sec.admin_set_user_active($1,false,'race2')", [v]));
      expect((await burst).every((r) => r === "OK" || r === "ACTOR_INVALID")).toBe(true);
      expect(await code(as(v, (tx) => repo.listItems(tx)))).toBe("ACTOR_INVALID");
    });
  });

  describe("runtime database role review", () => {
    it("cannot do DDL, TRUNCATE, create definer functions, touch actor keys, rewind reference counters or forge audit/status rows", async () => {
      const bad = [
        "CREATE TABLE evil (id int)", "ALTER TABLE users ADD COLUMN x int", "TRUNCATE items", "TRUNCATE users",
        "CREATE FUNCTION public.evil() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'", "CREATE SCHEMA evil",
        "SELECT * FROM movezz_sec.actor_keys", "UPDATE movezz_sec.actor_sessions SET role='super_admin'", "SELECT movezz_sec.set_actor_key(decode(repeat('ab',32),'hex'))",
        "UPDATE reference_counters SET last_value = 0", "DELETE FROM reference_counters", "SELECT seed_reference_counter('item','',0)",
        "INSERT INTO audit_logs (actor_type, action, entity_type) VALUES ('system','forged','x')", "UPDATE audit_logs SET action='x'", "DELETE FROM status_events",
        "ALTER TABLE users DISABLE TRIGGER ALL", "ALTER TABLE items DISABLE ROW LEVEL SECURITY", "DROP POLICY customer_scope ON items", "SET session_replication_role = replica",
        "ALTER ROLE movezz_app SUPERUSER", "SET ROLE postgres",
      ];
      for (const sql of bad) expect(await sqlstate(as(admin, (tx) => tx.query(sql))), sql).toMatch(/^(42501|42P01|0A000)$/);   // even with a super_admin actor: a database privilege, not an app role
      await as(admin, (tx) => tx.query("GRANT ALL ON users TO PUBLIC")).catch(() => {});                       // not the owner: PostgreSQL grants nothing
      expect((await db.admin.query("SELECT has_table_privilege('public','users','UPDATE') AS u, has_table_privilege('public','items','DELETE') AS d")).rows[0]).toEqual({ u: false, d: false });
      const r = (await db.admin.query("SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname='movezz_app'")).rows[0];
      expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
    });
    it("every SECURITY DEFINER function pins its search_path and is closed to PUBLIC; the user-admin functions are executable by the runtime role only through their own role checks", async () => {
      const rows = (await db.admin.query(`SELECT n.nspname || '.' || p.proname AS f, p.proconfig::text AS cfg, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prosecdef AND n.nspname IN ('public','movezz_sec')`)).rows;
      for (const r of rows) { expect(r.cfg, r.f).toMatch(/search_path=pg_catalog/); expect(r.pub, r.f).toBe(false); }
      expect(rows.map((r) => r.f)).toEqual(expect.arrayContaining(["movezz_sec.admin_create_user", "movezz_sec.admin_set_user_role", "movezz_sec.admin_set_user_active"]));
    });
    it("a client-supplied actor id, role or created_by is never authoritative", async () => {
      const i = await pricedItem(db.admin, custA, "40.00");
      expect(await code(createInvoice(db.app, { customerId: custA, itemIds: [i], actor: user(admin), idempotencyKey: key(), role: "super_admin", actorUserId: staff, created_by: staff } as never))).toBe("INVALID_INPUT");
      const inv = (await createInvoice(db.app, { customerId: custA, itemIds: [i], actor: user(admin), idempotencyKey: key(), actorUserId: staff, createdBy: staff } as never)).invoice;
      expect((await q("SELECT created_by FROM invoices WHERE id=$1", [inv.id]))[0].created_by).toBe(admin);          // unknown keys are not identity
      expect((await q("SELECT DISTINCT actor_user_id FROM audit_logs WHERE entity_id=$1", [inv.id])).map((r) => r.actor_user_id)).toEqual([admin]);
    });
  });
});
