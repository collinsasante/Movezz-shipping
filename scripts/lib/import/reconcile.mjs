// Stage 7 - RECONCILIATION: the normalized source (what SHOULD be in PostgreSQL) against what IS in PostgreSQL.
//
// Not just row counts: every table is compared by a deterministic fingerprint of its business columns (identity, relationships, money,
// status), and the money is re-derived independently per invoice in the locked model (GHS total - completed GHS payments = balance).
// Nothing is repaired: every difference is reported. All queries are read-only.
import { analyzeInvoice } from "./financial.mjs";
import { fingerprint, sha256Hex, unitsToText } from "./util.mjs";

const TS = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const nz = (v) => (v === null || v === undefined ? "" : String(v));
const lines = (rows) => sha256Hex(rows.map((r) => r.map(nz).join("|")).sort().join("\n"));
const K = (t, id) => `${t}\u0000${id}`;

/** What the target SHOULD contain, from the validated source state (minus records the database rejected during this run). */
export function expectedState(st, failed = new Set()) {
  const ok = (t) => st.validList(t).filter((r) => !failed.has(K(t, r.sourceId)));
  const verified = new Map(st.validList("VerifiedInvoices").map((v) => [v.rels.order, v]));
  const payByOrder = new Map(); for (const p of ok("VerifiedPayments")) (payByOrder.get(p.rels.order) ?? payByOrder.set(p.rels.order, []).get(p.rels.order)).push(p);
  const invoices = ok("Orders").filter((o) => verified.has(o.sourceId)).map((o) => {
    const v = verified.get(o.sourceId); const cancelled = o.sourceStatus === "Cancelled";
    const fin = analyzeInvoice({ totalGhs: v.row.total_ghs, cancelled, payments: payByOrder.get(o.sourceId) ?? [], sourceStatus: o.sourceStatus, claim: o.claim });
    return { o, v, fin, cancelled };
  });
  const cust = (id) => id ?? "";
  const cartonOf = new Map(); for (const k of st.cartons) for (const m of k.memberIds) cartonOf.set(m, k);
  const cancelledOrder = (id) => st.rec("Orders", id)?.sourceStatus === "Cancelled";
  return {
    invoices,
    fp: {
      Customers: lines(ok("Customers").map((r) => [r.sourceId, r.row.shipping_mark, r.row.name, r.row.phone, r.row.email?.toLowerCase(), r.row.status, r.row.package_tier, r.row.shipping_address])),
      Containers: lines(ok("Containers").map((r) => [r.sourceId, r.row.container_ref, r.row.container_number, r.row.shipping_line, r.row.status, r.row.eta, r.row.arrival_date])),
      Cartons: lines(st.cartons.filter((k) => !failed.has(K("Cartons", k.sourceId))).map((k) => [k.sourceId, k.row.carton_ref, k.rels.customer, cust(k.rels.container), k.row.freight_type, k.row.length, k.row.width, k.row.height, k.row.weight_kg, k.row.status, cust(k.rels.order)])),
      Items: lines(ok("Items").map((i) => [i.sourceId, i.row.item_ref, i.rels.customer, cust(i.rels.container), cartonOf.get(i.sourceId)?.number, i.rels.order && !cancelledOrder(i.rels.order) ? i.rels.order : "", i.row.status, i.row.freight_type,
        i.row.tier_price_usd, i.row.special_price_usd, i.row.billing_basis, i.row.weight_kg, i.row.quantity])),
      Orders: lines(invoices.map(({ o, v, fin }) => [o.sourceId, o.row.invoice_ref, o.rels.customer, v.row.subtotal_usd, v.row.discount_usd, v.row.discount_reason, v.row.fx_rate, v.row.total_ghs, o.row.keepup_sale_id, fin.derivedStatus, unitsToText(fin.paidUnits, 2), v.row.fx_estimated ? "estimated" : "legacy_known"])),
      VerifiedPayments: lines(ok("VerifiedPayments").map((p) => [p.sourceId, p.rels.order, p.row.amount_ghs, p.row.status, p.row.paid_at, p.row.method, p.row.voided_at])),
      VerifiedInvoiceLines: lines(ok("VerifiedInvoiceLines").map((l) => [l.key, l.rels.order, l.row.line_no, l.row.quantity, l.row.unit_price_usd, l.row.line_total_usd, l.row.billing_basis])),
      StatusHistory: lines(ok("StatusHistory").map((e) => [e.sourceId, e.row.entity_type, e.row.old_status, e.row.new_status, e.row.occurred_at])),
    },
    counts: {
      Warehouses: ok("Warehouses").length, Suppliers: ok("Suppliers").length, PackageRates: ok("PackageRates").length * 2, Settings: ok("Settings").length, SpecialRates: ok("SpecialRates").length, Customers: ok("Customers").length,
      Containers: ok("Containers").length, Cartons: st.cartons.filter((k) => !failed.has(K("Cartons", k.sourceId))).length, Items: ok("Items").length, ItemPhotos: st.photos.filter((p) => !failed.has(K("ItemPhotos", p.sourceId))).length,
      Orders: invoices.length, VerifiedInvoiceLines: ok("VerifiedInvoiceLines").length, VerifiedPayments: ok("VerifiedPayments").length, StatusHistory: ok("StatusHistory").length, ActivityLogs: ok("ActivityLogs").length,
    },
    ids: {
      Customers: ok("Customers").map((r) => r.sourceId), Orders: invoices.map((i) => i.o.sourceId), Items: ok("Items").map((r) => r.sourceId), Containers: ok("Containers").map((r) => r.sourceId),
    },
  };
}

