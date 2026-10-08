// Migrations from an empty database, schema-wide invariants, identity and operational constraints.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dbDescribe, createTestDb, customer, item, carton, staffUser, sqlstate, ADMIN_URL, type TestDb } from "./helpers";
import { migrate, status, assertSafeTarget, loadMigrations, MIGRATIONS_DIR } from "../../scripts/lib/migrate.mjs";

dbDescribe("migrations and schema invariants (PostgreSQL)", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.close(); });

  describe("migration system", () => {
    it("builds the full schema from an EMPTY database using migrations alone", async () => {
      const { rows } = await db.admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1");
      const tables = rows.map((r) => r.table_name);
      for (const t of ["users", "customers", "warehouses", "suppliers", "containers", "cartons", "items", "item_photos", "invoices", "invoice_lines",
        "payments", "status_events", "audit_logs", "package_rates", "special_rates", "fx_rates", "reference_counters", "idempotency_keys",
        "keepup_sync", "registration_requests", "notification_outbox", "schema_migrations"]) {
        expect(tables, t).toContain(t);
      }
    });
    it("records every migration with a checksum and is a no-op the second time", async () => {
      const files = await loadMigrations();
      const { rows } = await db.admin.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
      expect(rows).toHaveLength(files.length);
      expect(rows.map((r) => r.checksum)).toEqual(files.map((f: { checksum: string }) => f.checksum));
      expect((await migrate(db.adminUrl)).applied).toEqual([]);
      expect((await status(db.adminUrl)).every((s: { applied: boolean }) => s.applied)).toBe(true);
    });
    it("refuses to run when an applied migration file has been edited", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
      for (const f of await loadMigrations()) await writeFile(path.join(dir, f.name), f.sql + (f.version === 1 ? "\n-- tampered\n" : ""));
      await expect(migrate(db.adminUrl, { dir })).rejects.toThrow(/modified after it was applied/);
    });
    it("rolls a failing migration back completely (all or nothing)", async () => {
      const root = new URL(ADMIN_URL!);
      const probe = `mvz_test_probe_${Date.now()}`;
      await db.admin.query(`CREATE DATABASE ${probe}`);
      try {
        root.pathname = `/${probe}`;
        const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
        await writeFile(path.join(dir, "0001_ok.sql"), "CREATE TABLE t_ok (id int);");
        await writeFile(path.join(dir, "0002_bad.sql"), "CREATE TABLE t_half (id int); SELECT 1/0;");
        await expect(migrate(root.toString(), { dir })).rejects.toThrow(/0002_bad.sql failed and was rolled back/);
        const url = root.toString();
        const c = new (await import("pg")).default.Client({ connectionString: url });
        await c.connect();
        const t = await c.query("SELECT to_regclass('t_ok') AS a, to_regclass('t_half') AS b");
        const m = await c.query("SELECT count(*)::int AS n FROM schema_migrations");
        await c.end();
        expect(t.rows[0]).toEqual({ a: "t_ok", b: null });
        expect(m.rows[0].n).toBe(1);
      } finally {
        await db.admin.query(`DROP DATABASE ${probe} WITH (FORCE)`);
      }
    });
    it("refuses remote targets unless the host is confirmed", () => {
      expect(() => assertSafeTarget("postgres://u@db.example.com/x")).toThrow(/Refusing to migrate remote host/);
      expect(() => assertSafeTarget("postgres://u@db.example.com/x", "db.example.com")).not.toThrow();
      expect(assertSafeTarget("postgres://u@127.0.0.1/x")).toBe("127.0.0.1");
    });
    it("migration files contain no destructive statements", async () => {
      for (const f of await loadMigrations(MIGRATIONS_DIR)) {
        expect(f.sql, f.name).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)\b/i);
        expect(f.sql, f.name).not.toMatch(/\bTRUNCATE\s+TABLE\b|\bDELETE\s+FROM\b(?!.*--)/i);
        expect(f.sql, f.name).not.toMatch(/ON DELETE CASCADE/i);
        expect(f.sql, f.name).not.toMatch(/\bPASSWORD\s+'/i);
      }
      expect(await readFile(path.join(MIGRATIONS_DIR, "0008_runtime_grants.sql"), "utf8")).not.toMatch(/CREATE\s+ROLE|ALTER\s+ROLE/i);
    });
  });

  describe("schema-wide invariants", () => {
    it("no foreign key cascades or nulls-out on delete (history is never destroyed implicitly)", async () => {
      const { rows } = await db.admin.query("SELECT conrelid::regclass AS t, conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND confdeltype IN ('c','n','d')");
      expect(rows).toEqual([]);
    });
    it("no floating point column exists; every money/rate/FX column is NUMERIC", async () => {
      const bad = await db.admin.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND data_type IN ('real','double precision','money')");
      expect(bad.rows).toEqual([]);
      const money = await db.admin.query(
        `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns
          WHERE table_schema='public' AND (column_name ~ '(_usd|_ghs)$' OR column_name IN ('fx_rate','rate','amount_ghs'))`);
      expect(money.rows.length).toBeGreaterThan(20);
      for (const r of money.rows) expect(r.data_type, `${r.table_name}.${r.column_name}`).toBe("numeric");
      const sc = Object.fromEntries(money.rows.map((r) => [`${r.table_name}.${r.column_name}`, `${r.numeric_precision},${r.numeric_scale}`]));
      expect(sc["invoices.total_ghs"]).toBe("14,2");
      expect(sc["invoices.fx_rate"]).toBe("18,8");
      expect(sc["payments.amount_ghs"]).toBe("14,2");
      expect(sc["package_rates.rate_usd"]).toBe("14,4");
    });
    it("there is no password column anywhere", async () => {
      const { rows } = await db.admin.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND column_name ~* 'pass(word)?|secret'");
      expect(rows).toEqual([]);
    });
    it("legacy Airtable identity columns exist where migration needs them and are unique when set", async () => {
      for (const t of ["warehouses", "customers", "users", "suppliers", "containers", "items", "invoices", "payments", "special_rates", "registration_requests"]) {
        const c = await db.admin.query("SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='legacy_airtable_id'", [t]);
        expect(c.rowCount, t).toBe(1);
      }
      await db.admin.query("INSERT INTO warehouses (name, legacy_airtable_id, legacy_data) VALUES ('W1','recAAA','{\"Name\":\"W1\",\"Extra\":[1,2]}')");
      expect(await sqlstate(db.admin.query("INSERT INTO warehouses (name, legacy_airtable_id) VALUES ('W2','recAAA')"))).toBe("23505");
      await db.admin.query("INSERT INTO warehouses (name) VALUES ('no-legacy-1'), ('no-legacy-2')"); // NULLs never collide
      const r = await db.admin.query("SELECT legacy_data FROM warehouses WHERE legacy_airtable_id='recAAA'");
      expect(r.rows[0].legacy_data).toEqual({ Name: "W1", Extra: [1, 2] });
    });
  });

  describe("users and roles", () => {
    it("auth_uid is unique and e-mail is unique case-insensitively", async () => {
      await db.admin.query("INSERT INTO users (auth_uid, email, role) VALUES ('uid-a','Admin@Example.invalid','super_admin')");
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid, email, role) VALUES ('uid-a','other@example.invalid','super_admin')"))).toBe("23505");
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid, email, role) VALUES ('uid-b','ADMIN@example.INVALID','super_admin')"))).toBe("23505");
    });
    it("a customer login cannot exist without a customer, and staff cannot carry one", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid, email, role) VALUES ('uid-c1','c1@example.invalid','customer')"))).toBe("23514");
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid, email, role, customer_id) VALUES ('uid-c2','c2@example.invalid','warehouse_staff',$1)", [c]))).toBe("23514");
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid, email, role, customer_id) VALUES ('uid-c3','c3@example.invalid','customer','00000000-0000-0000-0000-0000000000aa')"))).toBe("23503");
      await db.admin.query("INSERT INTO users (auth_uid, email, role, customer_id) VALUES ('uid-c4','c4@example.invalid','customer',$1)", [c]);
    });
    it("one login per customer", async () => {
      const c = await customer(db.admin);
      await db.admin.query("INSERT INTO users (auth_uid, email, role, customer_id) VALUES ('uid-d1','d1@example.invalid','customer',$1)", [c]);
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid, email, role, customer_id) VALUES ('uid-d2','d2@example.invalid','customer',$1)", [c]))).toBe("23505");
    });
    it("only the three known roles are accepted; deactivation is explicit", async () => {
      expect(await sqlstate(db.admin.query("INSERT INTO users (auth_uid, email, role) VALUES ('uid-e1','e1@example.invalid','owner')"))).toBe("23514");
      const id = await staffUser(db.admin);
      expect(await sqlstate(db.admin.query("UPDATE users SET is_active = false WHERE id = $1", [id]))).toBe("23514"); // needs deactivated_at
      await db.admin.query("UPDATE users SET is_active = false, deactivated_at = now() WHERE id = $1", [id]);
    });
    it("the database never promotes anyone: an empty users table stays empty", async () => {
      const probe = await createTestDb();
      try { expect((await probe.admin.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(0); } finally { await probe.close(); }
    });
    it("registration requests: one open request per e-mail / phone; rejection needs a reason", async () => {
      await db.admin.query("INSERT INTO registration_requests (email, name, phone) VALUES ('new@example.invalid','New','0244 111 222')");
      expect(await sqlstate(db.admin.query("INSERT INTO registration_requests (email, name) VALUES ('NEW@example.invalid','Dup')"))).toBe("23505");
      expect(await sqlstate(db.admin.query("INSERT INTO registration_requests (email, name, phone) VALUES ('x@example.invalid','Dup','(0244)-111-222')"))).toBe("23505");
      expect(await sqlstate(db.admin.query("UPDATE registration_requests SET status='rejected', reviewed_at=now() WHERE email='new@example.invalid'"))).toBe("23514");
      await db.admin.query("UPDATE registration_requests SET status='rejected', reviewed_at=now(), rejection_reason='duplicate' WHERE email='new@example.invalid'");
      await db.admin.query("INSERT INTO registration_requests (email, name) VALUES ('new@example.invalid','Retry')"); // closed requests no longer block
    });
  });

  describe("customers, warehouses, archive policy", () => {
    it("shipping mark is unique (archived customers keep theirs) and phone is normalised for lookup", async () => {
      await customer(db.admin, { mark: "MOVEZZ-AB1111", phone: "+233 (24) 400-1111" });
      expect(await sqlstate(db.admin.query("INSERT INTO customers (name, shipping_mark) VALUES ('Dup','MOVEZZ-AB1111')"))).toBe("23505");
      const r = await db.admin.query("SELECT phone_digits FROM customers WHERE shipping_mark='MOVEZZ-AB1111'");
      expect(r.rows[0].phone_digits).toBe("233244001111");
    });
    it("archiving hides a customer from the active view but keeps the row; an archived customer must be inactive", async () => {
      const id = await customer(db.admin);
      expect(await sqlstate(db.admin.query("UPDATE customers SET archived_at = now() WHERE id=$1", [id]))).toBe("23514");
      expect((await db.admin.query("SELECT 1 FROM active_customers WHERE id=$1", [id])).rowCount).toBe(1);
      await db.admin.query("UPDATE customers SET archived_at = now(), status='inactive' WHERE id=$1", [id]);
      expect((await db.admin.query("SELECT 1 FROM active_customers WHERE id=$1", [id])).rowCount).toBe(0);
      expect((await db.admin.query("SELECT 1 FROM customers WHERE id=$1", [id])).rowCount).toBe(1);
    });
    it("a customer with history cannot be deleted (RESTRICT)", async () => {
      const c = await customer(db.admin);
      await item(db.admin, c);
      expect(await sqlstate(db.admin.query("DELETE FROM customers WHERE id=$1", [c]))).toBe("23503");
    });
    it("inactive warehouses are distinguishable and indexable", async () => {
      await db.admin.query("INSERT INTO warehouses (name, is_active) VALUES ('Open',true), ('Closed',false)");
      const r = await db.admin.query("SELECT name FROM warehouses WHERE is_active AND name IN ('Open','Closed')");
      expect(r.rows).toEqual([{ name: "Open" }]);
    });
  });

  describe("items, cartons, CBM and ownership", () => {
    it("CBM is generated by the database (cm and inches) and cannot be written", async () => {
      const c = await customer(db.admin);
      const cm = await item(db.admin, c, { length: 50, width: 40, height: 30, quantity: 3 });
      const inch = await item(db.admin, c, { length: 10, width: 10, height: 10, dimension_unit: "inches" });
      const r = await db.admin.query("SELECT id, cbm_per_unit::text AS u, cbm_total::text AS t FROM items WHERE id = ANY($1)", [[cm, inch]]);
      const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
      expect(Number(by[cm].u)).toBe(0.06); // 50*40*30/1e6, exact NUMERIC (no rounding)
      expect(Number(by[cm].t)).toBe(0.18);
      expect(Number(by[inch].u)).toBeCloseTo(0.016387064, 9);
      expect(await sqlstate(db.admin.query("UPDATE items SET cbm_per_unit = 99 WHERE id=$1", [cm]))).toBe("428C9"); // generated column
      expect(await sqlstate(db.admin.query("UPDATE cartons SET cbm = 1"))).toBe("428C9");
      const c2 = await carton(db.admin, c, { length: 100, width: 100, height: 50 });
      expect((await db.admin.query("SELECT cbm::text AS v FROM cartons WHERE id=$1", [c2])).rows[0].v).toMatch(/^0\.5(0*)$/);
    });
    it("rejects negative dimensions, weights and non-positive quantities", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(item(db.admin, c, { length: -1 }))).toBe("23514");
      expect(await sqlstate(item(db.admin, c, { weight_kg: -0.1 }))).toBe("23514");
      expect(await sqlstate(item(db.admin, c, { quantity: 0 }))).toBe("23514");
      expect(await sqlstate(item(db.admin, c, { status: "Lost" }))).toBe("23514");
      expect(await sqlstate(carton(db.admin, c, { length: 0 }))).toBe("23514");
      expect(await sqlstate(carton(db.admin, c, { freight_type: "air", length: null, width: null, height: null }))).toBe("23514"); // air needs weight
    });
    it("an item cannot reference another customer's carton or invoice (composite foreign keys)", async () => {
      const a = await customer(db.admin), b = await customer(db.admin);
      const cartonB = await carton(db.admin, b);
      expect(await sqlstate(item(db.admin, a, { carton_id: cartonB }))).toBe("23503");
      const okCarton = await carton(db.admin, a);
      await item(db.admin, a, { carton_id: okCarton });
    });
    it("special-basis items cannot be placed in cartons; tier items carry no card", async () => {
      const c = await customer(db.admin);
      const ct = await carton(db.admin, c);
      expect(await sqlstate(item(db.admin, c, { billing_basis: "special", special_rate_name: "X", special_price_usd: 1, carton_id: ct }))).toBe("23514");
      expect(await sqlstate(item(db.admin, c, { billing_basis: "special" }))).toBe("23514"); // no snapshot
    });
    it("carton status and invoice link must agree; dissolved needs a timestamp", async () => {
      const c = await customer(db.admin);
      expect(await sqlstate(carton(db.admin, c, { status: "invoiced" }))).toBe("23514");
      expect(await sqlstate(carton(db.admin, c, { status: "dissolved" }))).toBe("23514");
      await carton(db.admin, c, { status: "dissolved", dissolved_at: new Date().toISOString() });
    });
    it("containers: status values, no destructive delete of one that holds items", async () => {
      expect(await sqlstate(db.admin.query("INSERT INTO containers (container_ref, status) VALUES ('PMX-CON-2026-900','Lost')"))).toBe("23514");
      const cid = (await db.admin.query("INSERT INTO containers (container_ref, container_number) VALUES ('PMX-CON-2026-901','MSKU1') RETURNING id")).rows[0].id;
      const c = await customer(db.admin);
      await item(db.admin, c, { container_id: cid });
      expect(await sqlstate(db.admin.query("DELETE FROM containers WHERE id=$1", [cid]))).toBe("23503");
    });
    it("item photos: https only, no duplicate public id per item", async () => {
      const c = await customer(db.admin); const i = await item(db.admin, c);
      expect(await sqlstate(db.admin.query("INSERT INTO item_photos (item_id, storage_provider, url) VALUES ($1,'cloudinary','http://x.invalid/a.jpg')", [i]))).toBe("23514");
      await db.admin.query("INSERT INTO item_photos (item_id, storage_provider, url, public_id) VALUES ($1,'cloudinary','https://res.cloudinary.com/x/a.jpg','a1')", [i]);
      expect(await sqlstate(db.admin.query("INSERT INTO item_photos (item_id, storage_provider, url, public_id) VALUES ($1,'cloudinary','https://res.cloudinary.com/x/b.jpg','a1')", [i]))).toBe("23505");
    });
  });
});
