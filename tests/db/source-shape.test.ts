// Phase 7J: SOURCE-CODE-DERIVED shape validation. Nothing here is production validation - the Airtable base was never read.
// The census is parsed from src/lib/airtable.ts; the realistic fixture is generated from it; the importer is run against that fixture.
import { describe, it, expect, afterEach } from "vitest";
import { dbDescribe, createTestDb, TEST_ACTOR_KEY_B64, type TestDb } from "./helpers";
import { dryRun, importSnapshot, parseSnapshotText, prepare, collectEntries, databaseSignature, reportToJson } from "../../scripts/lib/import/index.mjs";
import { KNOWN_FIELDS } from "../../scripts/lib/import/normalize.mjs";
import { snapshotFingerprint } from "../../scripts/lib/import/snapshot.mjs";
import { deriveSourceShape } from "../fixtures/migration/source-shape.mjs";
import { buildRealisticSnapshot } from "../fixtures/migration/realistic.mjs";

const env = (): Record<string, string> => ({ NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test", ACTOR_CONTEXT_KEY: TEST_ACTOR_KEY_B64 });
const load = (o: unknown) => parseSnapshotText(JSON.stringify(o));
const cat = (entries: any[], table: string, category: string, severity = "blocking") => entries.filter((e) => e.table === table && e.category === category && e.severity === severity);

describe("census derived from src/lib/airtable.ts", () => {
  const shape = deriveSourceShape() as Record<string, { fields: string[]; reads: Record<string, string>; writes: string[] }>;
  it("covers every table the application uses", () => {
    expect(Object.keys(shape).sort()).toEqual(["ActivityLogs", "Containers", "Customers", "Items", "Orders", "PackageRates", "PendingRegistrations", "Settings", "SpecialRates", "StatusHistory", "Suppliers", "Users", "Warehouses"]);
  });
  it("every field the application reads or writes is known to the importer (no silent 'unexpected field' noise for real fields)", () => {
    for (const [table, v] of Object.entries(shape)) {
      const known: string[] = (KNOWN_FIELDS as Record<string, string[]>)[table] ?? [];
      expect(v.fields.filter((f) => !known.includes(f)), `${table}: used by the application but unknown to the importer`).toEqual([]);
    }
  });
  it("linked-record and lookup fields are arrays, attachments are attachment lists - and the importer reads them that way", () => {
    expect(shape.Items.reads).toMatchObject({ Customer: "array", Container: "array", Order: "array", CustomerName: "array", CustomerShippingMark: "array", Photos: "attachments" });
    expect(shape.Orders.reads).toMatchObject({ Customer: "array", Items: "array" });
    expect(shape.Users.reads).toMatchObject({ CustomerRecord: "array" });
    expect(shape.Containers.reads).toMatchObject({ Items: "array" });
  });
});

describe("realistic fixture generator", () => {
  it("is deterministic per seed and differs between seeds; conforms to the census (it throws on drift)", () => {
    const a = buildRealisticSnapshot({ scale: 1, seed: 1 }); const b = buildRealisticSnapshot({ scale: 1, seed: 1 }); const c = buildRealisticSnapshot({ scale: 1, seed: 2 });
    expect(snapshotFingerprint(load(a.snapshot))).toBe(snapshotFingerprint(load(b.snapshot)));
    expect(snapshotFingerprint(load(c.snapshot))).not.toBe(snapshotFingerprint(load(a.snapshot)));
  });
  it("reproduces Airtable's behaviours: empty values omitted, arrays for links/lookups, attachments with thumbnails, no 'Cancelled' orders, unexpected formula fields", () => {
    const { snapshot, meta } = buildRealisticSnapshot();
    const items = snapshot.tables.Items as any[]; const orders = snapshot.tables.Orders as any[];
    for (const r of [...items, ...orders, ...snapshot.tables.Customers]) for (const [k, v] of Object.entries<any>(r.fields)) { expect(v, k).not.toBe(""); expect(v, k).not.toBeNull(); expect(v, k).not.toBe(false); if (Array.isArray(v)) expect(v.length, k).toBeGreaterThan(0); }
    expect(items.some((i) => Array.isArray(i.fields.CustomerName))).toBe(true);
    expect(items.find((i) => i.fields.Photos)!.fields.Photos[0]).toMatchObject({ id: expect.stringMatching(/^att/), url: expect.stringMatching(/^https:/), filename: expect.any(String), thumbnails: { small: { url: expect.any(String) } } });
    expect(orders.every((o) => ["Pending", "Partial", "Paid"].includes(o.fields.Status))).toBe(true);        // the application deletes an order instead of cancelling it
    expect(snapshot.tables.VerifiedInvoices).toBeUndefined();                                                  // there is no verified financial source in Airtable
    expect(meta.quirks).toMatchObject({ item_without_customer_link: expect.any(Number), staff_formula_fields: expect.any(Number), order_amount_is_usd: expect.any(Number), order_amount_is_ghs: expect.any(Number) });
    expect(JSON.stringify(snapshot)).not.toMatch(/@(?!example\.invalid)[a-z]+\./);
  });
});

describe("importer on the realistic fixture, dry-run (source-code-derived shapes)", () => {
  const { snapshot, meta } = buildRealisticSnapshot();
  const p = prepare(load(snapshot)); const e = collectEntries(p.st);
  it("flags each seeded quirk with the category the rules promise", () => {
    expect(cat(e, "Items", "MISSING_CUSTOMER_REFERENCE")).toHaveLength(meta.quirks.item_without_customer_link);
    expect(cat(e, "Containers", "DUPLICATE_CONTAINER")).toHaveLength(2);
    expect(cat(e, "Containers", "NONSTANDARD_REFERENCE", "review")).toHaveLength(1);
    expect(cat(e, "Customers", "MISSING_WAREHOUSE")).toHaveLength(meta.quirks.dangling_preferred_warehouse);
    expect(cat(e, "Customers", "DUPLICATE_CUSTOMER").length).toBeGreaterThanOrEqual(2);
    expect(cat(e, "Customers", "DUPLICATE_PHONE", "review").length).toBeGreaterThanOrEqual(2);
    expect(cat(e, "StatusHistory", "ORPHAN_STATUS_EVENT")).toHaveLength(meta.quirks.history_of_deleted_item);
    expect(cat(e, "Items", "INVALID_LINK").length).toBeGreaterThanOrEqual(1);                              // an item linked to two orders
    expect(cat(e, "Items", "INVALID_DATE").length).toBe(meta.quirks.malformed_date);
    expect(cat(e, "SpecialRates", "CONFLICTING_IDENTITY")).toHaveLength(2);
    expect(e.some((x) => x.category === "UNEXPECTED_FIELD" && x.severity === "review")).toBe(true);        // staff-added formula fields are kept in legacy_data, not lost
    expect(e.filter((x) => x.category === "UNEXPECTED_FIELD" && x.table === "Customers" && /CreatedBy/.test(x.field ?? ""))).toEqual([]);   // CreatedBy is a real field (found by the census)
  });
  it("accepts what Airtable legitimately produces: legacy package names, numeric strings, float noise, whitespace, absent booleans", () => {
    const customers = p.st.validList("Customers");
    expect(customers.length).toBeGreaterThan(40);
    expect(new Set(customers.map((c: any) => c.row.package_tier))).toEqual(new Set(["basic", "business", "enterprise"]));       // standard/discounted/premium mapped
    expect(customers.some((c: any) => c.row.legacy_data.legacy_exchange_rate === "14")).toBe(true);
    expect(cat(e, "Customers", "TRIMMED_WHITESPACE", "review").length).toBeGreaterThan(0);
    const items = p.st.validList("Items");
    expect(items.some((i: any) => i.row.weight_kg === "0.300")).toBe(true);                                                     // 0.1 + 0.2 arrived as 0.30000000000000004
    expect(items.some((i: any) => i.row.weight_kg === "12.500")).toBe(true);                                                    // "12.5" (a numeric string)
    expect(items.every((i: any) => i.row.is_missing === true || i.row.is_missing === false)).toBe(true);
  });
  it("is stricter than Airtable where the new schema cannot hold the value: more decimals than stored, non-numbers, incomplete cartons", () => {
    expect(cat(e, "Items", "INVALID_DIMENSION").length).toBeGreaterThanOrEqual(meta.quirks.invalid_number + meta.quirks.three_decimal_dimension - 2);
    expect(cat(e, "Cartons", "INVALID_CARTON").length).toBeGreaterThanOrEqual(1);                                              // incomplete carton measurements
    const bad = e.find((x) => x.category === "INVALID_DIMENSION" && /decimal places/.test(x.reason));
    expect(bad).toBeTruthy();
  });
  it("FINANCIAL DATA STAYS FAIL-CLOSED: no order is importable, no amount is interpreted, no payment or discount is derived", () => {
    expect(p.st.validList("Orders")).toEqual([]);
    const orders = snapshot.tables.Orders as any[];
    const blocked = e.filter((x) => x.table === "Orders" && x.severity === "blocking");
    expect(new Set(blocked.map((x) => x.sourceId)).size).toBe(orders.length);                                                  // every single order is quarantined
    expect(blocked.some((x) => x.category === "MISSING_VERIFIED_FINANCIALS")).toBe(true);
    expect(p.st.validList("VerifiedPayments")).toEqual([]); expect(p.st.validList("VerifiedInvoices")).toEqual([]);
    for (const o of orders.slice(0, 20)) expect(e.some((x) => x.table === "Orders" && x.sourceId === o.id && x.severity === "blocking"), o.id).toBe(true);
    // items hanging on an order are held back with it (importing them uninvoiced could double-bill)
    const onOrders = (snapshot.tables.Items as any[]).filter((i) => i.fields.Order);
    for (const i of onOrders.slice(0, 30)) expect(p.st.statusOf("Items", i.id), i.id).not.toBe("valid");
  });
  it("the report says NOT_READY and explains why; the financial section has no invented numbers", async () => {
    const r = await dryRun({ snapshot: load(snapshot), env: env(), targetUrl: "postgres://u@127.0.0.1/m" } as never);
    expect(r.report.verdict).toBe("NOT_READY");
    expect(r.report.financial!).toMatchObject({ invoices: 0, totalGhs: "0.00", paidGhs: "0.00", outstandingGhs: "0.00", discrepancies: [] });
    expect(r.report.reasons.join(" ")).toMatch(/financial/);
    expect(r.report.source.tables.Orders).toMatchObject({ discovered: 90, valid: 0, quarantined: 90 });
  });
  it("whatever the currency convention of InvoiceAmount, the outcome is identical (it is never read as a total)", () => {
    const a = JSON.parse(JSON.stringify(snapshot)); const b = JSON.parse(JSON.stringify(snapshot));
    for (const o of a.tables.Orders) o.fields.InvoiceAmount = (o.fields.InvoiceAmount ?? 1) * 12.5;       // "everything was GHS"
    for (const o of b.tables.Orders) o.fields.InvoiceAmount = String(o.fields.InvoiceAmount ?? 1);        // numeric strings
    const blockedIds = (s: unknown) => [...new Set(collectEntries(prepare(load(s)).st).filter((x) => x.table === "Orders" && x.severity === "blocking").map((x) => x.sourceId))].sort();
    const pa = prepare(load(a)); const pb = prepare(load(b));
    expect(pa.st.validList("Orders")).toEqual([]); expect(pb.st.validList("Orders")).toEqual([]);
    expect(blockedIds(a)).toEqual(blockedIds(b));
    expect(blockedIds(a)).toHaveLength(90);
  });
  it("the same snapshot in another record order gives the identical report", async () => {
    const shuffled = JSON.parse(JSON.stringify(snapshot)); for (const t of Object.keys(shuffled.tables)) shuffled.tables[t].reverse();
    const a = await dryRun({ snapshot: load(snapshot), env: env(), targetUrl: "postgres://u@127.0.0.1/m" } as never); const b = await dryRun({ snapshot: load(shuffled), env: env(), targetUrl: "postgres://u@127.0.0.1/m" } as never);
    expect(reportToJson(b.report).replace(/"label": "[^"]*",?/, "")).toBe(reportToJson(a.report).replace(/"label": "[^"]*",?/, ""));
  });
});

dbDescribe("import of the realistic fixture (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); });
  const run = (snap: unknown, over: Record<string, unknown> = {}) => importSnapshot({ snapshot: load(snap), pool: db.admin as never, env: env(), targetUrl: db.adminUrl, initiatedBy: "rehearsal", ...over } as never);
  const n = async (t: string) => Number((await db.admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);

  it("imports what is safe, reconciles exactly, and creates NO invoice, payment, line, user, Keepup row or notification", async () => {
    db = await createTestDb();
    const { snapshot } = buildRealisticSnapshot();
    const res = await run(snapshot);
    expect(res.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(res.report.verdict).toBe("NOT_READY");
    for (const t of ["invoices", "payments", "invoice_lines", "users", "keepup_sync", "notification_outbox", "idempotency_keys"]) expect(await n(t), t).toBe(0);
    expect(await n("customers")).toBe(res.report.source.tables.Customers.valid);
    expect(await n("items")).toBe(res.report.source.tables.Items.valid);
    expect(await n("items")).toBeGreaterThan(100);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM items WHERE invoice_id IS NOT NULL")).rows[0].n).toBe(0);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM import_quarantine WHERE batch_id = $1", [res.batchId])).rows[0].n).toBe(res.entries.length);
  });

  it("a second run is a no-op, and a crash in the middle resumes to the same database", async () => {
    const { snapshot } = buildRealisticSnapshot();
    db = await createTestDb();
    await run(snapshot); const c0 = await db.admin.connect(); let s1: string; try { s1 = await databaseSignature(c0); } finally { c0.release(); }
    const again = await run(snapshot); expect(again.report.postgres.imported).toBe(0);
    const c = await db.admin.connect(); try { expect(await databaseSignature(c)).toBe(s1); } finally { c.release(); }
    const ref = db; db = await createTestDb();
    try {
      await expect(run(snapshot, { chunk: 25, hooks: { beforeCommit: async (s: string, i: number) => { if (s === "items" && i === 2) throw new Error("crash"); } } })).rejects.toThrow("crash");
      await run(snapshot, { chunk: 25 });
      const c1 = await db.admin.connect(); const c2 = await ref.admin.connect();
      try { expect(await databaseSignature(c1)).toBe(await databaseSignature(c2)); } finally { c1.release(); c2.release(); }
    } finally { await ref.close(); }
  });

  it("with a verified financial stand-in for a subset, ONLY that subset becomes invoices; amounts come from the verified rows, never from InvoiceAmount", async () => {
    db = await createTestDb();
    const { snapshot } = buildRealisticSnapshot({ verified: "partial" });
    const res = await run(snapshot);
    expect(res.reconcile.checks.filter((c: any) => !c.ok)).toEqual([]);
    const imported = await n("invoices"); expect(imported).toBeGreaterThan(5); expect(imported).toBeLessThan((snapshot.tables.Orders as any[]).length);
    const verifiedIds = new Set((snapshot.tables.VerifiedInvoices as any[]).map((v) => v.fields.OrderRecordID));
    const got = (await db.admin.query("SELECT legacy_airtable_id AS id, total_ghs::text AS t FROM invoices")).rows;
    for (const g of got) { expect(verifiedIds.has(g.id)).toBe(true); const v = (snapshot.tables.VerifiedInvoices as any[]).find((x) => x.fields.OrderRecordID === g.id).fields; expect(Number(g.t)).toBeCloseTo(v.TotalGhs, 2); }
    expect(res.report.financial!.mismatches).toEqual([]);
    expect(await n("payments")).toBe((snapshot.tables.VerifiedPayments as any[]).filter((p) => got.some((g) => g.id === p.fields.OrderRecordID)).length);
    expect(res.report.verdict).toBe("NOT_READY");                                                                              // the remaining orders are still unverified
  });
});