const TARGET = { Warehouses: "warehouses", Suppliers: "suppliers", PackageRates: "package_rates", Settings: "fx_rates", SpecialRates: "special_rates", Customers: "customers", Containers: "containers", Cartons: "cartons", Items: "items",
  ItemPhotos: "item_photos", Orders: "invoices", VerifiedInvoiceLines: "invoice_lines", VerifiedPayments: "payments", StatusHistory: "status_events", ActivityLogs: "audit_logs" };

/** Read-only comparison. `client` must be a connection to the TARGET database; the caller wraps it in a READ ONLY transaction. */
export async function reconcile(client, st, { failed = new Set(), batchId = null, quarantineExpected = null } = {}) {
  const exp = expectedState(st, failed);
  const checks = []; const add = (name, ok, expected, actual, detail = "") => checks.push({ name, ok, expected, actual, detail });
  const q = async (sql, p) => (await client.query(sql, p)).rows;

  // ---- counts: mapped rows, and that each mapped row really exists in its target table ----
  for (const [src, n] of Object.entries(exp.counts)) {
    const mapped = Number((await q("SELECT count(*)::int AS n FROM import_records WHERE source_table = $1", [src]))[0].n);
    const present = Number((await q(`SELECT count(*)::int AS n FROM import_records r JOIN ${TARGET[src]} t ON t.id::text = r.target_id WHERE r.source_table = $1`, [src]))[0].n);
    add(`count ${src}`, mapped === n && present === n, n, mapped === present ? mapped : `${mapped} mapped / ${present} present`);
  }
  // ---- identifiers: the exact set of mapped source ids ----
  for (const [src, ids] of Object.entries(exp.ids)) {
    const got = new Set((await q("SELECT source_id FROM import_records WHERE source_table = $1", [src])).map((r) => r.source_id));
    const want = new Set(ids);
    const missing = [...want].filter((x) => !got.has(x)).sort(); const extra = [...got].filter((x) => !want.has(x)).sort();
    add(`identifiers ${src}`, !missing.length && !extra.length, want.size, got.size, missing.length || extra.length ? `missing: ${missing.slice(0, 5).join(",")} extra: ${extra.slice(0, 5).join(",")}` : "");
  }
  // ---- content fingerprints ----
  const dbFp = await databaseFingerprints(client);
  for (const t of Object.keys(dbFp)) add(`fingerprint ${t}`, dbFp[t] === exp.fp[t], exp.fp[t].slice(0, 12), dbFp[t].slice(0, 12));

  // ---- financial reconciliation (independent re-derivation per invoice) ----
  const fin = { invoices: exp.invoices.length, sourceTotalGhs: 0n, sourcePaidGhs: 0n, sourceOutstandingGhs: 0n, cancelled: 0, discrepancies: [], mismatches: [] };
  const dbInv = new Map((await q("SELECT legacy_airtable_id AS sid, total_ghs::text AS t, amount_paid_ghs::text AS p, balance_ghs::text AS b, status FROM invoices WHERE legacy_airtable_id IS NOT NULL")).map((r) => [r.sid, r]));
  let dbTotal = 0n, dbPaid = 0n, dbOut = 0n, dbCancelled = 0;
  for (const { o, v, fin: f, cancelled } of exp.invoices) {
    fin.sourceTotalGhs += f.totalUnits; fin.sourcePaidGhs += f.paidUnits; if (!cancelled) fin.sourceOutstandingGhs += f.outstandingUnits; else fin.cancelled++;
    for (const d of f.discrepancies) fin.discrepancies.push({ invoice: o.row.invoice_ref, sourceId: o.sourceId, ...d });
    const r = dbInv.get(o.sourceId);
    if (!r) { fin.mismatches.push({ invoice: o.row.invoice_ref, what: "invoice missing in the target" }); continue; }
    const want = { total: v.row.total_ghs, paid: unitsToText(f.paidUnits, 2), status: f.derivedStatus };
    if (r.t !== want.total) fin.mismatches.push({ invoice: o.row.invoice_ref, what: `total GHS ${r.t} != ${want.total}` });
    if (r.p !== want.paid) fin.mismatches.push({ invoice: o.row.invoice_ref, what: `paid GHS ${r.p} != ${want.paid}` });
    if (r.status !== want.status) fin.mismatches.push({ invoice: o.row.invoice_ref, what: `status ${r.status} != ${want.status}` });
    // balance = total - valid payments, in GHS, exactly
    if (!cancelled && r.b !== unitsToText(f.totalUnits - f.paidUnits, 2)) fin.mismatches.push({ invoice: o.row.invoice_ref, what: `balance GHS ${r.b} != ${unitsToText(f.totalUnits - f.paidUnits, 2)}` });
  }
  for (const r of dbInv.values()) { const cents = (x) => BigInt(x.replace(".", "")); dbTotal += cents(r.t); dbPaid += cents(r.p); if (r.status !== "Cancelled") dbOut += cents(r.b); else dbCancelled++; }
  add("money: Σ invoice total GHS", dbTotal === fin.sourceTotalGhs, unitsToText(fin.sourceTotalGhs, 2), unitsToText(dbTotal, 2));
  add("money: Σ completed payments GHS", dbPaid === fin.sourcePaidGhs, unitsToText(fin.sourcePaidGhs, 2), unitsToText(dbPaid, 2));
  add("money: Σ outstanding GHS (non-cancelled)", dbOut === fin.sourceOutstandingGhs, unitsToText(fin.sourceOutstandingGhs, 2), unitsToText(dbOut, 2));
  add("cancelled invoices", dbCancelled === fin.cancelled, fin.cancelled, dbCancelled);
  add("per-invoice financials (total, paid, balance, status)", fin.mismatches.length === 0, 0, fin.mismatches.length, fin.mismatches.slice(0, 5).map((m) => `${m.invoice}: ${m.what}`).join("; "));

  // ---- integrity inside the target ----
  const integ = {};
  const one = async (name, sql, bad = (n) => n === 0) => { const n = Number((await q(sql))[0].n); integ[name] = n; add(`integrity: ${name}`, bad(n), 0, n); };
  await one("invoices whose payments do not add up to amount_paid", `SELECT count(*)::int AS n FROM invoices i WHERE i.amount_paid_ghs <> coalesce((SELECT sum(amount_ghs) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed'), 0)`);
  await one("completed payments on cancelled invoices", `SELECT count(*)::int AS n FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.status = 'Cancelled' AND p.status = 'completed'`);
  await one("invoices whose lines do not add up to the subtotal", `SELECT count(*)::int AS n FROM invoices i WHERE EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id) AND i.subtotal_usd <> (SELECT sum(line_total_usd) FROM invoice_lines l WHERE l.invoice_id = i.id)`);
  await one("cancelled invoices that still hold items or cartons", `SELECT count(*)::int AS n FROM invoices i WHERE i.status = 'Cancelled' AND (EXISTS (SELECT 1 FROM items x WHERE x.invoice_id = i.id) OR EXISTS (SELECT 1 FROM cartons c WHERE c.invoice_id = i.id))`);
  await one("items owned by a different customer than their invoice or carton", `SELECT count(*)::int AS n FROM items x LEFT JOIN invoices i ON i.id = x.invoice_id LEFT JOIN cartons c ON c.id = x.carton_id WHERE (i.id IS NOT NULL AND i.customer_id <> x.customer_id) OR (c.id IS NOT NULL AND c.customer_id <> x.customer_id)`);
  await one("import mappings whose target row is missing", `SELECT (${Object.entries(TARGET).map(([s, t]) => `(SELECT count(*) FROM import_records r WHERE r.source_table = '${s}' AND NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.id::text = r.target_id))`).join(" + ")})::int AS n`);
  await one("imported rows without an import mapping", `SELECT ((SELECT count(*) FROM customers c WHERE c.legacy_airtable_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_records r WHERE r.source_table='Customers' AND r.target_id = c.id::text))
      + (SELECT count(*) FROM items c WHERE c.legacy_airtable_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_records r WHERE r.source_table='Items' AND r.target_id = c.id::text))
      + (SELECT count(*) FROM invoices c WHERE c.legacy_airtable_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_records r WHERE r.source_table='Orders' AND r.target_id = c.id::text))
      + (SELECT count(*) FROM payments c WHERE c.legacy_airtable_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_records r WHERE r.source_table='VerifiedPayments' AND r.target_id = c.id::text)))::int AS n`);
  // ---- security / side effects ----
  const sec = {};
  const sone = async (name, sql) => { const n = Number((await q(sql))[0].n); sec[name] = n; add(`security: ${name}`, n === 0, 0, n); };
  await sone("users created by the import (no identity may be created)", `SELECT count(*)::int AS n FROM users WHERE legacy_airtable_id IS NOT NULL OR legacy_data IS NOT NULL`);
  await sone("Keepup sync rows for imported invoices (no Keepup activity)", `SELECT count(*)::int AS n FROM keepup_sync k JOIN import_records r ON r.source_table = 'Orders' AND r.target_id = k.invoice_id::text`);
  await sone("notifications queued for imported invoices", `SELECT count(*)::int AS n FROM notification_outbox o JOIN import_records r ON r.source_table = 'Orders' AND o.dedupe_key LIKE '%' || r.target_id || '%'`);
  await sone("imported history rows attributed to a user", `SELECT ((SELECT count(*) FROM status_events WHERE legacy_airtable_id IS NOT NULL AND (actor_type <> 'import' OR actor_user_id IS NOT NULL)) + (SELECT count(*) FROM audit_logs WHERE action LIKE 'legacy:%' AND (actor_type <> 'import' OR actor_user_id IS NOT NULL)))::int AS n`);
  await sone("imported records created by a user", `SELECT ((SELECT count(*) FROM invoices WHERE legacy_airtable_id IS NOT NULL AND (created_by IS NOT NULL OR cancelled_by IS NOT NULL)) + (SELECT count(*) FROM payments WHERE legacy_airtable_id IS NOT NULL AND (created_by IS NOT NULL OR voided_by IS NOT NULL)))::int AS n`);

  if (batchId && quarantineExpected !== null) {
    const n = Number((await q("SELECT count(*)::int AS n FROM import_quarantine WHERE batch_id = $1", [batchId]))[0].n);
    add("quarantine rows persisted for the batch", n === quarantineExpected, quarantineExpected, n);
  }
  return { checks, ok: checks.every((c) => c.ok), financial: { ...fin, sourceTotalGhs: unitsToText(fin.sourceTotalGhs, 2), sourcePaidGhs: unitsToText(fin.sourcePaidGhs, 2), sourceOutstandingGhs: unitsToText(fin.sourceOutstandingGhs, 2) }, integrity: integ, security: sec, expectedCounts: exp.counts, fingerprint: fingerprint(checks.map((c) => [c.name, c.ok])) };
}

