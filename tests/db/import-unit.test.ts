// Importer stages that need no database: utilities, snapshot loading/discovery, environment guard, normalization, validation/quarantine,
// financial analysis, report verdicts, determinism and security of the source handling. The source snapshot is untrusted input.
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDecimal, parseTimestamp, canonicalJson, fingerprint, mulRound } from "../../scripts/lib/import/util.mjs";
import { parseSnapshotText, readSnapshotFile, snapshotFingerprint, discover, DEFAULT_LIMITS, SNAPSHOT_FORMAT } from "../../scripts/lib/import/snapshot.mjs";
import { evaluateEnvironment, assertApprovedEnvironment } from "../../scripts/lib/import/env-guard.mjs";
import { ImportRefusal } from "../../scripts/lib/import/errors.mjs";
import * as N from "../../scripts/lib/import/normalize.mjs";
import { prepare, collectEntries } from "../../scripts/lib/import/index.mjs";
import { analyzeInvoice, paymentEvents } from "../../scripts/lib/import/financial.mjs";
import { buildReport, reportToJson } from "../../scripts/lib/import/report.mjs";
import { mintImportAssertion } from "../../scripts/lib/import/actor.mjs";
import { assertionMessage } from "../../src/lib/db/actor";
import { buildCleanSnapshot, buildMessySnapshot } from "../fixtures/migration/synthetic.mjs";

const parse = (o: unknown) => parseSnapshotText(JSON.stringify(o));
const rec = (id: string, fields: Record<string, unknown>) => ({ id, fields: Object.assign(Object.create(null), fields) });
const cats = (r: { issues: { severity: string; category: string }[] }, sev = "blocking") => r.issues.filter((i) => i.severity === sev).map((i) => i.category);
const entriesOf = (snap: unknown) => collectEntries(prepare(parse(snap)).st);
const find = (entries: any[], table: string, id: string) => entries.filter((e) => e.table === table && e.sourceId === id);

