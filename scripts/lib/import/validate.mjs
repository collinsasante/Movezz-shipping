// Stage 3b/4/5 - NORMALIZE ALL, VALIDATE across records, QUARANTINE.
//
// Rules of this stage (see docs/MIGRATION-IMPORT.md):
//   * a record is either VALID (will be imported), BLOCKED (quarantined with a reason) or DEFERRED (by design: identity)
//   * nothing is repaired, merged or re-priced; ambiguous or conflicting records are quarantined together
//   * a child of a blocked parent is blocked too (cascade, run to a fixed point) - the importer never invents a placeholder parent
//   * the result is deterministic: same snapshot -> same ordered output
import { NORMALIZERS } from "./normalize.mjs";
import { analyzeInvoice } from "./financial.mjs";
import { AIRTABLE_TABLES, VERIFIED_TABLES } from "./snapshot.mjs";
import { fingerprint, parseDecimal, unitsToText } from "./util.mjs";

export const TABLE_ORDER = [...AIRTABLE_TABLES, ...VERIFIED_TABLES];
const LEGACY_CANCEL_REASON = "Cancelled in the legacy system (no reason was recorded)";

export class ValidationState {
  constructor() { this.status = new Map(); this.entries = []; this.recs = {}; this.changed = false; this.cancelInfo = new Map(); this.info = {}; this.cartons = []; this.photos = []; }
  key(t, id) { return `${t}\u0000${id}`; }
  setRecs(t, list) { this.recs[t] = new Map(list.map((r) => [r.sourceId, r])); for (const r of list) this.status.set(this.key(t, r.sourceId), "valid"); }
  rec(t, id) { return this.recs[t]?.get(id); }
  isValid(t, id) { return this.status.get(this.key(t, id)) === "valid"; }
  exists(t, id) { return this.status.has(this.key(t, id)); }
  statusOf(t, id) { return this.status.get(this.key(t, id)) ?? "absent"; }
  validList(t) { return [...(this.recs[t]?.values() ?? [])].filter((r) => this.isValid(t, r.sourceId)).sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1)); }
  /** Marks a record blocked (idempotent per category) and returns true when this changed anything. */
  block(t, id, category, reason, field = null, severity = "blocking") {
    const k = this.key(t, id);
    if (!this.entries.some((e) => e.table === t && e.sourceId === id && e.category === category && e.field === field)) this.entries.push({ table: t, sourceId: id, category, severity, reason, field });
    if (severity === "blocking" && this.status.get(k) !== "blocked") { this.status.set(k, "blocked"); this.changed = true; return true; }
    return false;
  }
  defer(t, id, category, reason, field = null) {
    this.status.set(this.key(t, id), "deferred");
    this.entries.push({ table: t, sourceId: id, category, severity: "deferred", reason, field });
  }
  review(t, id, category, reason, field = null) {
    if (!this.entries.some((e) => e.table === t && e.sourceId === id && e.category === category && e.field === field)) this.entries.push({ table: t, sourceId: id, category, severity: "review", reason, field });
  }
}

/** Stage 3: normalizes every record of a parsed snapshot. */
export function normalizeAll(snapshot) {
  const st = new ValidationState();
  const lists = {};
  for (const p of snapshot.envelopeProblems) st.entries.push({ table: p.table, sourceId: p.sourceId, category: p.category, severity: "blocking", reason: p.reason, field: null });
  for (const u of snapshot.unknownTables) st.entries.push({ table: u.table, sourceId: "*", category: "UNKNOWN_TABLE", severity: "review", reason: `table is not part of the documented schema (${u.records} record(s) ignored)`, field: null });
  for (const table of TABLE_ORDER) {
    const rows = snapshot.tables[table] ?? [];
    const copies = new Map(); for (const r of rows) copies.set(r.id, (copies.get(r.id) ?? 0) + 1);
    const out = [];
    for (const r of rows) {
      if (copies.get(r.id) > 1) { if (!st.entries.some((e) => e.table === table && e.sourceId === r.id && e.category === "DUPLICATE_SOURCE_ID")) st.entries.push({ table, sourceId: r.id, category: "DUPLICATE_SOURCE_ID", severity: "blocking", reason: `${copies.get(r.id)} records share this source id; none can be mapped`, field: null }); continue; }
      if (r.taint) { for (const t of r.taint) st.entries.push({ table, sourceId: r.id, category: t.category, severity: "blocking", reason: t.reason, field: null }); continue; }
      const { rec, issues } = NORMALIZERS[table](r);
      for (const i of issues) if (i.severity === "info") st.info[i.category] = (st.info[i.category] ?? 0) + 1; else st.entries.push({ table: i.table, sourceId: i.sourceId, category: i.category, severity: i.severity, reason: i.reason, field: i.field });
      if (rec) out.push(rec);
    }
    st.setRecs(table, out);
    // everything that did not produce a record is blocked (so "exists" reflects the source)
    for (const r of rows) if (!st.exists(table, r.id)) st.status.set(st.key(table, r.id), "blocked");
    lists[table] = out;
  }
  return st;
}