export async function databaseFingerprints(client) {
  const q = async (sql, p) => (await client.query(sql, p)).rows;
  return {
    Customers: lines((await q(`SELECT legacy_airtable_id, shipping_mark, name, phone, lower(email) AS e, status, package_tier, shipping_address FROM customers WHERE legacy_airtable_id IS NOT NULL`)).map((r) => [r.legacy_airtable_id, r.shipping_mark, r.name, r.phone, r.e, r.status, r.package_tier, r.shipping_address])),
    Containers: lines((await q(`SELECT legacy_airtable_id, container_ref, container_number, shipping_line, status, to_char(eta,'YYYY-MM-DD') AS eta, to_char(arrival_date,'YYYY-MM-DD') AS a FROM containers WHERE legacy_airtable_id IS NOT NULL`)).map((r) => [r.legacy_airtable_id, r.container_ref, r.container_number, r.shipping_line, r.status, r.eta, r.a])),
    Cartons: lines((await q(`SELECT r.source_id, c.carton_ref, cu.legacy_airtable_id AS cu, co.legacy_airtable_id AS co, c.freight_type, c.length::text AS l, c.width::text AS w, c.height::text AS h, c.weight_kg::text AS wt, c.status, inv.legacy_airtable_id AS inv
        FROM import_records r JOIN cartons c ON c.id::text = r.target_id JOIN customers cu ON cu.id = c.customer_id LEFT JOIN containers co ON co.id = c.container_id LEFT JOIN invoices inv ON inv.id = c.invoice_id WHERE r.source_table = 'Cartons'`))
      .map((r) => [r.source_id, r.carton_ref, r.cu, r.co, r.freight_type, r.l, r.w, r.h, r.wt, r.status, r.inv])),
    Items: lines((await q(`SELECT i.legacy_airtable_id, i.item_ref, cu.legacy_airtable_id AS cu, co.legacy_airtable_id AS co, ca.carton_ref, inv.legacy_airtable_id AS inv, i.status, i.freight_type, i.tier_price_usd::text AS tp, i.special_price_usd::text AS sp, i.billing_basis, i.weight_kg::text AS w, i.quantity::text AS q
        FROM items i JOIN customers cu ON cu.id = i.customer_id LEFT JOIN containers co ON co.id = i.container_id LEFT JOIN cartons ca ON ca.id = i.carton_id LEFT JOIN invoices inv ON inv.id = i.invoice_id WHERE i.legacy_airtable_id IS NOT NULL`))
      .map((r) => [r.legacy_airtable_id, r.item_ref, r.cu, r.co, r.carton_ref, r.inv, r.status, r.freight_type, r.tp, r.sp, r.billing_basis, r.w, r.q])),
    Orders: lines((await q(`SELECT i.legacy_airtable_id, i.invoice_ref, cu.legacy_airtable_id AS cu, i.subtotal_usd::text AS s, i.discount_usd::text AS d, i.discount_reason, i.fx_rate::text AS fx, i.total_ghs::text AS t, i.keepup_sale_id, i.status, i.amount_paid_ghs::text AS p, i.provenance
        FROM invoices i JOIN customers cu ON cu.id = i.customer_id WHERE i.legacy_airtable_id IS NOT NULL`)).map((r) => [r.legacy_airtable_id, r.invoice_ref, r.cu, r.s, r.d, r.discount_reason, r.fx, r.t, r.keepup_sale_id, r.status, r.p, r.provenance])),
    VerifiedPayments: lines((await q(`SELECT p.legacy_airtable_id, inv.legacy_airtable_id AS inv, p.amount_ghs::text AS a, p.status, ${TS("p.paid_at")} AS pa, p.method, ${TS("p.voided_at")} AS va FROM payments p JOIN invoices inv ON inv.id = p.invoice_id WHERE p.legacy_airtable_id IS NOT NULL`))
      .map((r) => [r.legacy_airtable_id, r.inv, r.a, r.status, r.pa, r.method, r.va])),
    VerifiedInvoiceLines: lines((await q(`SELECT l.metadata->>'line_key' AS k, inv.legacy_airtable_id AS inv, l.line_no::text AS n, l.quantity::text AS q, l.unit_price_usd::text AS u, l.line_total_usd::text AS t, l.billing_basis FROM invoice_lines l JOIN invoices inv ON inv.id = l.invoice_id WHERE l.metadata ? 'line_key'`))
      .map((r) => [r.k, r.inv, r.n, r.q, r.u, r.t, r.billing_basis])),
    StatusHistory: lines((await q(`SELECT legacy_airtable_id, entity_type, old_status, new_status, ${TS("occurred_at")} AS at FROM status_events WHERE legacy_airtable_id IS NOT NULL AND actor_type = 'import'`)).map((r) => [r.legacy_airtable_id, r.entity_type, r.old_status, r.new_status, r.at])),
  };
}

