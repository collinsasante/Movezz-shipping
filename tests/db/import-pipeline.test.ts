// The importer against a real PostgreSQL (disposable local test server): dry-run, import, idempotency, crash/resume, reconciliation,
// historical financial handling, identity safety and failure isolation. The only data is the SYNTHETIC fixtures.
import { it, expect, afterEach } from "vitest";
import { dbDescribe, createTestDb, customer, sqlstate, TEST_ACTOR_KEY_B64, type TestDb } from "./helpers";
import { dryRun, importSnapshot, reconcileSnapshot, parseSnapshotText, databaseSignature, reportToJson } from "../../scripts/lib/import/index.mjs";
import { buildCleanSnapshot, buildMessySnapshot } from "../fixtures/migration/synthetic.mjs";

const env = (over: Record<string, string> = {}): Record<string, string> => ({ NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test", ACTOR_CONTEXT_KEY: TEST_ACTOR_KEY_B64, ...over });
const load = (o: unknown) => parseSnapshotText(JSON.stringify(o));
const run = (db: TestDb, snap: unknown, over: Record<string, unknown> = {}) => importSnapshot({ snapshot: load(snap), pool: db.admin as never, env: env(), targetUrl: db.adminUrl, initiatedBy: "vitest", ...over } as never);
const dry = (db: TestDb, snap: unknown) => dryRun({ snapshot: load(snap), pool: db.admin as never, env: env(), targetUrl: db.adminUrl });
const sig = async (db: TestDb) => { const c = await db.admin.connect(); try { return await databaseSignature(c); } finally { c.release(); } };
const one = async (db: TestDb, sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows[0];
const rows = async (db: TestDb, sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
const count = async (db: TestDb, table: string) => Number((await one(db, `SELECT count(*)::int AS n FROM ${table}`)).n);

/** Full-content checksum of every table (ids and timestamps included) - proves a dry-run changed nothing at all. */
async function everything(db: TestDb) {
  const tables = (await rows(db, "SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'movezz_sec') ORDER BY 1, 2"));
  const out: Record<string, string> = {};
  for (const { s, t } of tables) {
    if (t === "actor_keys") continue;
    const r = await one(db, `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) AS h FROM ${s}.${t} x`);
    out[`${s}.${t}`] = `${r.n}:${r.h}`;
  }
  return out;
}
const seqState = async (db: TestDb) => (await rows(db, "SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1")).map((r) => `${r.sequencename}=${r.last_value}`).join(",");

dbDescribe("dry-run is first class and writes nothing (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); });

  it("changes nothing at all - not a row, not a sequence, not a counter, not an actor session - and can be repeated with an identical report", async () => {
    db = await createTestDb();
    await customer(db.admin);                                              // pre-existing target data
    await import("./helpers").then((h) => h.fxRate(db.admin));
    const before = await everything(db); const seqBefore = await seqState(db);
    const r1 = await dry(db, buildMessySnapshot()); const r2 = await dry(db, buildMessySnapshot()); const r3 = await dry(db, buildMessySnapshot());
    expect(await everything(db)).toEqual(before);
    expect(await seqState(db)).toBe(seqBefore);
    expect(reportToJson(r2.report)).toBe(reportToJson(r1.report));
    expect(reportToJson(r3.report)).toBe(reportToJson(r1.report));
    expect(r1.report.verdict).toBe("NOT_READY");
    expect(r1.report.scope).toBe("source");
    expect(await count(db, "import_batches")).toBe(0);
    expect(await count(db, "import_records")).toBe(0);
    expect(await count(db, "import_quarantine")).toBe(0);
  });

  it("issues only reads, inside a READ ONLY transaction that is rolled back (statement audit)", async () => {
    db = await createTestDb();
    const seen: string[] = [];
    const spy = { connect: async () => { const c = await db.admin.connect(); const q = c.query.bind(c); (c as any).query = (text: any, ...a: any[]) => { seen.push(typeof text === "string" ? text : text.text); return (q as any)(text, ...a); }; return c; } };
    await dryRun({ snapshot: load(buildCleanSnapshot()), pool: spy as never, env: env(), targetUrl: db.adminUrl });
    expect(seen[0]).toBe("BEGIN READ ONLY");
    expect(seen[seen.length - 1]).toBe("ROLLBACK");
    for (const s of seen.slice(1, -1)) expect(s.trim(), s).toMatch(/^SELECT\b/i);
    expect(seen.join("\n")).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|nextval|begin_actor|allocate_|seed_reference/i);
  });

  it("the READ ONLY transaction really rejects writes at the database", async () => {
    db = await createTestDb();
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN READ ONLY");
      expect(await sqlstate(c.query("INSERT INTO warehouses (name) VALUES ('x')"))).toBe("25006");
      await c.query("ROLLBACK");
    } finally { c.release(); }
  });

  it("works completely offline (no database) and reports the same source numbers", async () => {
    const off = await dryRun({ snapshot: load(buildMessySnapshot()), env: env() });
    db = await createTestDb();
    const on = await dry(db, buildMessySnapshot());
    expect(off.report.source).toEqual(on.report.source);
    expect(off.report.integrity).toEqual(on.report.integrity);
  });

  it("detects what would collide with data already in the target and quarantines it (shipping mark, invoice reference), without writing", async () => {
    db = await createTestDb();
    await db.admin.query("INSERT INTO customers (name, shipping_mark, phone) VALUES ('Native Person', 'MOVEZZ-AM1234', '0200000000')");
    const r = await dry(db, buildCleanSnapshot());
    const e = r.entries.filter((x: any) => x.severity === "blocking");
    expect(e.find((x: any) => x.sourceId === "recC1")).toMatchObject({ category: "CONFLICTING_IDENTITY", table: "Customers" });
    expect(e.some((x: any) => x.table === "Orders" && x.category === "CUSTOMER_QUARANTINED")).toBe(true);        // its invoices cannot be imported either
    expect(r.report.verdict).toBe("NOT_READY");
    expect(await count(db, "customers")).toBe(1);
  });

  it("clean synthetic data gives READY for the source, with the exact expected numbers", async () => {
    db = await createTestDb();
    const r = await dry(db, buildCleanSnapshot());
    expect(r.report).toMatchObject({ verdict: "READY", scope: "source" });
    expect(r.report.source.totals).toMatchObject({ quarantined: 0, duplicated: 0, unresolved: 0 });
    expect(r.report.financial!).toMatchObject({ invoices: 5, totalGhs: "13187.50", paidGhs: "9250.00", cancelledInvoices: 1, discrepancies: [] });
    expect(r.report.financial!.outstandingGhs).toBe("2937.50");                    // O2 750.00 + O5 2187.50 (paid, zero-value and cancelled invoices owe nothing)
  });
});

dbDescribe("import of the clean synthetic snapshot (PostgreSQL)", () => {
  let db: TestDb; let res: Awaited<ReturnType<typeof run>>;
  const setup = async () => { db = await createTestDb(); res = await run(db, buildCleanSnapshot()); };
  afterEach(async () => { await db?.close(); });

  it("imports everything, reconciles exactly (every check), and the report says READY for the target", async () => {
    await setup();
    expect(res.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(res.report).toMatchObject({ verdict: "READY", scope: "target", reasons: [] });
    expect(res.report.postgres).toMatchObject({ imported: 46, failed: 0, skippedAlreadyImported: 0, reconciledChecks: { passed: res.reconcile.checks.length, total: res.reconcile.checks.length } });
    expect(res.report.financial!).toMatchObject({ totalGhs: "13187.50", paidGhs: "9250.00", outstandingGhs: "2937.50", cancelledInvoices: 1, mismatches: [] });
    expect(await count(db, "customers")).toBe(3); expect(await count(db, "items")).toBe(10); expect(await count(db, "cartons")).toBe(2);
    expect(await count(db, "invoices")).toBe(5); expect(await count(db, "payments")).toBe(3); expect(await count(db, "invoice_lines")).toBe(6);
    expect(await count(db, "containers")).toBe(2); expect(await count(db, "item_photos")).toBe(2);
  });

  it("records the batch immutably: snapshot, importer version, initiator, environment, tables, counts, completion", async () => {
    await setup();
    const b = await one(db, "SELECT * FROM import_batches");
    expect(b).toMatchObject({ mode: "import", snapshot_kind: "fixture", snapshot_label: "synthetic-clean", importer_version: "7I.1", initiated_by: "vitest", environment_class: "test", status: "completed" });
    expect(b.snapshot_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.source_tables).toContain("Customers"); expect(b.finished_at).not.toBeNull();
    expect(b.counts.perTable.Customers).toEqual({ imported: 3, skipped: 0, failed: 0 });
    expect(await sqlstate(db.admin.query("UPDATE import_batches SET initiated_by = 'someone else'"))).toBe("MV004");
    expect(await sqlstate(db.admin.query("UPDATE import_batches SET status = 'running', finished_at = NULL"))).toBe("MV004");
    expect(await sqlstate(db.admin.query("DELETE FROM import_batches"))).toBe("MV004");
    expect(await sqlstate(db.admin.query("TRUNCATE import_batches CASCADE"))).toMatch(/MV004|0A000/);
    expect(await sqlstate(db.admin.query("UPDATE import_records SET target_id = 'x'"))).toBe("MV004");
    expect(await sqlstate(db.admin.query("DELETE FROM import_records"))).toBe("MV004");
    expect(await sqlstate(db.admin.query("DELETE FROM import_quarantine"))).toBe("MV004");
  });

  it("keeps every imported row traceable to its Airtable record without touching business identifiers", async () => {
    await setup();
    const m = await rows(db, "SELECT source_table, source_id, target_table FROM import_records WHERE source_table IN ('Customers','Orders','Items','VerifiedPayments') ORDER BY 1, 2");
    expect(m.filter((x) => x.source_table === "Customers").map((x) => x.source_id)).toEqual(["recC1", "recC2", "recC3"]);
    const c = await one(db, "SELECT c.legacy_airtable_id, c.shipping_mark, c.legacy_data FROM customers c JOIN import_records r ON r.target_id = c.id::text WHERE r.source_id = 'recC1'");
    expect(c).toMatchObject({ legacy_airtable_id: "recC1", shipping_mark: "MOVEZZ-AM1234" });
    expect(c.legacy_data).toMatchObject({ source_table: "Customers", source_id: "recC1" });
    expect((await one(db, "SELECT invoice_ref FROM invoices WHERE legacy_airtable_id = 'recO2'")).invoice_ref).toBe("ORD-00002");   // business ids are the source's own
    expect(await count(db, "import_records")).toBe(46);
  });

  it("preserves the historical financial snapshot exactly: frozen FX, totals, discount + reason, provenance, Keepup sale id", async () => {
    await setup();
    const inv = await one(db, "SELECT * FROM invoices WHERE invoice_ref = 'ORD-00002'");
    expect(inv).toMatchObject({ subtotal_usd: "100.00", discount_usd: "0.00", total_usd: "100.00", fx_rate: "12.50000000", total_ghs: "1250.00", amount_paid_ghs: "500.00", balance_ghs: "750.00", status: "Partial",
      provenance: "legacy_known", keepup_sale_id: "KU-1001", fx_rate_id: null, fx_estimated: false, created_by: null, cancelled_by: null });
    const zero = await one(db, "SELECT * FROM invoices WHERE invoice_ref = 'ORD-00004'");
    expect(zero).toMatchObject({ subtotal_usd: "50.00", discount_usd: "50.00", discount_reason: "Approved waiver by management", total_ghs: "0.00", status: "Paid", amount_paid_ghs: "0.00" });
    expect(await count(db, "payments")).toBe(3);
    expect((await one(db, "SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1", [zero.id])).n).toBe(0);                           // zero-value: Paid, no payment row
    const lines = await rows(db, "SELECT line_no, unit_price_usd::text AS u, l.provenance FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.invoice_ref = 'ORD-00001' ORDER BY line_no");
    expect(lines).toEqual([{ line_no: 1, u: "350.00", provenance: "legacy_known" }, { line_no: 2, u: "350.00", provenance: "legacy_known" }]);
  });

  it("imports a cancelled invoice as cancelled with its voided payment, released items, the verified cancellation time and no invented user", async () => {
    await setup();
    const inv = await one(db, "SELECT * FROM invoices WHERE invoice_ref = 'ORD-00003'");
    expect(inv).toMatchObject({ status: "Cancelled", cancel_reason: "Customer changed their mind", cancelled_by: null, amount_paid_ghs: "0.00", total_ghs: "1000.00" });
    expect(inv.cancelled_at.toISOString()).toBe("2026-02-01T10:00:00.000Z");
    const p = await one(db, "SELECT * FROM payments WHERE invoice_id = $1", [inv.id]);
    expect(p).toMatchObject({ status: "voided", amount_ghs: "400.00", source: "import", void_reason: "Entered on the wrong invoice", created_by: null, voided_by: null });
    expect(p.paid_at.toISOString()).toBe("2026-01-31T09:00:00.000Z"); expect(p.voided_at.toISOString()).toBe("2026-01-31T15:00:00.000Z");
    expect((await one(db, "SELECT invoice_id FROM items WHERE item_ref = 'ITM-0004'")).invoice_id).toBeNull();                                // released, like a cancellation
    expect(await count(db, "invoice_lines")).toBe(6);                                                                                         // its line (history) is kept
    expect((await one(db, "SELECT count(*)::int AS n FROM invoice_lines WHERE invoice_id = $1", [inv.id])).n).toBe(1);
  });

  it("derives cartons: invoiced carton on its invoice, open carton in its container, members linked, carton prices from the shares", async () => {
    await setup();
    const c1 = await one(db, "SELECT c.*, i.invoice_ref FROM cartons c LEFT JOIN invoices i ON i.id = c.invoice_id WHERE c.carton_ref = 'CTN-0001'");
    expect(c1).toMatchObject({ status: "invoiced", invoice_ref: "ORD-00005", freight_type: "sea", price_usd: "175.00", package_tier: "basic", dimension_unit: "cm" });
    expect(Number(c1.cbm)).toBeCloseTo(0.5, 6);                                                                                              // CBM stays database-generated
    expect((await rows(db, "SELECT item_ref FROM items WHERE carton_id = $1 ORDER BY 1", [c1.id])).map((r) => r.item_ref)).toEqual(["ITM-0006", "ITM-0007"]);
    expect((await one(db, "SELECT tier_price_usd::text AS p FROM items WHERE item_ref = 'ITM-0006'")).p).toBe("100.00");                      // pre-carton price, not the overwritten share
    const c3 = await one(db, "SELECT c.status, k.container_ref FROM cartons c JOIN containers k ON k.id = c.container_id WHERE c.carton_ref = 'CTN-0003'");
    expect(c3).toEqual({ status: "open", container_ref: "PMX-CON-2026-002" });
  });

  it("keeps customers as they were: inactive stays inactive (not archived), shipping marks are preserved, no identity is created", async () => {
    await setup();
    expect(await one(db, "SELECT status, archived_at FROM customers WHERE shipping_mark = 'MOVEZZ-YA0000'")).toEqual({ status: "inactive", archived_at: null });
    expect((await rows(db, "SELECT shipping_mark FROM customers ORDER BY 1")).map((r) => r.shipping_mark)).toEqual(["MOVEZZ-AM1234", "MOVEZZ-KB5678", "MOVEZZ-YA0000"]);
    expect(await count(db, "users")).toBe(0);
    expect(await count(db, "registration_requests")).toBe(0);
    expect((await one(db, "SELECT legacy_data FROM customers WHERE shipping_mark = 'MOVEZZ-AM1234'")).legacy_data).not.toHaveProperty("firebase_uid");
  });

  it("special rates keep the ambiguity mark; special items keep their legacy snapshot and are not tied to a card", async () => {
    await setup();
    expect(await one(db, "SELECT provenance, customer_id, sea_rate_usd::text AS sea, provenance_note FROM special_rates")).toMatchObject({ provenance: "legacy_ambiguous", customer_id: null, sea: "300.0000" });
    const it = await one(db, "SELECT billing_basis, special_rate_id, special_rate_name, special_price_usd::text AS p FROM items WHERE item_ref = 'ITM-0017'");
    expect(it).toEqual({ billing_basis: "special", special_rate_id: null, special_rate_name: "VIP Gold", p: "57.60" });
  });

  it("imports history as history: source timestamps, source identity, actor type import, no user - and distinguishable from live events", async () => {
    await setup();
    const e = await one(db, "SELECT * FROM status_events WHERE legacy_airtable_id = 'recH1'");
    expect(e).toMatchObject({ entity_type: "item", old_status: "Shipped to Ghana", new_status: "Arrived in Ghana", actor_type: "import", actor_user_id: null, legacy_record_ref: "recI1" });
    expect(e.occurred_at.toISOString()).toBe("2026-02-21T09:00:00.000Z");
    expect(e.metadata).toMatchObject({ legacy: true, source_id: "recH1", changed_by: "staff@example.invalid", changed_by_role: "warehouse_staff" });
    const a = await one(db, "SELECT * FROM audit_logs WHERE action = 'legacy:CREATE_ITEM'");
    expect(a).toMatchObject({ actor_type: "import", actor_user_id: null, entity_type: "Item", ip_address: "203.0.113.7" });
    expect(a.created_at.toISOString()).toBe("2026-01-12T08:30:00.000Z");
    expect(a.after_data.legacy).toMatchObject({ user_email: "staff@example.invalid", source_id: "recA1", entity_source_id: "recI1" });
    expect(a.entity_id).toBe((await one(db, "SELECT id::text AS id FROM items WHERE item_ref = 'ITM-0001'")).id);                              // resolved to the NEW id
    expect(await count(db, "audit_logs")).toBe(2);
    expect((await one(db, "SELECT count(*)::int AS n FROM audit_logs WHERE actor_type <> 'import' OR actor_user_id IS NOT NULL")).n).toBe(0);
    expect((await one(db, "SELECT count(*)::int AS n FROM status_events WHERE actor_user_id IS NOT NULL")).n).toBe(0);
  });

  it("has no side effects outside the data: no Keepup sync rows, no notifications, no users, no idempotency keys", async () => {
    await setup();
    for (const t of ["keepup_sync", "notification_outbox", "users", "idempotency_keys", "registration_requests"]) expect(await count(db, t), t).toBe(0);
    expect(res.reconcile.security).toEqual(Object.fromEntries(Object.keys(res.reconcile.security).map((k) => [k, 0])));
  });

  it("seeds the reference counters above everything imported, so the next NATIVE record cannot collide", async () => {
    await setup();
    const next = async (type: string, scope = "") => (await one(db, "SELECT allocate_reference($1, $2) AS r", [type, scope])).r;
    expect(await next("item")).toBe("ITM-0032");
    expect(await next("invoice")).toBe("ORD-00006");
    expect(await next("supplier")).toBe("SUP-0002");
    expect(await next("carton")).toBe("CTN-0004");
    expect((await one(db, "SELECT allocate_container_reference(2026) AS r")).r).toBe("PMX-CON-2026-003");
  });

  it("an imported invoice is immutable and frozen like any other: no re-pricing, no edits, no payments on the cancelled one", async () => {
    await setup();
    expect(await sqlstate(db.admin.query("UPDATE invoices SET total_ghs = 1 WHERE invoice_ref = 'ORD-00002'"))).toMatch(/MV004|MV007/);
    const { actorQuery } = await import("./helpers");
    expect(await sqlstate(actorQuery(db.admin, { type: "import" }).query("UPDATE invoices SET total_ghs = 1 WHERE invoice_ref = 'ORD-00002'"))).toBe("MV004");
    expect(await sqlstate(actorQuery(db.admin, { type: "import" }).query("UPDATE invoices SET notes = 'x' WHERE invoice_ref = 'ORD-00003'"))).toBe("MV004");
    expect(await sqlstate(actorQuery(db.admin, { type: "import" }).query("INSERT INTO payments (invoice_id, amount_ghs, source) SELECT id, 1, 'manual' FROM invoices WHERE invoice_ref = 'ORD-00003'"))).toBe("MV005");
  });
});

dbDescribe("import of the messy synthetic snapshot (PostgreSQL)", () => {
  let db: TestDb; let res: Awaited<ReturnType<typeof run>>;
  afterEach(async () => { await db?.close(); });
  const setup = async () => { db = await createTestDb(); res = await run(db, buildMessySnapshot()); };

  it("imports the valid records, quarantines the rest durably, loses nothing silently, and still reconciles exactly", async () => {
    await setup();
    expect(res.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(res.report.verdict).toBe("NOT_READY");
    const r = res.report;
    const t = r.source.totals;
    expect(t.discovered).toBe(t.valid + t.quarantined + t.deferred);
    const imported = await count(db, "import_records");
    expect(imported).toBe(r.postgres.imported);
    const q = await rows(db, "SELECT severity, count(*)::int AS n FROM import_quarantine GROUP BY 1 ORDER BY 1");
    expect(Object.fromEntries(q.map((x) => [x.severity, x.n]))).toMatchObject({ blocking: expect.any(Number), review: expect.any(Number), deferred: expect.any(Number) });
    expect(await count(db, "import_quarantine")).toBe(res.entries.length);
    // every quarantined record carries table, source id, category, severity, reason and the batch
    const sample = await one(db, "SELECT * FROM import_quarantine WHERE category = 'DUPLICATE_CONTAINER' AND source_id = 'recK3'");
    expect(sample).toMatchObject({ source_table: "Containers", severity: "blocking", batch_id: (await one(db, "SELECT id FROM import_batches")).id });
    expect(sample.reason).toMatch(/share the reference/);
  });

  it("does not import quarantined records, invent placeholder parents, or leak their children", async () => {
    await setup();
    expect(await count(db, "customers")).toBe(7);                                           // C1 C2 C3 C10 C11 C12 C14 (C4/C5 duplicate, C6-C9, C13 invalid)
    expect((await rows(db, "SELECT shipping_mark FROM customers ORDER BY 1")).map((r) => r.shipping_mark)).toEqual(["MOVEZZ-AM1234", "MOVEZZ-EF0007", "MOVEZZ-HL0008", "MOVEZZ-KB5678", "MOVEZZ-YA0000", "OLD-MARK-77", "PAKKMAXX-ADWOA-9013"]);
    expect(await count(db, "containers")).toBe(2);
    expect((await one(db, "SELECT count(*)::int AS n FROM invoices WHERE invoice_ref IN ('ORD-00006','ORD-00007','ORD-00008','ORD-00009','ORD-00012','ORD-00013')")).n).toBe(0);
    expect((await one(db, "SELECT count(*)::int AS n FROM items WHERE item_ref IN ('ITM-0008','ITM-0009','ITM-0010','ITM-0013','ITM-0014','ITM-0015','ITM-0016','ITM-0900')")).n).toBe(0);
    expect(await count(db, "invoices")).toBe(7);                                              // O1-O5 + O10 (estimated) + O11 (claim mismatch)
    expect((await one(db, "SELECT count(*)::int AS n FROM payments WHERE legacy_airtable_id IN ('vp4','vp5','vp6','vp7','vp8','vp9','vp10')")).n).toBe(0);
    expect(await count(db, "users")).toBe(0);
  });

  it("estimated FX is labelled estimated and explained; a mismatching claim is imported as verified and REPORTED, not repaired", async () => {
    await setup();
    expect(await one(db, "SELECT provenance, provenance_note, fx_estimated, fx_rate::text AS fx, total_ghs::text AS t FROM invoices WHERE invoice_ref = 'ORD-00010'")).toMatchObject({ provenance: "estimated", fx_estimated: true, fx: "12.00000000", t: "500.00" });
    expect((await one(db, "SELECT provenance_note FROM invoices WHERE invoice_ref = 'ORD-00010'")).provenance_note).toMatch(/Rate estimated from the nearest Keepup invoice day/);
    expect(await one(db, "SELECT status, amount_paid_ghs::text AS p FROM invoices WHERE invoice_ref = 'ORD-00011'")).toEqual({ status: "Pending", p: "0.00" });   // Airtable claimed Paid/100: not copied
    const d = res.report.financial!.discrepancies.map((x: any) => `${x.invoice}:${x.category}`).sort();
    expect(d).toEqual(["ORD-00011:BALANCE_MISMATCH", "ORD-00011:PAID_AMOUNT_MISMATCH", "ORD-00011:STATUS_MISMATCH"].sort().filter((x) => x !== "ORD-00011:BALANCE_MISMATCH").concat(d.includes("ORD-00011:BALANCE_MISMATCH") ? ["ORD-00011:BALANCE_MISMATCH"] : []).sort());
    expect(res.report.reasons.join(" ")).toMatch(/financial discrepanc/);
  });

  it("photos: valid https attachments are imported with their provider; bad and duplicate attachments are quarantined individually", async () => {
    await setup();
    expect((await rows(db, "SELECT legacy_attachment_id, storage_provider FROM item_photos ORDER BY 1")).map((r) => `${r.legacy_attachment_id}:${r.storage_provider}`)).toEqual(["attAAA111:airtable", "attBBB222:cloudinary"]);
    const bad = (await rows(db, "SELECT source_id, category FROM import_quarantine WHERE source_table = 'ItemPhotos' ORDER BY 1")).map((r) => `${r.source_id}:${r.category}`);
    expect(bad.some((x) => x.includes("recI25#photo:1:INVALID_PHOTO"))).toBe(true);
  });

  it("the unexpected fields and the item's own odd values are preserved (bounded) rather than dropped", async () => {
    await setup();
    expect((await one(db, "SELECT legacy_data FROM customers WHERE shipping_mark = 'MOVEZZ-EF0007'")).legacy_data.unexpected_fields).toEqual({ VIPLevel: "gold", Mood: "good" });
  });

  it("a hostile record neither pollutes the importer nor reaches the database", async () => {
    await setup();
    expect(({} as any).isAdmin).toBeUndefined();
    expect((await one(db, "SELECT count(*)::int AS n FROM items WHERE item_ref IN ('ITM-0027','ITM-0028')")).n).toBe(0);
    expect((await one(db, "SELECT count(*)::int AS n FROM import_quarantine WHERE category = 'UNSAFE_CONTENT'")).n).toBe(2);
  });
});

dbDescribe("historical values are never recalculated (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); });

  it("current FX, package rates and special rates in the target do not change a single historical amount", async () => {
    db = await createTestDb();
    await import("./helpers").then(async (h) => { await h.fxRate(db.admin, "99.00000000"); await h.packageRates(db.admin, "basic", "9999", "999"); });
    await run(db, buildCleanSnapshot()).catch((e) => { throw e; });
    const inv = await rows(db, "SELECT invoice_ref, fx_rate::text AS fx, total_ghs::text AS t, subtotal_usd::text AS s FROM invoices ORDER BY 1");
    expect(inv.map((r) => `${r.invoice_ref}:${r.fx}:${r.s}:${r.t}`)).toEqual([
      "ORD-00001:12.50000000:700.00:8750.00", "ORD-00002:12.50000000:100.00:1250.00", "ORD-00003:12.50000000:80.00:1000.00", "ORD-00004:12.50000000:50.00:0.00", "ORD-00005:12.50000000:175.00:2187.50"]);
    expect((await one(db, "SELECT tier_price_usd::text AS p, tier_rate_usd::text AS r FROM items WHERE item_ref = 'ITM-0001'"))).toEqual({ p: "350.00", r: "350.0000" });   // not 9999
  });

  it("the Settings rate becomes the CURRENT rate row only; it is never applied to old invoices; a missing/invalid rate is quarantined, never 1", async () => {
    db = await createTestDb();
    const res = await run(db, buildCleanSnapshot());
    expect(await one(db, "SELECT rate::text AS r, source, base_currency, quote_currency FROM fx_rates")).toEqual({ r: "12.50000000", source: "airtable-settings", base_currency: "USD", quote_currency: "GHS" });
    expect((await one(db, "SELECT count(*)::int AS n FROM invoices WHERE fx_rate_id IS NOT NULL")).n).toBe(0);
    expect(res.report.verdict).toBe("READY");
    const bad = buildCleanSnapshot(); (bad.tables.Settings as any[])[0].fields.UsdToGhs = 0;
    const db2 = await createTestDb();
    try {
      const r2 = await run(db2, bad);
      expect(await count(db2, "fx_rates")).toBe(0);
      expect(r2.entries.some((e: any) => e.table === "Settings" && e.category === "INVALID_FX")).toBe(true);
    } finally { await db2.close(); }
  });

  it("an invoice whose financial proof is missing or inconsistent is NOT imported, and neither are its items (no recomputation, no guessing)", async () => {
    db = await createTestDb();
    const s = buildCleanSnapshot(); (s.tables.VerifiedInvoices as any[]).find((v) => v.fields.OrderRecordID === "recO2").fields.TotalGhs = 1249;
    const res = await run(db, s);
    expect(await count(db, "invoices")).toBe(4);
    expect((await one(db, "SELECT count(*)::int AS n FROM items WHERE item_ref = 'ITM-0003'")).n).toBe(0);
    expect((await one(db, "SELECT count(*)::int AS n FROM payments WHERE legacy_airtable_id = 'vp2'")).n).toBe(0);
    expect(res.report.verdict).toBe("NOT_READY");
    expect(res.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
  });
});

dbDescribe("idempotency, crash and resume (PostgreSQL)", () => {
  let dbs: TestDb[] = [];
  const fresh = async () => { const d = await createTestDb(); dbs.push(d); return d; };
  afterEach(async () => { await Promise.all(dbs.map((d) => d.close())); dbs = []; });

  it("importing the same snapshot twice imports nothing the second time and leaves the database identical", async () => {
    const db = await fresh();
    const first = await run(db, buildMessySnapshot()); const s1 = await sig(db); const all1 = await everything(db);
    const second = await run(db, buildMessySnapshot());
    expect(await sig(db)).toBe(s1);
    expect(second.report.postgres).toMatchObject({ imported: 0, failed: 0 });
    expect(second.report.postgres.skippedAlreadyImported).toBe(first.report.postgres.imported);
    expect(second.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
    const a = await everything(db);
    for (const t of ["customers", "items", "invoices", "invoice_lines", "payments", "status_events", "audit_logs", "cartons", "containers", "item_photos", "import_records"]) expect(a[`public.${t}`], t).toBe(all1[`public.${t}`]);
    expect(await count(db, "import_batches")).toBe(2);
    expect((await rows(db, "SELECT status FROM import_batches ORDER BY started_at")).map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("no duplicate customers, invoices, payments, containers, cartons, items, status history or audit records after any number of runs", async () => {
    const db = await fresh();
    for (let i = 0; i < 3; i++) await run(db, buildCleanSnapshot());
    const dup = async (sql: string) => Number((await one(db, sql)).n);
    expect(await dup("SELECT count(*)::int AS n FROM (SELECT legacy_airtable_id FROM customers GROUP BY 1 HAVING count(*) > 1) x")).toBe(0);
    expect(await dup("SELECT count(*)::int AS n FROM (SELECT legacy_airtable_id FROM payments GROUP BY 1 HAVING count(*) > 1) x")).toBe(0);
    expect(await count(db, "status_events") - 0).toBe(await dup("SELECT count(*)::int AS n FROM status_events"));
    expect(await dup("SELECT count(*)::int AS n FROM status_events WHERE legacy_airtable_id IS NOT NULL")).toBe(3);
    expect(await count(db, "audit_logs")).toBe(2);
    expect(await count(db, "customers")).toBe(3); expect(await count(db, "invoices")).toBe(5); expect(await count(db, "payments")).toBe(3);
  });

  it("a changed record that was already imported is NOT re-imported and is flagged for review", async () => {
    const db = await fresh();
    await run(db, buildCleanSnapshot());
    const changed = buildCleanSnapshot(); (changed.tables.Customers as any[])[0].fields.Name = "Ama Mensah-Changed";
    const r = await run(db, changed);
    expect((await one(db, "SELECT name FROM customers WHERE legacy_airtable_id = 'recC1'")).name).toBe("Ama Mensah");
    expect(r.entries.some((e: any) => e.category === "SOURCE_CHANGED" && e.sourceId === "recC1")).toBe(true);
    expect(r.report.verdict).toBe("NOT_READY");
  });

  // every crash point leaves a recoverable state: after resuming, the database equals a single successful import
  const crashPoints: [string, (s: string, i?: number) => boolean][] = [
    ["right after the warehouses stage", (s) => s === "after:warehouses"],
    ["after the customers stage", (s) => s === "after:customers"],
    ["inside the 2nd items chunk, before its commit", (s, i) => s === "commit:items" && i === 1],
    ["inside the first invoice's payments, before the commit", (s) => s === "commit:payments"],
    ["inside the invoice-lines transaction", (s) => s === "commit:invoice_lines"],
    ["after the invoice lines stage", (s) => s === "after:invoice_lines"],
    ["before the cancellations", (s) => s === "before:cancellations"],
    ["after the cancellations", (s) => s === "after:cancellations"],
    ["after the audit stage, before the batch is closed", (s) => s === "after:audit_logs"],
  ];
  for (const [name, when] of crashPoints) {
    it(`crash ${name} -> the batch is recorded as failed; the resumed run yields exactly the same database as one clean run`, async () => {
      const ref = await fresh(); await run(ref, buildMessySnapshot(), { chunk: 3 }); const want = await sig(ref);
      const db = await fresh();
      let armed = true;
      const hooks = {
        beforeStage: async (s: string) => { if (armed && when(`before:${s}`)) { armed = false; throw new Error("simulated crash"); } },
        afterStage: async (s: string) => { if (armed && when(`after:${s}`)) { armed = false; throw new Error("simulated crash"); } },
        beforeCommit: async (s: string, i: number) => { if (armed && when(`commit:${s}`, i)) { armed = false; throw new Error("simulated crash"); } },
      };
      await expect(run(db, buildMessySnapshot(), { hooks, chunk: 3 })).rejects.toThrow("simulated crash");
      expect(armed).toBe(false);
      expect(await one(db, "SELECT status, error FROM import_batches")).toMatchObject({ status: "failed", error: "simulated crash" });
      const resumed = await run(db, buildMessySnapshot(), { chunk: 3 });
      expect(await sig(db)).toBe(want);
      expect(resumed.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
      expect((await rows(db, "SELECT status FROM import_batches ORDER BY started_at")).map((r) => r.status)).toEqual(["failed", "completed"]);
      expect(await count(db, "customers")).toBe(await count(ref, "customers"));
      expect(await count(db, "status_events")).toBe(await count(ref, "status_events"));
      expect(await count(db, "audit_logs")).toBe(await count(ref, "audit_logs"));
    });
  }

  it("a killed importer (batch left 'running') is recovered by the next run, which marks the dead batch failed and resumes", async () => {
    const db = await fresh();
    await db.admin.query(`INSERT INTO import_batches (mode, snapshot_fingerprint, snapshot_kind, importer_version, source_tables, initiated_by, environment_class) VALUES ('import', repeat('a', 64), 'fixture', '7I.1', '{Customers}', 'crashed', 'test')`);
    const r = await run(db, buildCleanSnapshot());
    expect((await rows(db, "SELECT initiated_by, status, error FROM import_batches ORDER BY started_at")).map((x) => `${x.initiated_by}:${x.status}:${x.error ? "interrupted" : ""}`)).toEqual(["crashed:failed:interrupted", "vitest:completed:"]);
    expect(r.report.verdict).toBe("READY");
  });

  it("two importers at the same time: exactly one runs, the other is refused, and the result is a single clean import", async () => {
    for (let round = 0; round < 3; round++) {
      const db = await fresh();
      const settled = await Promise.allSettled([run(db, buildCleanSnapshot()), run(db, buildCleanSnapshot()), run(db, buildCleanSnapshot())]);
      const ok = settled.filter((s) => s.status === "fulfilled"); const bad = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const b of bad) expect(String(b.reason.message)).toMatch(/another import is running/);
      const ref = await fresh(); await run(ref, buildCleanSnapshot());
      expect(await sig(db)).toBe(await sig(ref));
      expect(await count(db, "customers")).toBe(3);
      expect((await one(db, "SELECT count(*)::int AS n FROM import_batches WHERE status = 'running'")).n).toBe(0);
    }
  });

  it("resuming after a partial import never re-creates what exists and still seeds the counters", async () => {
    const db = await fresh();
    await expect(run(db, buildCleanSnapshot(), { chunk: 1, hooks: { beforeCommit: async (s: string, i: number) => { if (s === "items" && i === 4) throw new Error("boom"); } } })).rejects.toThrow("boom");
    const mid = await count(db, "items"); expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(10);
    await run(db, buildCleanSnapshot(), { chunk: 1 });
    expect(await count(db, "items")).toBe(10);
    expect((await one(db, "SELECT allocate_reference('item') AS r")).r).toBe("ITM-0032");
  });
});

dbDescribe("failure isolation (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); });

  it("a record the database rejects is quarantined with the database's reason; the rest of the batch is unaffected", async () => {
    db = await createTestDb();
    // an ACTIVE card with the same name already exists: the exclusion constraint rejects the imported card at insert time
    await db.admin.query("INSERT INTO special_rates (name, sea_rate_usd, air_rate_usd) VALUES ('VIP Gold', 1, 1)");
    const r = await run(db, buildCleanSnapshot());
    const e = r.entries.find((x: any) => x.table === "SpecialRates");
    expect(e).toMatchObject({ category: "DB_CONSTRAINT_VIOLATION", severity: "blocking" });
    expect(e.reason).toMatch(/23P01|special_rates_no_overlap/);
    expect(await count(db, "customers")).toBe(3); expect(await count(db, "invoices")).toBe(5);
    expect(r.report.postgres.failed).toBe(1);
    expect(r.report.verdict).toBe("NOT_READY");
    expect(r.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
  });

  it("an invoice's payments are all-or-nothing: a rejected payment rolls the whole set back and is reported", async () => {
    db = await createTestDb();
    await db.admin.query("SELECT 1");
    const s = buildCleanSnapshot();
    (s.tables.VerifiedPayments as any[]).push({ id: "vp20", fields: { PaymentKey: "PAY-20", OrderRecordID: "recO2", AmountGhs: 100, Currency: "GHS", Method: "momo", PaidAt: "2026-01-24T09:00:00Z", Status: "completed", KeepupReference: "KR-DUP" } });
    // a completed payment elsewhere in the target already carries this Keepup reference (unique): the database refuses it
    await customer(db.admin);
    const c = (await one(db, "SELECT id FROM customers LIMIT 1")).id;
    const { actorQuery } = await import("./helpers");
    const imp = actorQuery(db.admin, { type: "import" });
    const inv = (await imp.query("INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, total_ghs, provenance) VALUES ('ORD-X', $1, 10, 10, 100, 'legacy_known') RETURNING id", [c])).rows[0].id;
    await imp.query("INSERT INTO payments (invoice_id, amount_ghs, keepup_reference, source) VALUES ($1, 10, 'KR-DUP', 'import')", [inv]);
    const r = await run(db, s);
    expect(r.entries.some((e: any) => e.table === "VerifiedPayments" && e.category === "DB_REJECTED")).toBe(true);
    expect((await one(db, "SELECT count(*)::int AS n FROM payments WHERE legacy_airtable_id IN ('vp2','vp20')")).n).toBe(0);   // the set for ORD-00002 rolled back together
    expect((await one(db, "SELECT amount_paid_ghs::text AS p FROM invoices WHERE invoice_ref = 'ORD-00002'")).p).toBe("0.00");
    expect((await one(db, "SELECT count(*)::int AS n FROM payments WHERE legacy_airtable_id = 'vp1'")).n).toBe(1);                // other invoices unaffected
    expect(r.report.verdict).toBe("NOT_READY");
  });
});

dbDescribe("reconciliation detects tampering and drift (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); });
  const failing = (r: any) => r.reconcile.checks.filter((c: any) => !c.ok).map((c: any) => c.name);

  it("a clean target reconciles with the source; a stand-alone reconcile run agrees", async () => {
    db = await createTestDb(); await run(db, buildCleanSnapshot());
    const r = await reconcileSnapshot({ snapshot: load(buildCleanSnapshot()), pool: db.admin as never, env: env({ MOVEZZ_IMPORT_ENVIRONMENT: "test" }), targetUrl: db.adminUrl });
    expect(failing(r)).toEqual([]);
    expect(r.report).toMatchObject({ verdict: "READY", scope: "target" });
  });
  it("a changed customer, item or container is found by the content fingerprints (not only by counts)", async () => {
    db = await createTestDb(); await run(db, buildCleanSnapshot());
    await db.admin.query("UPDATE customers SET name = 'Somebody Else' WHERE legacy_airtable_id = 'recC1'");
    await db.admin.query("UPDATE items SET status = 'Completed' WHERE item_ref = 'ITM-0001'");
    await db.admin.query("UPDATE containers SET container_number = 'XXXX' WHERE container_ref = 'PMX-CON-2026-001'");
    const r = await reconcileSnapshot({ snapshot: load(buildCleanSnapshot()), pool: db.admin as never, env: env(), targetUrl: db.adminUrl });
    expect(failing(r)).toEqual(expect.arrayContaining(["fingerprint Customers", "fingerprint Items", "fingerprint Containers"]));
    expect(r.report.verdict).toBe("NOT_READY");
  });
  it("tampered money is found: totals, payments, balances and statuses are re-derived independently", async () => {
    db = await createTestDb(); await run(db, buildCleanSnapshot());
    const c = await db.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");                      // bypass the immutability triggers, as only a superuser could
      await c.query("UPDATE invoices SET amount_paid_ghs = 600 WHERE invoice_ref = 'ORD-00002'");
      await c.query("UPDATE payments SET amount_ghs = 600 WHERE legacy_airtable_id = 'vp2'");
      await c.query("SET session_replication_role = DEFAULT");
    } finally { c.release(); }
    const r = await reconcileSnapshot({ snapshot: load(buildCleanSnapshot()), pool: db.admin as never, env: env(), targetUrl: db.adminUrl });
    expect(failing(r)).toEqual(expect.arrayContaining(["money: Σ completed payments GHS", "per-invoice financials (total, paid, balance, status)", "fingerprint Orders", "fingerprint VerifiedPayments"]));
    expect(r.report.financial!.mismatches.length).toBeGreaterThan(0);
  });
  it("a missing, extra or orphaned record is found by identifier sets and the integrity checks", async () => {
    db = await createTestDb(); await run(db, buildCleanSnapshot());
    const c = await db.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query("DELETE FROM import_records WHERE source_id = 'recC3'");
      await c.query("INSERT INTO customers (name, shipping_mark, legacy_airtable_id) VALUES ('Ghost', 'MOVEZZ-GH0000', 'recGHOST')");
      await c.query("DELETE FROM items WHERE item_ref = 'ITM-0030'");
      await c.query("SET session_replication_role = DEFAULT");
    } finally { c.release(); }
    const r = await reconcileSnapshot({ snapshot: load(buildCleanSnapshot()), pool: db.admin as never, env: env(), targetUrl: db.adminUrl });
    expect(failing(r)).toEqual(expect.arrayContaining(["count Items", "integrity: imported rows without an import mapping", "integrity: import mappings whose target row is missing"]));
    expect(r.report.verdict).toBe("NOT_READY");
  });
  it("identity or Keepup side effects would be caught: a user, a sync row or a notification for an imported invoice fails the security checks", async () => {
    db = await createTestDb(); await run(db, buildCleanSnapshot());
    const c = await db.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query("INSERT INTO users (auth_uid, email, role, legacy_airtable_id) VALUES ('x', 'x@example.invalid', 'warehouse_staff', 'recU2')");
      await c.query("INSERT INTO keepup_sync (kind, invoice_id, idempotency_key) SELECT 'invoice', id, 'k1' FROM invoices WHERE invoice_ref = 'ORD-00002'");
      await c.query("SET session_replication_role = DEFAULT");
    } finally { c.release(); }
    const r = await reconcileSnapshot({ snapshot: load(buildCleanSnapshot()), pool: db.admin as never, env: env(), targetUrl: db.adminUrl });
    expect(failing(r)).toEqual(expect.arrayContaining(["security: users created by the import (no identity may be created)", "security: Keepup sync rows for imported invoices (no Keepup activity)"]));
  });
});