const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s) => (s ?? "").replace(/\D/g, "");

function duplicates(st, table, keyFn, category, reasonFn) {
  const groups = new Map();
  for (const r of st.validList(table)) { const k = keyFn(r); if (k) (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
  for (const [k, g] of [...groups].sort()) if (g.length > 1) for (const r of g) st.block(table, r.sourceId, category, reasonFn(k, g.length), null);
}

/** Stage 4: cross-record validation and quarantine. Mutates and returns the state; also derives cartons and joined invoices. */
export function validateAll(st) {
  // ---------------- identity uniqueness inside the snapshot ----------------
  duplicates(st, "Customers", (r) => norm(r.row.shipping_mark), "CONFLICTING_IDENTITY", (k, n) => `${n} customers claim the shipping mark "${k}"`);
  duplicates(st, "Customers", (r) => (r.row.email ? norm(r.row.email) : ""), "DUPLICATE_CUSTOMER", (k, n) => `${n} customers share the e-mail address ${k}`);
  duplicates(st, "Customers", (r) => (digits(r.row.phone).length >= 7 ? `${digits(r.row.phone)}|${norm(r.row.name)}` : ""), "DUPLICATE_CUSTOMER", (k, n) => `${n} customers share the same name and phone number`);
  {
    const byPhone = new Map();
    for (const r of st.validList("Customers")) { const d = digits(r.row.phone); if (d.length >= 7) (byPhone.get(d) ?? byPhone.set(d, []).get(d)).push(r); }
    for (const g of byPhone.values()) if (g.length > 1) for (const r of g) st.review("Customers", r.sourceId, "DUPLICATE_PHONE", `${g.length} customers share a phone number (different names): reported, not merged`, "Phone");
  }
  duplicates(st, "Containers", (r) => r.row.container_ref, "DUPLICATE_CONTAINER", (k, n) => `${n} containers share the reference ${k}`);
  duplicates(st, "Suppliers", (r) => r.row.supplier_ref, "CONFLICTING_IDENTITY", (k, n) => `${n} suppliers share the reference ${k}`);
  duplicates(st, "PackageRates", (r) => r.row.tier, "CONFLICTING_IDENTITY", (k, n) => `${n} package-rate rows for tier ${k}`);
  duplicates(st, "SpecialRates", (r) => norm(r.row.name), "CONFLICTING_IDENTITY", (k, n) => `${n} special rates are named "${k}"`);
  duplicates(st, "Items", (r) => r.row.item_ref, "CONFLICTING_IDENTITY", (k, n) => `${n} items share the reference ${k}`);
  duplicates(st, "Orders", (r) => r.row.invoice_ref, "CONFLICTING_IDENTITY", (k, n) => `${n} orders share the reference ${k}`);
  duplicates(st, "Orders", (r) => r.row.keepup_sale_id, "CONFLICTING_IDENTITY", (k, n) => `${n} orders share the Keepup sale id ${k}`);
  { const s = st.validList("Settings"); if (s.length > 1) for (const r of s) st.block("Settings", r.sourceId, "CONFLICTING_IDENTITY", `${s.length} Settings records: the current rate is ambiguous`); }
  duplicates(st, "VerifiedInvoices", (r) => r.rels.order, "CONFLICTING_IDENTITY", (k, n) => `${n} verified financial snapshots for order ${k}`);
  duplicates(st, "VerifiedPayments", (r) => r.key, "DUPLICATE_PAYMENT", (k, n) => `${n} verified payments share the payment key ${k}`);
  duplicates(st, "VerifiedPayments", (r) => (r.row.status === "completed" ? r.row.keepup_reference : ""), "DUPLICATE_PAYMENT", (k, n) => `${n} completed payments share the Keepup reference ${k}`);
  duplicates(st, "VerifiedInvoiceLines", (r) => r.key, "CONFLICTING_IDENTITY", (k, n) => `${n} lines share the line key ${k}`);
  duplicates(st, "VerifiedInvoiceLines", (r) => `${r.rels.order}|${r.row.line_no}`, "CONFLICTING_IDENTITY", (k, n) => `${n} lines share the line number ${k.split("|")[1]} on one invoice`);

  // ---------------- config / customers ----------------
  for (const c of st.validList("Customers")) {
    if (c.rels.warehouse && !st.isValid("Warehouses", c.rels.warehouse)) st.block("Customers", c.sourceId, "MISSING_WAREHOUSE", `preferred warehouse ${c.rels.warehouse} is not an importable warehouse`, "PreferredWarehouse");
  }

  // ---------------- users: identity is deferred BY DESIGN ----------------
  {
    const users = [...(st.recs.Users?.values() ?? [])].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
    const emailCount = new Map(), uidCount = new Map();
    for (const u of users) { emailCount.set(u.row.email, (emailCount.get(u.row.email) ?? 0) + 1); if (u.row.uid) uidCount.set(u.row.uid, (uidCount.get(u.row.uid) ?? 0) + 1); }
    for (const u of users) {
      st.defer("Users", u.sourceId, "IDENTITY_NOT_IMPORTED", "Historical logins are not imported: no Firebase identity is created or linked and no role is assigned; the person re-activates through the registration flow", null);
      if (emailCount.get(u.row.email) > 1) st.review("Users", u.sourceId, "CONFLICTING_IDENTITY", "several Airtable users share this e-mail address", "Email");
      if (u.row.uid && uidCount.get(u.row.uid) > 1) st.review("Users", u.sourceId, "CONFLICTING_IDENTITY", "several Airtable users share one Firebase UID", "FirebaseUID");
      if (u.row.role === "customer" && (!u.rels.customer || !st.isValid("Customers", u.rels.customer))) st.review("Users", u.sourceId, "MISSING_CUSTOMER_REFERENCE", "customer login without an importable customer record", "CustomerRecord");
      if (u.row.role === "super_admin") st.entries.push({ table: "Users", sourceId: u.sourceId, category: "PRIVILEGED_ROLE_NOT_IMPORTED", severity: "deferred", field: "Role", reason: "a super_admin login is never imported; the administrator is bootstrapped explicitly (docs/DECISIONS.md D23)" });
      if (!u.row.has_uid) st.entries.push({ table: "Users", sourceId: u.sourceId, category: "MISSING_REQUIRED_FIELD", severity: "deferred", field: "FirebaseUID", reason: "no Firebase UID in the source" });
    }
    for (const r of st.validList("PendingRegistrations")) st.defer("PendingRegistrations", r.sourceId, "DEFERRED_TABLE", "Pending registrations are not migrated: the new registration flow starts clean (docs/DECISIONS.md D9)", null);
  }

  // ---------------- financial source tables: orphans and per-record structure ----------------
  for (const v of st.validList("VerifiedInvoices")) if (!st.exists("Orders", v.rels.order)) st.block("VerifiedInvoices", v.sourceId, "ORPHAN_FINANCIAL_RECORD", `no Airtable order ${v.rels.order}`);
  for (const l of st.validList("VerifiedInvoiceLines")) if (!st.exists("Orders", l.rels.order)) st.block("VerifiedInvoiceLines", l.sourceId, "ORPHAN_FINANCIAL_RECORD", `no Airtable order ${l.rels.order}`);
  for (const p of st.validList("VerifiedPayments")) if (!st.exists("Orders", p.rels.order)) st.block("VerifiedPayments", p.sourceId, "ORPHAN_PAYMENT", `no Airtable order ${p.rels.order}`);

  const verifiedByOrder = new Map(st.validList("VerifiedInvoices").map((v) => [v.rels.order, v]));
  const linesByOrder = group(st.validList("VerifiedInvoiceLines"), (l) => l.rels.order);
  const paymentsByOrder = group(st.validList("VerifiedPayments"), (p) => p.rels.order);
  const eventsByOrder = group(st.validList("StatusHistory").filter((e) => e.row.entity_type === "invoice"), (e) => e.rels.entity);

  // ---------------- cascade to a fixed point: customers/containers -> orders <-> items -> cartons -> lines/payments -> events ----------------
  let guard = 0;
  do {
    st.changed = false;
    if (++guard > 50) throw new Error("validation did not converge");

    // orders
    for (const o of st.validList("Orders")) {
      const id = o.sourceId; const v = verifiedByOrder.get(id);
      if (!st.isValid("Customers", o.rels.customer)) { st.block("Orders", id, st.exists("Customers", o.rels.customer) ? "CUSTOMER_QUARANTINED" : "MISSING_CUSTOMER_REFERENCE", `customer ${o.rels.customer} is not importable`, "Customer"); continue; }
      if (!v || !st.isValid("VerifiedInvoices", v.sourceId)) { st.block("Orders", id, "MISSING_VERIFIED_FINANCIALS", "no verified financial snapshot (subtotal, discount, frozen FX, GHS total) for this order: the Airtable amounts alone do not prove their currency or the FX rate, so nothing is guessed (docs/DECISIONS.md D12/D15)"); continue; }
      const own = new Set(o.rels.items);
      const linked = st.validList("Items").filter((i) => i.rels.order === id).map((i) => i.sourceId);
      for (const itemId of own) {
        const it = st.rec("Items", itemId);
        if (!it || !st.exists("Items", itemId)) { st.block("Orders", id, "MISSING_ITEM", `the order lists item ${itemId} which does not exist`, "Items"); break; }
        if (!st.isValid("Items", itemId)) { st.block("Orders", id, "ITEM_QUARANTINED", `the order lists item ${itemId} which is quarantined`, "Items"); break; }
        if (it.rels.order !== id) { st.block("Orders", id, "CONFLICTING_RELATIONSHIP", `item ${itemId} is listed on the order but linked to ${it.rels.order ?? "no order"}`, "Items"); break; }
        if (it.rels.customer !== o.rels.customer) { st.block("Orders", id, "CONFLICTING_IDENTITY", `item ${itemId} belongs to another customer than the order`, "Items"); break; }
      }
      if (!st.isValid("Orders", id)) continue;
      for (const itemId of linked) if (!own.has(itemId)) { st.block("Orders", id, "CONFLICTING_RELATIONSHIP", `item ${itemId} points at this order but the order does not list it`, "Items"); break; }
      if (!st.isValid("Orders", id)) continue;
      const lines = linesByOrder.get(id) ?? [];
      if (lines.some((l) => !st.isValid("VerifiedInvoiceLines", l.sourceId))) { st.block("Orders", id, "INVALID_LINE", "a verified line of this order is quarantined"); continue; }
      let sum = 0n; for (const l of lines) sum += parseDecimal(l.row.line_total_usd, { scale: 2 }).units;
      if (lines.length && sum !== parseDecimal(v.row.subtotal_usd, { scale: 2 }).units) { st.block("Orders", id, "INVOICE_LINES_MISMATCH", `verified lines total USD ${unitsToText(sum, 2)} but the subtotal is USD ${v.row.subtotal_usd}`); continue; }
      for (const l of lines) {
        if (l.rels.item && !own.has(l.rels.item)) { st.block("Orders", id, "CONFLICTING_RELATIONSHIP", `line ${l.key} references item ${l.rels.item} which is not on the order`, "Items"); break; }
        if (l.rels.carton && !st.validList("Items").some((i) => i.carton?.number === l.rels.carton && i.rels.order === id)) { st.block("Orders", id, "MISSING_CARTON", `line ${l.key} references carton ${l.rels.carton} which is not on the order`, "CartonNumber"); break; }
      }
      if (!st.isValid("Orders", id)) continue;
      const cancelled = o.sourceStatus === "Cancelled";
      const when = v.row.cancelled_at ?? ([...(eventsByOrder.get(id) ?? [])].filter((e) => e.row.new_status === "Cancelled").map((e) => e.row.occurred_at).sort().pop() ?? null);
      if (cancelled && when) st.cancelInfo.set(id, { at: when, reason: v.row.cancel_reason ?? LEGACY_CANCEL_REASON });
      if (cancelled && !when) { st.block("Orders", id, "MISSING_CANCELLATION_DATE", "the order is cancelled but neither the verified snapshot nor the status history says when"); continue; }
      if (!cancelled && v.row.cancelled_at) { st.block("Orders", id, "CONFLICTING_RELATIONSHIP", "the verified snapshot says cancelled but the Airtable order is not"); continue; }
      const fin = analyzeInvoice({ totalGhs: v.row.total_ghs, cancelled, payments: (paymentsByOrder.get(id) ?? []).filter((p) => st.isValid("VerifiedPayments", p.sourceId)), sourceStatus: o.sourceStatus, claim: o.claim });
      for (const b of fin.blocking) { st.block("Orders", id, b.category, b.reason); break; }
    }
    // items
    for (const i of st.validList("Items")) {
      const id = i.sourceId;
      if (!st.exists("Customers", i.rels.customer)) { st.block("Items", id, "ORPHAN_ITEM", `customer ${i.rels.customer} does not exist in the snapshot`, "Customer"); continue; }
      if (!st.isValid("Customers", i.rels.customer)) { st.block("Items", id, "CUSTOMER_QUARANTINED", `customer ${i.rels.customer} is quarantined`, "Customer"); continue; }
      if (i.rels.container && !st.exists("Containers", i.rels.container)) { st.block("Items", id, "MISSING_CONTAINER", `container ${i.rels.container} does not exist in the snapshot`, "Container"); continue; }
      if (i.rels.container && !st.isValid("Containers", i.rels.container)) { st.block("Items", id, "CONTAINER_QUARANTINED", `container ${i.rels.container} is quarantined`, "Container"); continue; }
      if (i.rels.order && !st.exists("Orders", i.rels.order)) { st.block("Items", id, "MISSING_ORDER", `order ${i.rels.order} does not exist in the snapshot`, "Order"); continue; }
      if (i.rels.order && !st.isValid("Orders", i.rels.order)) { st.block("Items", id, "INVOICE_QUARANTINED", `order ${i.rels.order} is quarantined; importing the item uninvoiced could double-bill it`, "Order"); continue; }
    }
    // cartons are derived from the (still valid) items
    const cartons = deriveCartons(st);
    for (const c of cartons.invalid) {
      st.block("Cartons", c.sourceId, c.category, c.reason, c.field);
      for (const m of c.members) st.block("Items", m, "INVALID_CARTON", `carton ${c.number}: ${c.reason}`, "CartonNumber");
    }
    st.cartons = cartons.valid;
    // lines / payments / events follow their invoice, items and entities
    for (const l of st.validList("VerifiedInvoiceLines")) if (st.exists("Orders", l.rels.order) && !st.isValid("Orders", l.rels.order)) st.block("VerifiedInvoiceLines", l.sourceId, "INVOICE_QUARANTINED", `order ${l.rels.order} is quarantined`);
    for (const p of st.validList("VerifiedPayments")) if (st.exists("Orders", p.rels.order) && !st.isValid("Orders", p.rels.order)) st.block("VerifiedPayments", p.sourceId, "INVOICE_QUARANTINED", `order ${p.rels.order} is quarantined`);
    for (const v of st.validList("VerifiedInvoices")) if (st.exists("Orders", v.rels.order) && !st.isValid("Orders", v.rels.order)) st.block("VerifiedInvoices", v.sourceId, "INVOICE_QUARANTINED", `order ${v.rels.order} is quarantined`);
  } while (st.changed);

  // ---------------- history ----------------
  const tableOf = { item: "Items", container: "Containers", invoice: "Orders" };
  for (const e of st.validList("StatusHistory")) {
    const t = tableOf[e.row.entity_type];
    if (!st.exists(t, e.rels.entity)) st.block("StatusHistory", e.sourceId, "ORPHAN_STATUS_EVENT", `${e.row.entity_type} ${e.rels.entity} does not exist in the snapshot`, "RecordID");
    else if (!st.isValid(t, e.rels.entity)) st.block("StatusHistory", e.sourceId, "PARENT_QUARANTINED", `${e.row.entity_type} ${e.rels.entity} is quarantined`, "RecordID");
  }
  st.photos = collectPhotos(st);
  // deterministic, documented consequences of a historical cancellation (not ambiguities): counted, not flagged
  st.info.ITEM_RELEASED_FROM_CANCELLED_INVOICE = st.validList("Items").filter((i) => i.rels.order && st.rec("Orders", i.rels.order)?.sourceStatus === "Cancelled").length;
  if (!st.info.ITEM_RELEASED_FROM_CANCELLED_INVOICE) delete st.info.ITEM_RELEASED_FROM_CANCELLED_INVOICE;
  for (const o of st.validList("Orders")) if (!(linesByOrder.get(o.sourceId) ?? []).length) st.review("Orders", o.sourceId, "NO_LINE_DETAIL", "the verified source has no invoice lines for this order (allowed for legacy invoices)");
  return st;
}

/** Item photos are attachments inside the Items table; each one is validated on its own (a bad photo never blocks its item). */
function collectPhotos(st) {
  const out = []; const seen = new Map();
  for (const it of st.validList("Items")) {
    (it.photos ?? []).forEach((p, idx) => {
      const sourceId = `${it.sourceId}#photo:${idx}`;
      const bad = (reason) => st.entries.push({ table: "ItemPhotos", sourceId, category: "INVALID_PHOTO", severity: "blocking", reason, field: "Photos" });
      if (p === null || typeof p !== "object" || Array.isArray(p)) return bad("photo entry is not an attachment object");
      const id = typeof p.id === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(p.id) ? p.id : null; const url = typeof p.url === "string" ? p.url : "";
      if (!id) return bad("attachment has no usable id");
      if (!/^https:\/\/[^\s]{4,990}$/.test(url)) return bad("attachment url is not an https url");
      const dim = (v) => (v === undefined ? null : Number.isInteger(v) && v > 0 && v < 100000 ? v : false);
      const w = dim(p.width), h = dim(p.height);
      if (w === false || h === false) return bad("attachment dimensions are not positive whole numbers");
      let host = ""; try { host = new URL(url).hostname; } catch { return bad("attachment url is not a valid url"); }
      seen.set(id, (seen.get(id) ?? 0) + 1);
      out.push({ sourceId, itemId: it.sourceId, idx, attachmentId: id, url, width: w, height: h, provider: host === "res.cloudinary.com" ? "cloudinary" : /airtableusercontent\.com$/.test(host) ? "airtable" : "other" });
    });
  }
  const dup = out.filter((p) => seen.get(p.attachmentId) > 1);
  for (const p of dup) st.entries.push({ table: "ItemPhotos", sourceId: p.sourceId, category: "CONFLICTING_IDENTITY", severity: "blocking", reason: "the same attachment id appears more than once", field: "Photos" });
  return out.filter((p) => seen.get(p.attachmentId) === 1).sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
}

function group(list, keyFn) { const m = new Map(); for (const x of list) { const k = keyFn(x); (m.get(k) ?? m.set(k, []).get(k)).push(x); } return m; }

/** Cartons exist only as a text label on items in Airtable; the group of items sharing a CartonNumber IS the carton. */
export function deriveCartons(st) {
  const groups = group(st.validList("Items").filter((i) => i.carton), (i) => i.carton.number);
  const valid = []; const invalid = [];
  for (const [number, members] of [...groups].sort()) {
    const sourceId = `carton:${number}`; const ids = members.map((m) => m.sourceId);
    const fail = (category, reason, field = "CartonNumber") => invalid.push({ sourceId, number, members: ids, category, reason, field });
    const customers = new Set(members.map((m) => m.rels.customer));
    if (customers.size > 1) { fail("CONFLICTING_IDENTITY", "items of different customers share one carton number"); continue; }
    const containers = new Set(members.map((m) => m.rels.container ?? ""));
    if (containers.size > 1) { fail("INVALID_CARTON", "members are in different containers", "Container"); continue; }
    const orders = new Set(members.map((m) => m.rels.order ?? ""));
    if (orders.size > 1) { fail("INVALID_CARTON", "members are on different invoices (or only some are invoiced)", "Order"); continue; }
    const f = new Set(members.map((m) => m.row.freight_type ?? "")); if (f.size > 1 || f.has("")) { fail("INVALID_CARTON", "members have no common freight type", "FreightType"); continue; }
    const units = new Set(members.map((m) => m.row.dimension_unit)); if (units.size > 1) { fail("INVALID_CARTON", "members disagree on the dimension unit", "DimensionUnit"); continue; }
    const dim = (k) => new Set(members.map((m) => m.carton[k] ?? ""));
    if (["length", "width", "height", "weight"].some((k) => dim(k).size > 1)) { fail("INVALID_CARTON", "members disagree on the carton dimensions or weight", "CartonLength"); continue; }
    const c = members[0].carton; const freight = [...f][0];
    const pos = (t) => t !== null && t !== undefined && parseDecimal(t, { scale: 3 }).ok && parseDecimal(t, { scale: 3 }).units > 0n;
    if (freight === "sea" && !(pos(c.length) && pos(c.width) && pos(c.height))) { fail("INVALID_CARTON", "a sea carton needs positive length, width and height", "CartonLength"); continue; }
    if (freight === "air" && !pos(c.weight)) { fail("INVALID_CARTON", "an air carton needs a positive weight", "CartonWeight"); continue; }
    const shares = members.map((m) => (m.carton.share ? parseDecimal(m.carton.share, { scale: 2 }).units : 0n));
    const price = shares.every((s) => s > 0n) ? unitsToText(shares.reduce((a, b) => a + b, 0n), 2) : null;
    const customer = st.rec("Customers", members[0].rels.customer);
    const order = members[0].rels.order ?? null;
    const orderRec = order ? st.rec("Orders", order) : null;
    const released = orderRec?.sourceStatus === "Cancelled";
    valid.push({ table: "Cartons", sourceId, number, memberIds: ids, rels: { customer: members[0].rels.customer, container: members[0].rels.container ?? null, order: released ? null : order },
      releasedFromOrder: released ? order : null,
      row: { carton_ref: number, freight_type: freight, length: c.length, width: c.width, height: c.height, weight_kg: c.weight, dimension_unit: [...units][0],
        package_tier: customer?.row.package_tier ?? "basic", rate_usd: null, price_usd: price, pricing_basis: "tier", status: order && !released ? "invoiced" : "open",
        created_by: "legacy-import",
        legacy_data: { source_table: "Items", source_id: sourceId, derived_from_items: ids, price_note: price ? "sum of the members' carton shares (PkgEstShipping)" : "no complete carton price in the source; left unpriced", tier_note: "tier taken from the customer's package at import time; the historical tier at pricing time was not recorded" } },
      fp: fingerprint(members.map((m) => m.fp).sort()) });
  }
  return { valid, invalid };
}

export { LEGACY_CANCEL_REASON };

/** Deterministic quarantine list for the report/persistence. */
export function collectEntries(st) {
  return [...st.entries].sort((a, b) => a.table.localeCompare(b.table) || a.sourceId.localeCompare(b.sourceId) || a.category.localeCompare(b.category) || String(a.field).localeCompare(String(b.field)));
}