/** A signature of everything an import wrote, independent of generated ids and timestamps: two databases with the same signature hold the same imported data. */
export async function databaseSignature(client) {
  const q = async (sql) => (await client.query(sql)).rows;
  const fps = await databaseFingerprints(client);
  const extra = {
    warehouses: lines((await q("SELECT legacy_airtable_id, name, address, country, phone, is_active FROM warehouses WHERE legacy_airtable_id IS NOT NULL")).map((r) => [r.legacy_airtable_id, r.name, r.address, r.country, r.phone, r.is_active])),
    suppliers: lines((await q("SELECT legacy_airtable_id, supplier_ref, name, rating FROM suppliers WHERE legacy_airtable_id IS NOT NULL")).map((r) => [r.legacy_airtable_id, r.supplier_ref, r.name, r.rating])),
    package_rates: lines((await q("SELECT legacy_airtable_id, tier, freight_type, rate_usd::text AS r FROM package_rates WHERE legacy_airtable_id IS NOT NULL")).map((r) => [r.legacy_airtable_id, r.tier, r.freight_type, r.r])),
    special_rates: lines((await q("SELECT legacy_airtable_id, name, sea_rate_usd::text AS s, air_rate_usd::text AS a, provenance FROM special_rates WHERE legacy_airtable_id IS NOT NULL")).map((r) => [r.legacy_airtable_id, r.name, r.s, r.a, r.provenance])),
    fx_rates: lines((await q("SELECT rate::text AS r, source FROM fx_rates WHERE source = 'airtable-settings'")).map((r) => [r.r, r.source])),
    photos: lines((await q("SELECT legacy_attachment_id, url, storage_provider FROM item_photos WHERE legacy_attachment_id IS NOT NULL")).map((r) => [r.legacy_attachment_id, r.url, r.storage_provider])),
    audit: lines((await q(`SELECT action, entity_type, after_data->'legacy'->>'source_id' AS sid, ${TS("created_at")} AS at FROM audit_logs WHERE action LIKE 'legacy:%'`)).map((r) => [r.action, r.entity_type, r.sid, r.at])),
    derivedEvents: lines((await q("SELECT e.entity_type, i.legacy_airtable_id AS inv, e.old_status, e.new_status, e.reason FROM status_events e JOIN invoices i ON i.id = e.entity_id WHERE e.legacy_airtable_id IS NULL AND e.entity_type = 'invoice'")).map((r) => [r.inv, r.old_status, r.new_status, r.reason])),
    counters: lines((await q("SELECT ref_type, scope, last_value::text AS v FROM reference_counters")).map((r) => [r.ref_type, r.scope, r.v])),
    mappings: lines((await q("SELECT source_table, source_id, target_table, content_fingerprint FROM import_records")).map((r) => [r.source_table, r.source_id, r.target_table, r.content_fingerprint])),
    cancelled: lines((await q(`SELECT legacy_airtable_id, ${TS("cancelled_at")} AS at, cancel_reason FROM invoices WHERE status = 'Cancelled' AND legacy_airtable_id IS NOT NULL`)).map((r) => [r.legacy_airtable_id, r.at, r.cancel_reason])),
  };
  return fingerprint({ fps, extra });
}
