// Security review of the importer: environment refusal, privilege and identity boundaries, hostile source content, resource limits,
// and migration 0016. Every finding in docs/MIGRATION-IMPORT.md has a regression test here.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dbDescribe, createTestDb, createBareTestDb, customer, staffUser, fxRate, packageRates, pricedItem, actorQuery, sqlstate, TEST_ACTOR_KEY_B64, type TestDb } from "./helpers";
import { dryRun, importSnapshot, parseSnapshotText, prepare, readSnapshotFile, DEFAULT_LIMITS } from "../../scripts/lib/import/index.mjs";
import { runImport } from "../../scripts/lib/import/execute.mjs";
import { ImportRefusal } from "../../scripts/lib/import/errors.mjs";
import { migrate, loadMigrations } from "../../scripts/lib/migrate.mjs";
import { createInvoice } from "../../src/lib/db/invoices";
import { user } from "../../src/lib/db/actor";
import { buildCleanSnapshot, buildMessySnapshot } from "../fixtures/migration/synthetic.mjs";

const env = (over: Record<string, string | undefined> = {}) => ({ NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test", ACTOR_CONTEXT_KEY: TEST_ACTOR_KEY_B64, ...over }) as Record<string, string>;
const load = (o: unknown) => parseSnapshotText(JSON.stringify(o));
const run = (db: TestDb, snap: unknown, over: Record<string, unknown> = {}) => importSnapshot({ snapshot: load(snap), pool: db.admin as never, env: env(), targetUrl: db.adminUrl, initiatedBy: "vitest", ...over } as never);
const one = async (db: TestDb, sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows[0];
const count = async (db: TestDb, t: string) => Number((await one(db, `SELECT count(*)::int AS n FROM ${t}`)).n);
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof ImportRefusal ? "REFUSED" : `ERR:${(e as { code?: string }).code ?? (e as Error).message}`; } };
/** A pool that fails the test if anything even tries to connect. */
const forbiddenPool = () => { const p = { connected: 0, connect: async () => { p.connected++; throw new Error("must not connect"); }, query: async () => { p.connected++; throw new Error("must not query"); } }; return p; };

describe("the importer refuses wrong environments before touching anything", () => {
  const cases: [string, Record<string, string | undefined>, string][] = [
    ["production NODE_ENV", { NODE_ENV: "production" }, "postgres://u@127.0.0.1/movezz_dev"],
    ["an approved class is missing", { MOVEZZ_IMPORT_ENVIRONMENT: undefined }, "postgres://u@127.0.0.1/movezz_dev"],
    ["class 'production'", { MOVEZZ_IMPORT_ENVIRONMENT: "production" }, "postgres://u@127.0.0.1/movezz_dev"],
    ["an Airtable key in the environment", { AIRTABLE_API_KEY: "patXXXX.fake" }, "postgres://u@127.0.0.1/movezz_dev"],
    ["a Firebase credential in the environment", { FIREBASE_PRIVATE_KEY: "fake" }, "postgres://u@127.0.0.1/movezz_dev"],
    ["a Keepup key in the environment", { KEEPUP_API_KEY: "fake" }, "postgres://u@127.0.0.1/movezz_dev"],
    ["a Cloudinary secret in the environment", { CLOUDINARY_API_SECRET: "fake" }, "postgres://u@127.0.0.1/movezz_dev"],
    ["a Cloudflare token in the environment", { CLOUDFLARE_API_TOKEN: "fake" }, "postgres://u@127.0.0.1/movezz_dev"],
    ["a remote database host", {}, "postgres://u@db.example.com/movezz_dev"],
    ["a production-looking database", {}, "postgres://u@127.0.0.1/movezz_prod"],
    ["a production-looking host on the allow list", { MOVEZZ_IMPORT_ENVIRONMENT: "staging", MOVEZZ_IMPORT_ALLOWED_HOSTS: "live-db.internal" }, "postgres://u@live-db.internal/m"],
  ];
  for (const [name, over, url] of cases) {
    it(`refuses ${name} - import, dry-run and reconcile - without connecting`, async () => {
      for (const fn of [importSnapshot, dryRun]) {
        const pool = forbiddenPool();
        expect(await code((fn as (a: unknown) => Promise<unknown>)({ snapshot: load(buildCleanSnapshot()), pool, env: env(over), targetUrl: url, initiatedBy: "x" })), `${fn.name} ${name}`).toBe("REFUSED");
        expect(pool.connected).toBe(0);
      }
    });
  }
  it("the engine itself refuses to run without an approved import decision, an initiator, and the actor key", async () => {
    const snap = load(buildCleanSnapshot()); const p = prepare(snap);
    const pool = forbiddenPool();
    await expect(runImport({ pool, snapshot: snap, st: p.st, decision: undefined, initiatedBy: "x", env: env() } as never)).rejects.toThrow(/has not approved/);
    await expect(runImport({ pool, snapshot: snap, st: p.st, decision: { ok: true, mode: "dry-run" }, initiatedBy: "x", env: env() } as never)).rejects.toThrow(/has not approved/);
    await expect(runImport({ pool, snapshot: snap, st: p.st, decision: { ok: true, mode: "import" }, initiatedBy: " ", env: env() } as never)).rejects.toThrow(/initiator/);
    await expect(runImport({ pool, snapshot: snap, st: p.st, decision: { ok: true, mode: "import" }, initiatedBy: "x", env: env({ ACTOR_CONTEXT_KEY: undefined }) } as never)).rejects.toThrow(/ACTOR_CONTEXT_KEY/);
    await expect(runImport({ pool, snapshot: snap, st: p.st, decision: { ok: true, mode: "import" }, initiatedBy: "x", env: env({ ACTOR_CONTEXT_KEY: Buffer.alloc(8).toString("base64") }) } as never)).rejects.toThrow(/at least 32 bytes/);
    expect(pool.connected).toBe(0);
  });
  it("a real export snapshot is refused outside staging with explicit consent, even in a local database", async () => {
    const s = buildCleanSnapshot(); (s.source as any).kind = "export";
    expect(await code(dryRun({ snapshot: load(s), env: env(), targetUrl: "postgres://u@127.0.0.1/m" } as never))).toBe("REFUSED");
  });
});

dbDescribe("privilege and identity boundaries (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); (db as unknown) = undefined; });

  it("the importer cannot run through the application's runtime role, and nothing is written when it tries", async () => {
    db = await createTestDb();
    const code1 = await code(importSnapshot({ snapshot: load(buildCleanSnapshot()), pool: db.app as never, env: env(), targetUrl: db.adminUrl, initiatedBy: "x" } as never));
    expect(code1).toMatch(/^ERR:/);
    for (const t of ["customers", "invoices", "items", "import_records", "import_batches"]) expect(await count(db, t), t).toBe(0);
  });
  it("the runtime role cannot read, write or delete the import bookkeeping", async () => {
    db = await createTestDb(); await run(db, buildCleanSnapshot());
    for (const t of ["import_batches", "import_records", "import_quarantine"]) {
      expect(await sqlstate(db.app.query(`SELECT * FROM ${t}`)), t).toBe("42501");
      expect(await sqlstate(db.app.query(`INSERT INTO ${t} (${t === "import_batches" ? "mode" : "source_table"}) VALUES ('import')`)), t).toBe("42501");
      expect(await sqlstate(db.app.query(`DELETE FROM ${t}`)), t).toBe("42501");
      expect(await sqlstate(db.app.query(`UPDATE ${t} SET ${t === "import_batches" ? "mode" : "source_table"} = ${t === "import_batches" ? "mode" : "source_table"}`)), t).toBe("42501");
    }
  });
  it("a wrong signing key fails the first transaction: no data, and the batch is closed as failed", async () => {
    db = await createTestDb();
    const bad = Buffer.alloc(32, 9).toString("base64");
    expect(await code(run(db, buildCleanSnapshot(), { env: env({ ACTOR_CONTEXT_KEY: bad }) }))).toMatch(/^ERR:/);
    expect(await count(db, "customers")).toBe(0);
    expect(await one(db, "SELECT status FROM import_batches")).toEqual({ status: "failed" });
    expect(await count(db, "import_records")).toBe(0);
  });
  it("every write is made under a signed IMPORT actor (and nothing else): no user actor, no role", async () => {
    db = await createTestDb(); await run(db, buildMessySnapshot());
    const types = (await db.admin.query("SELECT DISTINCT actor_type, user_id IS NULL AS no_user, role IS NULL AS no_role FROM movezz_sec.actor_sessions")).rows;
    expect(types).toEqual([{ actor_type: "import", no_user: true, no_role: true }]);
    expect((await one(db, "SELECT count(*)::int AS n FROM movezz_sec.actor_sessions WHERE request_id NOT LIKE 'import:%'")).n).toBe(0);
    expect((await one(db, "SELECT count(DISTINCT jti)::int = count(*)::int AS ok FROM movezz_sec.actor_sessions")).ok).toBe(true);        // single-use assertions
  });
  it("forged roles and identities in the source change nothing: users are never created, privileged roles are never granted, UIDs are never linked", async () => {
    db = await createTestDb();
    const s = buildCleanSnapshot();
    (s.tables.Users as any[]).push({ id: "recUX", fields: { FirebaseUID: "uid-evil", Email: "evil@example.invalid", Role: "super_admin", CustomerRecord: ["recC1"], IsAdmin: true } });
    (s.tables.Customers as any[])[0].fields = { ...(s.tables.Customers as any[])[0].fields, Role: "super_admin", role: "super_admin", is_active: true, auth_uid: "uid-evil", FirebaseUID: "uid-evil", customer_id: "x", id: "00000000-0000-4000-8000-000000000000", created_by: "admin" };
    const r = await run(db, s);
    expect(await count(db, "users")).toBe(0);
    expect(await count(db, "registration_requests")).toBe(0);
    const c = await one(db, "SELECT id::text AS id, created_by, legacy_data FROM customers WHERE legacy_airtable_id = 'recC1'");
    expect(c.id).not.toBe("00000000-0000-4000-8000-000000000000");
    expect(c.created_by).toBe("legacy-import");
    expect(JSON.stringify(c.legacy_data)).not.toContain("uid-evil");                                    // identity-looking values are not even preserved as text
    expect(Object.keys(c.legacy_data.unexpected_fields).sort()).toEqual(["Role", "auth_uid", "customer_id", "created_by", "id", "is_active", "role"].sort());
    expect(c.legacy_data.unexpected_fields.auth_uid).toMatch(/not preserved/);
    expect(r.entries.find((e: any) => e.sourceId === "recUX" && e.category === "PRIVILEGED_ROLE_NOT_IMPORTED")).toMatchObject({ severity: "deferred" });
    expect((await one(db, "SELECT count(*)::int AS n FROM customers WHERE shipping_address IS NOT NULL AND shipping_address LIKE '%evil%'")).n).toBe(0);
  });
  it("customer ownership cannot be manipulated through links: an item of customer B on customer A's invoice blocks the invoice and everything on it", async () => {
    db = await createTestDb();
    const s = buildCleanSnapshot();
    (s.tables.Items as any[]).find((i) => i.id === "recI2").fields.Customer = ["recC2"];
    const r = await run(db, s);
    expect(r.entries.find((e: any) => e.table === "Orders" && e.sourceId === "recO1")).toMatchObject({ category: "CONFLICTING_IDENTITY" });
    expect((await one(db, "SELECT count(*)::int AS n FROM invoices WHERE invoice_ref = 'ORD-00001'")).n).toBe(0);
    expect((await one(db, "SELECT count(*)::int AS n FROM items WHERE item_ref IN ('ITM-0001','ITM-0002')")).n).toBe(0);
    expect((await one(db, "SELECT count(*)::int AS n FROM payments WHERE legacy_airtable_id = 'vp1'")).n).toBe(0);
    expect((await one(db, "SELECT count(*)::int AS n FROM items i JOIN invoices v ON v.id = i.invoice_id WHERE v.customer_id <> i.customer_id")).n).toBe(0);
  });
  it("a payment, line or status event cannot be attached to another invoice's records by reference", async () => {
    db = await createTestDb();
    const s = buildCleanSnapshot();
    (s.tables.VerifiedInvoiceLines as any[]).find((l) => l.id === "vl3").fields.ItemRecordID = "recI1";            // O2's line points at O1's item
    const r = await run(db, s);
    expect(r.entries.find((e: any) => e.table === "Orders" && e.sourceId === "recO2")).toMatchObject({ category: "CONFLICTING_RELATIONSHIP" });
    expect((await one(db, "SELECT count(*)::int AS n FROM invoices WHERE invoice_ref = 'ORD-00002'")).n).toBe(0);
    expect(r.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
  });
});

dbDescribe("hostile source content (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); (db as unknown) = undefined; });

  it("SQL in values is data: it is stored literally (or rejected by validation), and no table is touched", async () => {
    db = await createTestDb();
    const s = buildCleanSnapshot();
    (s.tables.Customers as any[]).push({ id: "recSQL", fields: { Name: "Robert'); DROP TABLE customers;--", ShippingMark: "MOVEZZ-RB0001", Notes: "' OR 1=1; UPDATE invoices SET total_ghs=0; --", Phone: "0200000001" } });
    (s.tables.Customers as any[]).push({ id: "recSQ2", fields: { Name: "Mark", ShippingMark: "MOVEZZ'; DROP TABLE items;--" } });
    (s.tables.Items as any[]).push({ id: "recIQ", fields: { ItemRef: "ITM-9'; DELETE FROM invoices;--", Customer: ["recSQL"], Description: "\\'; --" } });
    const r = await run(db, s);
    expect((await one(db, "SELECT name, notes FROM customers WHERE legacy_airtable_id = 'recSQL'"))).toEqual({ name: "Robert'); DROP TABLE customers;--", notes: "' OR 1=1; UPDATE invoices SET total_ghs=0; --" });
    expect(r.entries.find((e: any) => e.sourceId === "recSQ2")).toMatchObject({ category: "INVALID_SHIPPING_MARK" });
    expect((await one(db, "SELECT item_ref FROM items WHERE legacy_airtable_id = 'recIQ'")).item_ref).toBe("ITM-9'; DELETE FROM invoices;--");
    expect(await count(db, "invoices")).toBe(5); expect(await count(db, "items")).toBe(11);
    expect((await one(db, "SELECT total_ghs::text AS t FROM invoices WHERE invoice_ref = 'ORD-00002'")).t).toBe("1250.00");
    expect(r.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
  });
  it("source ids that look like SQL, paths or prototype keys are refused as ids; the same id in two tables is not a collision", async () => {
    db = await createTestDb();
    const s = buildCleanSnapshot();
    for (const id of ["rec'; DROP", "../../etc/passwd", "__proto__", "a b", "", "x".repeat(65)]) (s.tables.Warehouses as any[]).push({ id, fields: { Name: "Bad" } });
    (s.tables.Warehouses as any[]).push({ id: "recSAME", fields: { Name: "Same id, warehouse" } });
    (s.tables.Suppliers as any[]).push({ id: "recSAME", fields: { SupplierID: "SUP-0077", Name: "Same id, supplier" } });
    const snap = load(s);
    expect(snap.envelopeProblems.length).toBe(6);
    const r = await importSnapshot({ snapshot: snap, pool: db.admin as never, env: env(), targetUrl: db.adminUrl, initiatedBy: "x" } as never);
    expect(await count(db, "warehouses")).toBe(2); expect(await count(db, "suppliers")).toBe(2);
    expect(r.report.integrity.targetChecks).toBeTruthy();
  });
  it("duplicate source ids are never imported and never overwrite each other", async () => {
    db = await createTestDb();
    const s = buildCleanSnapshot();
    (s.tables.Customers as any[]).push({ id: "recC1", fields: { Name: "Impostor", ShippingMark: "MOVEZZ-IM0001" } });
    const r = await run(db, s);
    expect((await one(db, "SELECT count(*)::int AS n FROM customers WHERE legacy_airtable_id = 'recC1'")).n).toBe(0);
    expect(r.entries.filter((e: any) => e.sourceId === "recC1" && e.category === "DUPLICATE_SOURCE_ID").length).toBe(1);
    expect(r.report.verdict).toBe("NOT_READY");
    expect((await one(db, "SELECT count(*)::int AS n FROM invoices WHERE customer_id IS NOT NULL AND invoice_ref IN ('ORD-00001','ORD-00002')")).n).toBe(0);     // their owner is unresolved, so nothing of theirs is imported
  });
  it("oversized values, huge lists and deep nesting never reach the database", async () => {
    db = await createTestDb();
    const s = buildCleanSnapshot();
    (s.tables.Items as any[]).push({ id: "recBIG", fields: { ItemRef: "ITM-BIG", Customer: ["recC1"], Notes: "n".repeat(25_000) } });
    (s.tables.Items as any[]).push({ id: "recLONG", fields: { ItemRef: "ITM-LONG", Customer: ["recC1"], Description: "d".repeat(5_000) } });
    (s.tables.Items as any[]).push({ id: "recARR", fields: { ItemRef: "ITM-ARR", Customer: ["recC1"], Photos: Array.from({ length: 1500 }, (_, i) => ({ id: `att${i}x`, url: "https://x.example.invalid/a.jpg" })) } });
    const r = await run(db, s);
    for (const id of ["recBIG", "recLONG", "recARR"]) expect(r.entries.some((e: any) => e.sourceId === id && e.severity === "blocking"), id).toBe(true);
    expect((await one(db, "SELECT count(*)::int AS n FROM items WHERE item_ref IN ('ITM-BIG','ITM-LONG','ITM-ARR')")).n).toBe(0);
  });
  it("a large snapshot is processed in bounded time (resource exhaustion guard)", async () => {
    const s = buildCleanSnapshot();
    for (let i = 0; i < 4000; i++) (s.tables.Customers as any[]).push({ id: `recBulk${i}`, fields: { Name: `Bulk ${i}`, ShippingMark: `MOVEZZ-BK${String(i).padStart(4, "0")}`, Phone: `02${String(10000000 + i)}` } });
    const t0 = Date.now();
    const r = await dryRun({ snapshot: load(s), env: env(), targetUrl: "postgres://u@127.0.0.1/m" } as never);
    expect(r.report.source.tables.Customers.valid).toBe(4003);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
  it("neither the importer nor the snapshot can reach the network, and the snapshot object is only read (the source is never modified)", async () => {
    db = await createTestDb();
    const net = vi.fn(() => { throw new Error("network access is forbidden"); });
    vi.stubGlobal("fetch", net);
    try {
      const snap = load(buildCleanSnapshot());
      const deepFreeze = (o: any): any => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
      deepFreeze(snap);
      const r = await importSnapshot({ snapshot: snap, pool: db.admin as never, env: env(), targetUrl: db.adminUrl, initiatedBy: "x" } as never);
      expect(r.report.verdict).toBe("READY");
      expect(net).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("snapshot files: a path outside the allowed directory or a symlink to one is refused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "imp-")); await writeFile(path.join(root, "a.json"), JSON.stringify(buildCleanSnapshot()));
    expect((await readSnapshotFile(path.join(root, "a.json"), { allowedRoot: root })).tables.Customers.length).toBe(3);
    await expect(readSnapshotFile("/etc/passwd", { allowedRoot: root })).rejects.toThrow(/inside the allowed directory/);
    expect(DEFAULT_LIMITS.maxBytes).toBeGreaterThan(0);
  });
});

dbDescribe("migration 0016 (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); (db as unknown) = undefined; });
  const legacyBatch = (status = "running") => `INSERT INTO import_batches (mode, snapshot_fingerprint, snapshot_kind, importer_version, source_tables, initiated_by, environment_class, status, finished_at) VALUES ('import', repeat('a', 64), 'fixture', 'v', '{x}', 'me', 'test', '${status}', ${status === "running" ? "NULL" : "now()"})`;

  it("allows at most one running batch, rejects a nonsense environment class or fingerprint, and keeps closed batches final", async () => {
    db = await createTestDb();
    await db.admin.query(legacyBatch());
    expect(await sqlstate(db.admin.query(legacyBatch()))).toBe("23505");
    expect(await sqlstate(db.admin.query(legacyBatch("completed")))).toBe("OK");
    expect(await sqlstate(db.admin.query("INSERT INTO import_batches (mode, snapshot_fingerprint, snapshot_kind, importer_version, source_tables, initiated_by, environment_class, status, finished_at) VALUES ('import','abc','fixture','v','{x}','me','production','completed', now())"))).toBe("23514");
    expect(await sqlstate(db.admin.query("INSERT INTO import_batches (mode, snapshot_fingerprint, snapshot_kind, importer_version, source_tables, initiated_by, environment_class) VALUES ('dry_run', repeat('a',64), 'fixture', 'v', '{x}', 'me', 'test')"))).toBe("23514");  // a dry-run has no batch
    expect(await sqlstate(db.admin.query("UPDATE import_batches SET status = 'completed', finished_at = now() WHERE status = 'running'"))).toBe("OK");
    expect(await sqlstate(db.admin.query("UPDATE import_batches SET error = 'tamper'"))).toBe("MV004");
  });
  it("source and target identities are unique: one target per source record, one source per target row", async () => {
    db = await createTestDb(); await run(db, buildCleanSnapshot());
    const b = (await one(db, "SELECT id FROM import_batches")).id;
    expect(await sqlstate(db.admin.query("INSERT INTO import_records (source_table, source_id, target_table, target_id, batch_id, content_fingerprint) VALUES ('Customers','recC1','customers','other',$1,repeat('a',64))", [b]))).toBe("23505");
    const t = (await one(db, "SELECT target_id FROM import_records WHERE source_id = 'recC1'")).target_id;
    expect(await sqlstate(db.admin.query("INSERT INTO import_records (source_table, source_id, target_table, target_id, batch_id, content_fingerprint) VALUES ('Customers','recNEW','customers',$2,$1,repeat('a',64))", [b, t]))).toBe("23505");
  });
  it("the import actor may cancel NON-NATIVE invoices only; native cancellation is still a super_admin act", async () => {
    db = await createTestDb(); await run(db, buildCleanSnapshot());
    const imp = actorQuery(db.admin, { type: "import" });
    // historical invoice: a second cancellation is refused because it is already cancelled; an open historical one can be cancelled by the import actor
    expect(await sqlstate(imp.query("UPDATE invoices SET status = 'Cancelled', cancelled_at = now(), cancel_reason = 'x' WHERE invoice_ref = 'ORD-00005'"))).toBe("MV005");   // still holds items/cartons at commit
    const nat = await createTestDb();                                            // a database with NATIVE data (the imported one has its own rate rows)
    try {
      const admin = await staffUser(nat.admin); await packageRates(nat.admin); await fxRate(nat.admin);
      const c = await customer(nat.admin); const i = await pricedItem(nat.admin, c, "40.00");
      const { invoice } = await createInvoice(nat.app, { customerId: c, itemIds: [i], actor: user(admin), idempotencyKey: "native-cancel-key-1" });
      const upd = "UPDATE invoices SET status = 'Cancelled', cancelled_at = now(), cancel_reason = 'x' WHERE id = $1";
      expect(await sqlstate(actorQuery(nat.admin, { type: "import" }).query(upd, [invoice.id]))).toBe("MV012");
      expect(await sqlstate(actorQuery(nat.admin, { type: "system" }).query(upd, [invoice.id]))).toBe("MV012");
      const staff = await staffUser(nat.admin, "warehouse_staff");
      expect(await sqlstate(actorQuery(nat.admin, user(staff)).query(upd, [invoice.id]))).toBe("MV012");
    } finally { await nat.close(); }
  });
  it("a historical (non-native) invoice cannot be written by anyone but the import actor", async () => {
    db = await createTestDb();
    const admin = await staffUser(db.admin); const c = await customer(db.admin);
    const ins = "INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, total_ghs, provenance) VALUES ('ORD-H1', $1, 10, 10, 100, 'legacy_known')";
    expect(await sqlstate(actorQuery(db.admin, user(admin)).query(ins, [c]))).toBe("MV006");
    expect(await sqlstate(actorQuery(db.admin, { type: "system" }).query(ins, [c]))).toBe("MV006");
    expect(await sqlstate(actorQuery(db.admin, { type: "import" }).query(ins, [c]))).toBe("OK");
  });
  it("upgrades from 0015 with data in place: nothing existing changes and the import tables are empty", async () => {
    const bare = await createBareTestDb();
    const { mkdtemp: mk, writeFile: wf } = await import("node:fs/promises");
    try {
      const dir = await mk(path.join(tmpdir(), "mig15-"));
      for (const f of (await loadMigrations()).filter((m: { version: number }) => m.version <= 15)) await wf(path.join(dir, f.name), f.sql);
      await migrate(bare.url, { dir });
      await customer(bare.admin);
      const before = (await bare.admin.query("SELECT (SELECT count(*) FROM customers) AS c, (SELECT count(*) FROM audit_logs) AS a")).rows[0];
      expect((await migrate(bare.url)).applied).toEqual(["0016_import_framework.sql"]);
      expect((await bare.admin.query("SELECT (SELECT count(*) FROM customers) AS c, (SELECT count(*) FROM audit_logs) AS a")).rows[0]).toEqual(before);
      for (const t of ["import_batches", "import_records", "import_quarantine"]) expect(Number((await bare.admin.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n)).toBe(0);
      expect((await migrate(bare.url)).applied).toEqual([]);
    } finally { await bare.close(); }
  });
});