describe("decimals and dates (money is never floating point)", () => {
  it("parses plain decimals exactly and refuses anything that would be rounded or ambiguous", () => {
    expect(parseDecimal("12.5", { scale: 2 })).toMatchObject({ ok: true, text: "12.50", units: BigInt(1250) });
    expect(parseDecimal(0.1 + 0.2 > 0.3 ? 0.3 : 0.3, { scale: 2 })).toMatchObject({ ok: true, text: "0.30" });
    expect(parseDecimal("1250.00", { scale: 2 }).ok).toBe(true);
    for (const bad of ["12.345", "1,250.00", "1e3", "-5", "NaN", "", "abc", " ", "12.5.1", "$5", 12.345, 1e21, Infinity, NaN, null, undefined, {}, [], true]) {
      expect(parseDecimal(bad as never, { scale: 2 }).ok, String(bad)).toBe(false);
    }
    expect(parseDecimal("12.500", { scale: 2 }).ok).toBe(true);                 // trailing zeros are not a rounding
    expect(parseDecimal("12.501", { scale: 2 }).ok).toBe(false);
    expect(parseDecimal("-5", { scale: 2, allowNegative: true })).toMatchObject({ ok: true, text: "-5.00" });
    expect(parseDecimal("12.5", { scale: 8 }).text).toBe("12.50000000");
  });
  it("rounds products half-up like the database constraint", () => {
    expect(mulRound(BigInt(70000), 2, BigInt(1250000000), 8, 2)).toBe(BigInt(875000));              // 700.00 x 12.5 = 8750.00
    expect(mulRound(BigInt(1), 2, BigInt(50000000), 8, 2)).toBe(BigInt(1));                          // 0.01 x 0.5 = 0.005 -> 0.01 (half up)
    expect(mulRound(BigInt(1), 2, BigInt(49999999), 8, 2)).toBe(BigInt(0));
  });
  it("accepts only real calendar dates and timestamps with an explicit offset", () => {
    expect(parseTimestamp("2026-02-28")).toMatchObject({ ok: true, date: "2026-02-28" });
    expect(parseTimestamp("2026-02-31").ok).toBe(false);
    expect(parseTimestamp("31/02/2026").ok).toBe(false);
    expect(parseTimestamp("2026-01-01T10:00:00").ok).toBe(false);               // no offset: local time is never guessed
    expect(parseTimestamp("2026-01-01T10:00:00+01:00")).toMatchObject({ ok: true, iso: "2026-01-01T09:00:00.000Z" });
    expect(parseTimestamp("2026-13-01T10:00:00Z").ok).toBe(false);
    expect(parseTimestamp("1800-01-01").ok).toBe(true);                          // date-only: calendar check only
    expect(parseTimestamp("1800-01-01T00:00:00Z").ok).toBe(false);
    expect(parseTimestamp(20260101 as never).ok).toBe(false);
  });
  it("canonical JSON and fingerprints do not depend on key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("snapshot loading is safe against hostile files", () => {
  const minimal = () => ({ format: SNAPSHOT_FORMAT, source: { kind: "fixture", label: "t", capturedAt: "2026-01-01T00:00:00Z" }, tables: { Customers: [] as unknown[] } });
  it("rejects wrong formats, bad JSON, bad shapes and oversize input", () => {
    expect(() => parseSnapshotText("{nope")).toThrow(/not valid JSON/);
    expect(() => parseSnapshotText("[]")).toThrow(/object/);
    expect(() => parse({ ...minimal(), format: "other/1" })).toThrow(/format/);
    expect(() => parse({ ...minimal(), source: { kind: "live", capturedAt: "2026-01-01T00:00:00Z" } })).toThrow(/source.kind/);
    expect(() => parse({ ...minimal(), source: { kind: "fixture", capturedAt: "soon" } })).toThrow(/capturedAt/);
    expect(() => parse({ ...minimal(), tables: [] })).toThrow(/tables/);
    expect(() => parse({ ...minimal(), tables: { Customers: {} } })).toThrow(/array/);
    expect(() => parseSnapshotText(JSON.stringify(minimal()), { ...DEFAULT_LIMITS, maxBytes: 10 })).toThrow(/size limit/);
    expect(() => parseSnapshotText(JSON.stringify({ ...minimal(), tables: { Customers: [{ id: "recAAA", fields: {} }, { id: "recBBB", fields: {} }] } }), { ...DEFAULT_LIMITS, maxRecordsPerTable: 1 } as never)).toThrow(/more than 1 records/);
  });
  it("marks records with prototype-polluting keys, control characters, oversized strings and deep nesting as tainted - never normalized", () => {
    const raw = `{"format":"${SNAPSHOT_FORMAT}","source":{"kind":"fixture","capturedAt":"2026-01-01T00:00:00Z"},"tables":{"Customers":[
      {"id":"recP1","fields":{"Name":"A","__proto__":{"polluted":true}}},
      {"id":"recP2","fields":{"Name":"B","nested":{"constructor":{"prototype":{"x":1}}}}},
      {"id":"recP3","fields":{"Name":"C\\u0000D"}},
      {"id":"recP4","fields":{"Name":"${"x".repeat(30000)}"}},
      {"id":"recP5","fields":{"Name":"E","deep":[[[[[[[[1]]]]]]]]}},
      {"id":"recP6","fields":{"Name":"clean"}}]}}`;
    const s = parseSnapshotText(raw);
    const byId = Object.fromEntries(s.tables.Customers.map((r: any) => [r.id, r]));
    expect(byId.recP1.taint[0].category).toBe("UNSAFE_CONTENT");
    expect(byId.recP2.taint[0].category).toBe("UNSAFE_CONTENT");
    expect(byId.recP3.taint[0].category).toBe("UNSAFE_CONTENT");
    expect(byId.recP4.taint[0].category).toBe("OVERSIZED_FIELD");
    expect(byId.recP5.taint[0].category).toBe("UNSAFE_CONTENT");
    expect(byId.recP6.taint).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(byId.recP1.fields)).toBeNull();                 // null-prototype copies: no way to reach Object.prototype
    const e = entriesOf(JSON.parse(raw));
    for (const id of ["recP1", "recP2", "recP3", "recP4", "recP5"]) expect(find(e, "Customers", id).some((x) => x.severity === "blocking"), id).toBe(true);
  });
  it("records without a usable id are reported, duplicates of one source id are all blocked, unknown tables are ignored with a note", () => {
    const s = parse({ ...minimal(), tables: { Customers: [{ id: "x", fields: {} }, { fields: {} }, "junk", { id: "recDUP", fields: { Name: "A" } }, { id: "recDUP", fields: { Name: "B" } }], Mystery: [{ id: "recM", fields: {} }] } });
    expect(s.envelopeProblems.map((p: any) => p.category)).toEqual(["INVALID_ENVELOPE", "INVALID_ENVELOPE", "INVALID_ENVELOPE"]);
    expect(s.unknownTables).toEqual([{ table: "Mystery", records: 1 }]);
    const e = collectEntries(prepare(s).st);
    expect(find(e, "Customers", "recDUP").map((x) => x.category)).toEqual(["DUPLICATE_SOURCE_ID"]);
    expect(e.some((x) => x.category === "UNKNOWN_TABLE")).toBe(true);
    expect(discover(s).duplicateIds).toEqual([{ table: "Customers", sourceId: "recDUP", copies: 2 }]);
  });
  it("the fingerprint identifies the DATA: record order and label do not matter, any value does", () => {
    const a = parse(buildMessySnapshot()); const b = buildMessySnapshot(); b.tables.Customers.reverse(); b.source.label = "renamed";
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(parse(b)));
    const c = buildMessySnapshot(); (c.tables.Customers[0].fields as any).Name = "Changed";
    expect(snapshotFingerprint(parse(c))).not.toBe(snapshotFingerprint(a));
  });
  it("reads files only inside the allowed directory: no traversal, no symlink escape, no directories, no oversize files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snap-")); const outside = await mkdtemp(path.join(tmpdir(), "snap-out-"));
    const good = path.join(root, "ok.json"); await writeFile(good, JSON.stringify(minimal()));
    await writeFile(path.join(outside, "secret.json"), JSON.stringify(minimal()));
    await symlink(path.join(outside, "secret.json"), path.join(root, "link.json"));
    await mkdir(path.join(root, "dir.json"));
    expect((await readSnapshotFile(good, { allowedRoot: root })).format).toBe(SNAPSHOT_FORMAT);
    await expect(readSnapshotFile(path.join(root, "..", path.basename(outside), "secret.json"), { allowedRoot: root })).rejects.toThrow(/inside the allowed directory/);
    await expect(readSnapshotFile(path.join(root, "link.json"), { allowedRoot: root })).rejects.toThrow(/inside the allowed directory/);
    await expect(readSnapshotFile(path.join(root, "dir.json"), { allowedRoot: root })).rejects.toThrow(/regular file/);
    await expect(readSnapshotFile(path.join(root, "missing.json"), { allowedRoot: root })).rejects.toThrow(/not found/);
    await expect(readSnapshotFile("bad\0path", { allowedRoot: root })).rejects.toThrow(/Invalid snapshot path/);
    await expect(readSnapshotFile(good, { allowedRoot: root, limits: { ...DEFAULT_LIMITS, maxBytes: 5 } })).rejects.toThrow(/limit/);
  });
});

describe("environment guard fails closed", () => {
  const ok = { MOVEZZ_IMPORT_ENVIRONMENT: "local", NODE_ENV: "development" };
  const url = "postgres://u:p@127.0.0.1:5432/movezz_dev";
  it("approves only an explicit mode, an approved environment class, loopback (or allow-listed staging) and no live credentials", () => {
    expect(evaluateEnvironment({ env: ok, targetUrl: url, mode: "import" }).ok).toBe(true);
    const remote = { ...ok, MOVEZZ_IMPORT_ENVIRONMENT: "staging", MOVEZZ_IMPORT_ALLOWED_HOSTS: "db.staging.invalid" };
    expect(evaluateEnvironment({ env: remote, targetUrl: "postgres://x@db.staging.invalid/m", mode: "dry-run" }).ok).toBe(false);                                   // an allow-listed host alone does not pick a database
    expect(evaluateEnvironment({ env: { ...remote, MOVEZZ_IMPORT_CONFIRM_DATABASE: "other" }, targetUrl: "postgres://x@db.staging.invalid/m", mode: "dry-run" }).ok).toBe(false);
    expect(evaluateEnvironment({ env: { ...remote, MOVEZZ_IMPORT_CONFIRM_DATABASE: "m" }, targetUrl: "postgres://x@db.staging.invalid/m?sslmode=verify-full", mode: "dry-run" }).ok).toBe(true);
    expect(evaluateEnvironment({ env: { ...remote, MOVEZZ_IMPORT_CONFIRM_DATABASE: "m" }, targetUrl: "postgres://x@db.staging.invalid/m", mode: "dry-run" }).ok).toBe(false);   // a remote target also needs verified TLS
  });
  it.each([
    ["no mode", ok, url, undefined],
    ["unknown mode", ok, url, "wipe"],
    ["no environment class", { NODE_ENV: "development" }, url, "import"],
    ["production class", { ...ok, MOVEZZ_IMPORT_ENVIRONMENT: "production" }, url, "import"],
    ["NODE_ENV=production", { ...ok, NODE_ENV: "production" }, url, "import"],
    ["remote host, not allow-listed", ok, "postgres://u@db.example.com/movezz", "import"],
    ["remote host with class local even if listed", { ...ok, MOVEZZ_IMPORT_ALLOWED_HOSTS: "db.example.com" }, "postgres://u@db.example.com/movezz", "import"],
    ["production-looking host", { ...ok, MOVEZZ_IMPORT_ENVIRONMENT: "staging", MOVEZZ_IMPORT_ALLOWED_HOSTS: "prod-db.internal" }, "postgres://u@prod-db.internal/movezz", "import"],
    ["production-looking database name", ok, "postgres://u@127.0.0.1/movezz_production", "import"],
    ["live-looking database name", ok, "postgres://u@localhost/live", "import"],
    ["no target", ok, undefined, "import"],
    ["invalid target", ok, "not a url", "import"],
  ])("refuses: %s", (_n, env, target, mode) => {
    expect(evaluateEnvironment({ env: env as never, targetUrl: target as never, mode: mode as never }).ok).toBe(false);
    expect(() => assertApprovedEnvironment({ env: env as never, targetUrl: target as never, mode: mode as never })).toThrow(ImportRefusal);
  });
  it.each(["AIRTABLE_API_KEY", "AIRTABLE_BASE_ID", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "NEXT_PUBLIC_FIREBASE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "KEEPUP_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDFLARE_API_TOKEN", "CF_ACCOUNT_ID", "RESEND_API_KEY", "WHATSAPP_TOKEN"])(
    "refuses when %s is present (names only are reported, never values)", (name) => {
      const d = evaluateEnvironment({ env: { ...ok, [name]: "super-secret-value" }, targetUrl: url, mode: "import" });
      expect(d.ok).toBe(false);
      expect(JSON.stringify(d)).not.toContain("super-secret-value");
      expect(JSON.stringify(d)).toContain(name);
    });
  it("accepts an export snapshot only in staging with explicit consent", () => {
    const e = { MOVEZZ_IMPORT_ENVIRONMENT: "staging", MOVEZZ_IMPORT_ALLOWED_HOSTS: "db.staging.invalid", MOVEZZ_IMPORT_CONFIRM_DATABASE: "m", NODE_ENV: "test" };
    const t = "postgres://x@db.staging.invalid/m?sslmode=verify-full";
    expect(evaluateEnvironment({ env: e, targetUrl: t, mode: "import", snapshotKind: "export" }).ok).toBe(false);
    expect(evaluateEnvironment({ env: { ...e, MOVEZZ_IMPORT_ALLOW_EXPORT: "1" }, targetUrl: t, mode: "import", snapshotKind: "export" }).ok).toBe(true);
    expect(evaluateEnvironment({ env: { ...ok, MOVEZZ_IMPORT_ALLOW_EXPORT: "1" }, targetUrl: url, mode: "import", snapshotKind: "export" }).ok).toBe(false);
    expect(evaluateEnvironment({ env: ok, targetUrl: url, mode: "import", snapshotKind: "fixture" }).ok).toBe(true);
  });
});

describe("normalization", () => {
  const cust = (f: Record<string, unknown>) => N.normalizeCustomer(rec("recC", { Name: "A B", ShippingMark: "MOVEZZ-AB0001", ...f }) as never);
  it("customers: statuses, tiers, e-mail and shipping marks", () => {
    expect(cust({}).rec!.row).toMatchObject({ status: "active", package_tier: "basic" });
    expect(cust({ Status: "Inactive" }).rec!.row.status).toBe("inactive");
    expect(cust({ CustomerPackage: "premium" }).rec!.row.package_tier).toBe("enterprise");
    expect(cust({ CustomerPackage: "discounted" }).rec!.row.package_tier).toBe("business");
    expect(cats(cust({ Status: "suspended" }))).toEqual(["UNKNOWN_STATUS"]);
    expect(cats(cust({ CustomerPackage: "gold" }))).toEqual(["UNKNOWN_TIER"]);
    expect(cats(cust({ Email: "nope" }))).toEqual(["INVALID_EMAIL"]);
    expect(cats(cust({ Name: "  " }))).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(cats(cust({ ShippingMark: "A B" }))).toEqual(["INVALID_SHIPPING_MARK"]);
    expect(cats(cust({ ShippingMark: "A;DROP" }))).toEqual(["INVALID_SHIPPING_MARK"]);
    expect(cats(cust({ ShippingMark: "" }))).toEqual(["INVALID_SHIPPING_MARK"]);
    expect(cats(cust({ ShippingMark: "OLD-77" }), "review")).toEqual(["NONSTANDARD_SHIPPING_MARK"]);
    expect(cust({ ShippingMark: "OLD-77" }).rec!.row.shipping_mark).toBe("OLD-77");                       // preserved, never regenerated
    expect(cust({ ShippingMark: "PAKKMAXX-ADWOA-9012" }).issues.filter((i: { severity: string }) => i.severity !== "info")).toEqual([]);
  });
  it("customers: the Firebase UID is never carried over, unexpected fields are preserved and flagged, whitespace is flagged", () => {
    const c = cust({ FirebaseUID: "uid-123", ExchangeRate: 14, Extra: "v" });
    expect(JSON.stringify(c.rec)).not.toContain("uid-123");
    expect(c.rec!.row.legacy_data).toMatchObject({ had_firebase_uid: true, legacy_exchange_rate: "14", unexpected_fields: { Extra: "v" } });
    expect(cats(c, "review")).toEqual(["UNEXPECTED_FIELD"]);
    expect(cats(cust({ Name: " Padded " }), "review")).toEqual(["TRIMMED_WHITESPACE"]);
  });
  it("items: pricing snapshots follow the carton rules, special items are validated, numbers are strict", () => {
    const item = (f: Record<string, unknown>) => N.normalizeItem(rec("recI", { ItemRef: "ITM-1", Customer: ["recC"], ...f }) as never);
    expect(item({ PkgEstShipping: 100 }).rec!.row.tier_price_usd).toBe("100.00");
    const inCarton = item({ CartonNumber: "CTN-1", PkgEstShipping: 87.5, PreCartonPkgEstShipping: 100 });
    expect(inCarton.rec!.row.tier_price_usd).toBe("100.00");                                               // never the overwritten share
    expect(item({ CartonNumber: "CTN-1", PkgEstShipping: 87.5 }).rec!.row.tier_price_usd).toBeNull();
    expect(cats(item({ IsSpecialItem: true }))).toEqual(["INVALID_SPECIAL_RATE", "INVALID_SPECIAL_RATE"]);
    expect(cats(item({ IsSpecialItem: true, specialRateName: "VIP", EstShippingPrice: 10, CartonNumber: "CTN-1" }))).toEqual(["INVALID_CARTON"]);
    expect(item({ IsSpecialItem: true, specialRateName: "VIP", EstShippingPrice: 10, SpecialShippingRate: 5 }).rec!.row).toMatchObject({ billing_basis: "special", special_price_usd: "10.00", special_rate_usd: "5.0000" });
    expect(cats(item({ Weight: -1 }))).toEqual(["INVALID_DIMENSION"]);
    expect(cats(item({ EstPrice: "1.005" }))).toEqual(["INVALID_MONEY"]);
    expect(cats(item({ Status: "Lost" }))).toEqual(["UNKNOWN_STATUS"]);
    expect(cats(item({ Quantity: 0 }))).toEqual(["INVALID_VALUE"]);
    expect(cats(item({ Quantity: 1.5 }))).toEqual(["INVALID_VALUE"]);
    expect(cats(item({ DateReceived: "yesterday" }))).toEqual(["INVALID_DATE"]);
    expect(cats(item({ Customer: [] }))).toEqual(["MISSING_CUSTOMER_REFERENCE"]);
    expect(cats(item({ Customer: ["a", "b"] }))).toEqual(["INVALID_LINK"]);
    expect(cats(item({ Customer: "recC" }))).toEqual(["INVALID_LINK"]);
    expect(cats(item({ Customer: ["bad id with spaces"] }))).toEqual(["INVALID_LINK"]);
    expect(item({ PkgEstShipping: 0 }).rec!.row.tier_price_usd).toBeNull();                                // zero is "no price", not a price
  });
  it("orders keep Airtable's amounts only as claims; special rates never invent a customer or validity; settings enforce FX bounds", () => {
    const o = N.normalizeOrder(rec("recO", { OrderRef: "ORD-1", Customer: ["recC"], InvoiceAmount: 100, Status: "Paid", InvoiceDate: "2026-01-01", AmountPaid: 100 }) as never);
    expect((o.rec as any).claim).toMatchObject({ InvoiceAmount: "100.00", AmountPaid: "100.00" });
    expect(JSON.stringify(o.rec!.row)).not.toMatch(/total|subtotal|fx/);
    expect(cats(N.normalizeOrder(rec("recO", { OrderRef: "ORD-1", Customer: ["recC"], Status: "Refunded", InvoiceDate: "2026-01-01" }) as never))).toEqual(["UNKNOWN_STATUS"]);
    const sr = N.normalizeSpecialRate(rec("recS", { Name: "Gold", Sea: 300, Air: 0 }) as never);
    expect(sr.rec!.row).toMatchObject({ sea_rate_usd: "300.0000", air_rate_usd: null, provenance: "legacy_ambiguous" });
    expect(sr.rec!.row.provenance_note).toMatch(/not inferred/);
    expect(cats(N.normalizeSpecialRate(rec("recS", { Name: "Nope", Sea: 0, Air: 0 }) as never))).toEqual(["INVALID_SPECIAL_RATE"]);
    expect(cats(N.normalizeSpecialRate(rec("recS", { Name: "Neg", Sea: -1 }) as never))).toEqual(["INVALID_SPECIAL_RATE"]);
    for (const bad of [0, -1, 0.05, 1001, "x"]) expect(cats(N.normalizeSettings(rec("recX", { UsdToGhs: bad }) as never)), String(bad)).toContain("INVALID_FX");
    expect(N.normalizeSettings(rec("recX", { UsdToGhs: 12.5 }) as never).rec!.row.rate).toBe("12.50000000");
    expect(cats(N.normalizeSettings(rec("recX", {}) as never))).toEqual(["INVALID_FX"]);                   // missing is an error, never 1
  });
  it("verified financial tables enforce the locked money model", () => {
    const vi = (f: Record<string, unknown>) => N.normalizeVerifiedInvoice(rec("v", { OrderRecordID: "recO", SubtotalUsd: 100, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 1250, ...f }) as never);
    expect(vi({}).rec!.row).toMatchObject({ total_ghs: "1250.00", fx_rate: "12.50000000", fx_estimated: false });
    expect(cats(vi({ TotalGhs: 1249.99 }))).toEqual(["INVALID_MONEY"]);                                    // not recomputed: refused
    expect(cats(vi({ DiscountUsd: 150, TotalGhs: 0 }))).toEqual(["INVALID_MONEY"]);
    expect(cats(vi({ DiscountUsd: 10, TotalGhs: 1125 }))).toEqual(["INVALID_MONEY"]);                       // discount without its reason
    expect(vi({ DiscountUsd: 10, DiscountReason: "promo", TotalGhs: 1125 }).rec).not.toBeNull();
    expect(cats(vi({ FxRate: 0 }))).toContain("INVALID_FX");
    expect(cats(vi({ FxRate: 5000 }))).toContain("INVALID_FX");
    expect(cats(vi({ FxRate: undefined }))).toContain("INVALID_FX");
    expect(cats(vi({ FxEstimated: true, TotalGhs: 1300 }))).toEqual(["INVALID_FX"]);                        // estimated needs an explanation
    expect(vi({ FxEstimated: true, Note: "nearest day", TotalGhs: 1300 }).rec!.row).toMatchObject({ fx_estimated: true, total_ghs: "1300.00" });
    expect(vi({ SubtotalUsd: 0.01, FxRate: 0.5, TotalGhs: 0.01 }).rec).not.toBeNull();                      // half-up like the database
    const pay = (f: Record<string, unknown>) => N.normalizeVerifiedPayment(rec("p", { PaymentKey: "K", OrderRecordID: "recO", AmountGhs: 10, Currency: "GHS", PaidAt: "2026-01-01T00:00:00Z", Status: "completed", ...f }) as never);
    expect(pay({}).rec).not.toBeNull();
    expect(cats(pay({ Currency: "USD" }))).toEqual(["UNEXPECTED_CURRENCY"]);
    expect(cats(pay({ AmountGhs: 0 }))).toEqual(["INVALID_PAYMENT"]);
    expect(cats(pay({ AmountGhs: -5 }))).toEqual(["INVALID_PAYMENT"]);
    expect(cats(pay({ Status: "pending" }))).toEqual(["INVALID_PAYMENT_STATE"]);
    expect(cats(pay({ Status: "voided" }))).toEqual(["INVALID_PAYMENT_STATE", "INVALID_PAYMENT_STATE"]);
    expect(cats(pay({ Status: "voided", VoidedAt: "2025-01-01T00:00:00Z", VoidReason: "x" }))).toEqual(["INVALID_PAYMENT_STATE"]);
    expect(cats(pay({ VoidedAt: "2026-02-01T00:00:00Z" }))).toEqual(["INVALID_PAYMENT_STATE"]);
    expect(cats(pay({ PaidAt: "tomorrow" }))).toEqual(["INVALID_DATE"]);
    const line = (f: Record<string, unknown>) => N.normalizeVerifiedLine(rec("l", { LineKey: "L", OrderRecordID: "recO", LineNo: 1, Description: "d", UnitPriceUsd: 10, BillingBasis: "tier", ...f }) as never);
    expect(line({ Quantity: 2.5, UnitPriceUsd: 3.33 }).rec!.row.line_total_usd).toBe("8.33");
    expect(cats(line({ ItemRecordID: "recI", CartonNumber: "C" }))).toEqual(["INVALID_VALUE"]);
    expect(cats(line({ BillingBasis: "special" }))).toEqual(["INVALID_SPECIAL_RATE"]);
    expect(cats(line({ UnitPriceUsd: 0 }))).toEqual(["INVALID_MONEY"]);
  });
  it("history: dates are required, record types are validated, an invalid IP is rejected", () => {
    expect(cats(N.normalizeStatusHistory(rec("h", { RecordType: "Item", RecordID: "recI", NewStatus: "x", ChangedAt: "nope" }) as never))).toEqual(["INVALID_DATE"]);
    expect(cats(N.normalizeStatusHistory(rec("h", { RecordType: "Spaceship", RecordID: "recI", NewStatus: "x", ChangedAt: "2026-01-01T00:00:00Z" }) as never))).toEqual(["UNKNOWN_RECORD_TYPE"]);
    expect(N.normalizeStatusHistory(rec("h", { RecordType: "Order", RecordID: "recO", NewStatus: "Paid", ChangedAt: "2026-01-01T00:00:00Z" }) as never).rec!.row.entity_type).toBe("invoice");
    expect(cats(N.normalizeActivityLog(rec("a", { Action: "X", Timestamp: "2026-01-01T00:00:00Z", IPAddress: "300.1.1.1" }) as never))).toEqual(["INVALID_VALUE"]);
    expect(N.normalizeActivityLog(rec("a", { Action: "X", Timestamp: "2026-01-01T00:00:00Z", IPAddress: "2001:db8::1" }) as never).rec).not.toBeNull();
  });
});

describe("validation and quarantine on the synthetic snapshot", () => {
  const e = entriesOf(buildMessySnapshot());
  const has = (table: string, id: string, category: string, severity = "blocking") => find(e, table, id).some((x) => x.category === category && x.severity === severity);
  it("the clean snapshot has nothing to quarantine and nothing to review", () => {
    const entries = collectEntries(prepare(parse(buildCleanSnapshot())).st).filter((x) => x.severity !== "deferred");
    expect(entries).toEqual([]);
  });
  it("catches every kind of invalid record the brief lists, with source table, record id, reason and category", () => {
    expect(has("Customers", "recC4", "DUPLICATE_CUSTOMER")).toBe(true);
    expect(has("Customers", "recC5", "DUPLICATE_CUSTOMER")).toBe(true);
    expect(has("Customers", "recC6", "MISSING_REQUIRED_FIELD")).toBe(true);
    expect(has("Customers", "recC7", "INVALID_SHIPPING_MARK")).toBe(true);
    expect(has("Customers", "recC8", "MISSING_WAREHOUSE")).toBe(true);
    expect(has("Customers", "recC9", "UNKNOWN_STATUS")).toBe(true);
    expect(has("Customers", "recC13", "INVALID_EMAIL")).toBe(true);
    expect(has("Customers", "recC10", "NONSTANDARD_SHIPPING_MARK", "review")).toBe(true);
    expect(has("Customers", "recC11", "UNEXPECTED_FIELD", "review")).toBe(true);
    expect(find(e, "Customers", "recC3")).toEqual([]);                                                       // inactive but valid
    expect(has("Items", "recI14", "ORPHAN_ITEM")).toBe(true);
    expect(has("Items", "recI15", "MISSING_CUSTOMER_REFERENCE")).toBe(true);
    expect(has("Items", "recI16", "UNKNOWN_STATUS")).toBe(true);
    expect(has("Items", "recI18", "INVALID_DIMENSION")).toBe(true);
    expect(has("Items", "recI19", "INVALID_CARTON")).toBe(true);
    expect(has("Items", "recI20", "CONFLICTING_IDENTITY")).toBe(true);
    expect(has("Items", "recI21", "CONFLICTING_IDENTITY")).toBe(true);
    expect(has("Items", "recI22", "INVALID_DATE")).toBe(true);
    expect(has("Items", "recI23", "MISSING_CONTAINER")).toBe(true);
    expect(has("Items", "recI24", "CUSTOMER_QUARANTINED")).toBe(true);
    expect(has("Items", "recI26", "INVALID_MONEY")).toBe(true);
    expect(has("Items", "recI27", "UNSAFE_CONTENT")).toBe(true);
    expect(has("Items", "recI28", "UNSAFE_CONTENT")).toBe(true);
    expect(has("Containers", "recK3", "DUPLICATE_CONTAINER")).toBe(true);
    expect(has("Containers", "recK4", "DUPLICATE_CONTAINER")).toBe(true);
    expect(has("Containers", "recK5", "UNKNOWN_STATUS")).toBe(true);
    expect(has("Containers", "recK6", "INVALID_DATE")).toBe(true);
    expect(has("Suppliers", "recS3", "CONFLICTING_IDENTITY")).toBe(true);
    expect(has("Suppliers", "recS2", "INVALID_VALUE")).toBe(true);
    expect(has("PackageRates", "recP3", "INVALID_MONEY")).toBe(true);
    expect(has("PackageRates", "recP4", "UNKNOWN_TIER")).toBe(true);
    expect(has("SpecialRates", "recSR2", "INVALID_SPECIAL_RATE")).toBe(true);
    expect(find(e, "SpecialRates", "recSR3").every((x) => x.severity === "review")).toBe(true);
    expect(has("Warehouses", "recW3", "MISSING_REQUIRED_FIELD")).toBe(true);
    for (const x of e) { expect(x.table).toBeTruthy(); expect(x.sourceId).toBeTruthy(); expect(x.reason.length).toBeGreaterThan(5); expect(x.category).toMatch(/^[A-Z][A-Z0-9_]+$/); }
  });
  it("financial records without proof are quarantined, never guessed", () => {
    expect(has("Orders", "recO6", "MISSING_VERIFIED_FINANCIALS")).toBe(true);
    expect(has("Orders", "recO7", "MISSING_VERIFIED_FINANCIALS")).toBe(true);        // its verified total did not match round(subtotal x fx)
    expect(has("VerifiedInvoices", "vi7", "INVALID_MONEY")).toBe(true);
    expect(has("Orders", "recO8", "CANCELLED_WITH_PAYMENT")).toBe(true);
    expect(has("Orders", "recO9", "OVERPAYMENT")).toBe(true);
    expect(has("Orders", "recO12", "UNKNOWN_STATUS")).toBe(true);
    expect(has("Orders", "recO13", "INVALID_DATE")).toBe(true);
    expect(has("VerifiedInvoices", "vi99", "ORPHAN_FINANCIAL_RECORD")).toBe(true);
    expect(has("VerifiedPayments", "vp7", "UNEXPECTED_CURRENCY")).toBe(true);
    expect(has("VerifiedPayments", "vp8", "INVALID_PAYMENT")).toBe(true);
    expect(has("VerifiedPayments", "vp9", "INVALID_PAYMENT_STATE")).toBe(true);
    expect(has("VerifiedPayments", "vp10", "ORPHAN_PAYMENT")).toBe(true);
    expect(has("Orders", "recODUP", "DUPLICATE_SOURCE_ID")).toBe(true);
  });
  it("children of a quarantined parent are quarantined too (no placeholder parents, no double-billing)", () => {
    expect(has("Items", "recI8", "INVOICE_QUARANTINED")).toBe(true);
    expect(has("Items", "recI9", "INVOICE_QUARANTINED")).toBe(true);
    expect(has("Items", "recI10", "INVOICE_QUARANTINED")).toBe(true);
    expect(has("Items", "recI13", "INVOICE_QUARANTINED")).toBe(true);
    expect(has("StatusHistory", "recH7", "PARENT_QUARANTINED")).toBe(true);
    expect(has("StatusHistory", "recH4", "ORPHAN_STATUS_EVENT")).toBe(true);
    expect(has("StatusHistory", "recH5", "INVALID_DATE")).toBe(true);
    expect(has("StatusHistory", "recH6", "UNKNOWN_RECORD_TYPE")).toBe(true);
  });
  it("identity is deferred by design: users are never importable, roles are never assigned", () => {
    for (const id of ["recU1", "recU2", "recU3", "recU4", "recU5"]) expect(has("Users", id, "IDENTITY_NOT_IMPORTED", "deferred"), id).toBe(true);
    expect(has("Users", "recU1", "PRIVILEGED_ROLE_NOT_IMPORTED", "deferred")).toBe(true);
    expect(has("Users", "recU3", "CONFLICTING_IDENTITY", "review")).toBe(true);        // two users share one e-mail
    expect(has("Users", "recU4", "MISSING_CUSTOMER_REFERENCE", "review")).toBe(true);
    expect(has("PendingRegistrations", "recR1", "DEFERRED_TABLE", "deferred")).toBe(true);
    const p = prepare(parse(buildMessySnapshot()));
    expect(p.st.validList("Users")).toEqual([]);
  });
  it("is deterministic: the same snapshot in any record order gives identical, ordered output", () => {
    const shuffled = buildMessySnapshot();
    for (const t of Object.keys(shuffled.tables)) (shuffled.tables as any)[t].reverse();
    const a = JSON.stringify(entriesOf(buildMessySnapshot())); const b = JSON.stringify(entriesOf(shuffled));
    expect(b).toBe(a);
    const ra = reportToJson(reportOf(buildMessySnapshot())); const rb = reportToJson(reportOf(shuffled));
    expect(rb).toBe(ra);
  });
});

function reportOf(snap: unknown) {
  const s = parse(snap); const p = prepare(s);
  return buildReport({ snapshot: s, discovery: p.discovery, fingerprint: p.fingerprint, st: p.st, entries: collectEntries(p.st), decision: { ok: true, environment: "test", mode: "dry-run", checks: [] } as never, scope: "source" });
}

describe("cartons are derived from item labels", () => {
  const p = prepare(parse(buildMessySnapshot()));
  it("groups items by CartonNumber, takes the carton price from the member shares, invoices the carton with its invoice", () => {
    const c1 = p.st.cartons.find((c: any) => c.number === "CTN-0001")!;
    expect(c1.memberIds.sort()).toEqual(["recI6", "recI7"]);
    expect(c1.row).toMatchObject({ freight_type: "sea", length: "100.00", status: "invoiced", price_usd: "175.00", package_tier: "basic" });
    expect(c1.rels.order).toBe("recO5");
    const c3 = p.st.cartons.find((c: any) => c.number === "CTN-0003")!;
    expect(c3.row.status).toBe("open");
    expect(c3.rels.container).toBe("recK2");
  });
  it("quarantines inconsistent cartons together with their members", () => {
    const s = buildCleanSnapshot();
    (s.tables.Items as any[]).find((i: any) => i.id === "recI31").fields.CartonLength = 999;
    const e = entriesOf(s);
    expect(find(e, "Cartons", "carton:CTN-0003").map((x) => x.category)).toEqual(["INVALID_CARTON"]);
    expect(find(e, "Items", "recI30").map((x) => x.category)).toEqual(["INVALID_CARTON"]);
    const t = buildCleanSnapshot();
    (t.tables.Items as any[]).find((i: any) => i.id === "recI31").fields.Customer = ["recC1"];
    expect(find(entriesOf(t), "Cartons", "carton:CTN-0003")[0].category).toBe("CONFLICTING_IDENTITY");
  });
});

describe("financial analysis (locked money model: invoice GHS - completed GHS payments = balance)", () => {
  const pay = (id: string, amount: string, paid: string, status = "completed", voided: string | null = null) => ({ sourceId: id, row: { amount_ghs: amount, paid_at: paid, status, voided_at: voided } });
  it("derives paid / outstanding / status and reports claims that disagree - without repairing them", () => {
    const a = analyzeInvoice({ totalGhs: "1250.00", cancelled: false, payments: [pay("p1", "500.00", "2026-01-01T00:00:00.000Z")], sourceStatus: "Paid", claim: { AmountPaid: "1250.00", BalanceDue: "0.00" } });
    expect(a).toMatchObject({ paidUnits: BigInt(50000), outstandingUnits: BigInt(75000), derivedStatus: "Partial", blocking: [] });
    expect(a.discrepancies.map((d: any) => d.category)).toEqual(["STATUS_MISMATCH", "PAID_AMOUNT_MISMATCH", "BALANCE_MISMATCH"]);
  });
  it("blocks overpayment, payments on cancelled or zero-value invoices; a void frees the balance for a later payment", () => {
    expect(analyzeInvoice({ totalGhs: "100.00", cancelled: false, payments: [pay("a", "60.00", "2026-01-01T00:00:00.000Z"), pay("b", "60.00", "2026-01-02T00:00:00.000Z")] }).blocking[0].category).toBe("OVERPAYMENT");
    const reuse = analyzeInvoice({ totalGhs: "100.00", cancelled: false, payments: [pay("a", "100.00", "2026-01-01T00:00:00.000Z", "voided", "2026-01-03T00:00:00.000Z"), pay("b", "100.00", "2026-01-03T00:00:00.000Z")] });
    expect(reuse.blocking).toEqual([]);
    expect(reuse).toMatchObject({ paidUnits: BigInt(10000), derivedStatus: "Paid" });
    expect(analyzeInvoice({ totalGhs: "100.00", cancelled: true, payments: [pay("a", "10.00", "2026-01-01T00:00:00.000Z")] }).blocking[0].category).toBe("CANCELLED_WITH_PAYMENT");
    expect(analyzeInvoice({ totalGhs: "100.00", cancelled: true, payments: [pay("a", "10.00", "2026-01-01T00:00:00.000Z", "voided", "2026-01-02T00:00:00.000Z")] }).blocking).toEqual([]);
    expect(analyzeInvoice({ totalGhs: "0.00", cancelled: false, payments: [pay("a", "1.00", "2026-01-01T00:00:00.000Z")] }).blocking[0].category).toBe("PAYMENT_ON_ZERO_INVOICE");
    expect(analyzeInvoice({ totalGhs: "0.00", cancelled: false, payments: [] })).toMatchObject({ derivedStatus: "Paid", outstandingUnits: BigInt(0) });
    expect(analyzeInvoice({ totalGhs: "50.00", cancelled: true, payments: [] })).toMatchObject({ derivedStatus: "Cancelled", outstandingUnits: BigInt(0) });
  });
  it("replays a void that carries the payment's own instant after the payment", () => {
    const ev = paymentEvents([pay("a", "10.00", "2026-01-01T00:00:00.000Z", "voided", "2026-01-01T00:00:00.000Z")] as never);
    expect(ev.map((e: any) => e.kind)).toEqual(["pay", "void"]);
  });
});

describe("readiness verdicts are strict", () => {
  it("READY needs zero quarantine and zero warnings; warnings alone give READY_WITH_REVIEW; financial/identity/database problems give NOT_READY", () => {
    expect(reportOf(buildCleanSnapshot())).toMatchObject({ verdict: "READY", scope: "source", reasons: [] });
    const warn = buildCleanSnapshot(); (warn.tables.Customers as any[])[0].fields.Surprise = "x";
    expect(reportOf(warn)).toMatchObject({ verdict: "READY_WITH_REVIEW" });
    const soft = buildCleanSnapshot(); (soft.tables.Items as any[]).push({ id: "recIX", fields: { ItemRef: "ITM-0099", Customer: ["recC1"], Status: "Lost" } });
    expect(reportOf(soft)).toMatchObject({ verdict: "READY_WITH_REVIEW" });                    // a non-financial exclusion: needs a human decision
    const fin = buildCleanSnapshot(); (fin.tables.VerifiedInvoices as any[]).pop();            // an order loses its financial proof
    expect(reportOf(fin)).toMatchObject({ verdict: "NOT_READY" });
    const id = buildCleanSnapshot(); (id.tables.Customers as any[]).push({ id: "recCX", fields: { Name: "Dup", ShippingMark: "MOVEZZ-AM1234" } });
    expect(reportOf(id)).toMatchObject({ verdict: "NOT_READY" });
    const mismatch = buildCleanSnapshot(); (mismatch.tables.Orders as any[])[1].fields.AmountPaid = 1;
    expect(reportOf(mismatch)).toMatchObject({ verdict: "NOT_READY" });
    expect(reportOf(buildMessySnapshot()).verdict).toBe("NOT_READY");
  });
  it("a failed environment decision is NOT_READY regardless of the data", () => {
    const s = parse(buildCleanSnapshot()); const p = prepare(s);
    const r = buildReport({ snapshot: s, discovery: p.discovery, fingerprint: p.fingerprint, st: p.st, entries: [], decision: { ok: false, environment: null, mode: "dry-run", checks: [{ name: "x", ok: false, detail: "y" }] } as never, scope: "source" });
    expect(r.verdict).toBe("NOT_READY");
  });
  it("source numbers add up: discovered = valid + quarantined + deferred, per table and in total", () => {
    const r = reportOf(buildMessySnapshot());
    for (const [t, v] of Object.entries<any>(r.source.tables)) expect(v.valid + v.quarantined + v.deferred, t).toBe(v.discovered);
    expect(r.source.totals.discovered).toBe(r.source.totals.valid + r.source.totals.quarantined + r.source.totals.deferred);
    expect(r.identity.usersDeferred).toBe(5);
  });
});

describe("importer actor assertion", () => {
  it("matches the format the database verifies (parity with src/lib/db/actor.ts)", () => {
    const key = Buffer.alloc(32, 7);
    const a = mintImportAssertion(key, "import:abc:1");
    const msg = assertionMessage({ type: "import", userId: null, requestId: a.requestId, jti: a.jti, exp: a.exp });
    expect(a.sig).toBe(createHmac("sha256", key).update(msg, "utf8").digest("hex"));
    expect(a).toMatchObject({ type: "import", userId: null });
    expect(() => mintImportAssertion(key, "has space")).toThrow();
  });
});

describe("the importer cannot reach any external system", () => {
  it("has no Airtable/Firebase/Keepup/Cloudinary client, no fetch and no HTTP code in its source", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = path.resolve(__dirname, "../../scripts/lib/import");
    for (const f of await readdir(dir)) {
      const src = await readFile(path.join(dir, f), "utf8");
      const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
      expect(code, f).not.toMatch(/\bfetch\s*\(|node:https?|from "airtable"|api\.airtable|XMLHttpRequest|WebSocket|dgram|child_process/i);
      expect(code, f).not.toMatch(/from "(airtable|firebase[^"]*|cloudinary[^"]*|resend|\.\.\/\.\.\/\.\.\/src\/lib\/(airtable|keepup|firebase[^"]*|email))"|keepup\.store|googleapis/i);
    }
  });
});
