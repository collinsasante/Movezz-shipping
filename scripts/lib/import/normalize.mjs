// Stage 3 - NORMALIZATION (per record, no cross-record knowledge).
//
// Every normalizer reads source fields through an allow-list (Reader), never trusts types, never rounds money, never defaults a
// value the live system did not default, and reports problems as issues:
//   blocking  -> the record cannot be mapped safely; it is quarantined (no normalized record is produced)
//   review    -> the record is mapped, but a human should look (unexpected field, trimmed text, non-standard format)
// Unexpected source fields are preserved (bounded) in legacy_data so nothing the source held is silently lost.
import { isIP } from "node:net";
import { fingerprint, get, hasOwn, mulRound, parseDecimal, parseTimestamp, unitsToText } from "./util.mjs";

export const KNOWN_FIELDS = {
  Warehouses: ["Name", "Address", "Country", "Phone", "IsActive", "CreatedAt"],
  Suppliers: ["SupplierID", "Name", "Category", "Platform", "PlatformLink", "Contact", "ContactMethod", "Rating", "Notes", "CreatedAt", "CreatedBy"],
  PackageRates: ["Tier", "Sea", "Air"],
  SpecialRates: ["Name", "Sea", "Air"],
  Settings: ["UsdToGhs", "ShippingRatePerCbm"],
  Customers: ["Name", "Phone", "Email", "ShippingAddress", "ShippingMark", "FirebaseUID", "Status", "ShippingType", "CustomerPackage", "ExchangeRate", "Notes", "PreferredWarehouse", "CreatedAt"],
  Users: ["FirebaseUID", "Email", "Role", "CustomerRecord", "CustomerName", "CreatedAt", "LastLogin"],
  Containers: ["ContainerID", "Name", "Description", "Status", "Items", "DepartureDate", "ArrivalDate", "TrackingNumber", "Notes", "CreatedAt", "CreatedBy"],
  Items: ["ItemRef", "Photos", "Weight", "FreightType", "Length", "Width", "Height", "DimensionUnit", "Description", "DateReceived", "TrackingNumber", "Customer", "CustomerName",
    "CustomerShippingMark", "Status", "Container", "ContainerName", "Order", "OrderRef", "IsMissing", "Quantity", "EstPrice", "EstShippingPrice", "PkgEstShipping", "PkgShippingRate",
    "PreCartonPkgEstShipping", "SpecialShippingRate", "IsSpecialItem", "specialRateName", "CartonNumber", "CartonLength", "CartonWidth", "CartonHeight", "CartonWeight", "Notes", "CreatedAt", "CreatedBy"],
  Orders: ["OrderRef", "Customer", "CustomerName", "Items", "InvoiceAmount", "Discount", "Status", "InvoiceDate", "Notes", "CreatedAt", "KeepupSaleId", "KeepupLink", "AmountPaid", "BalanceDue"],
  StatusHistory: ["RecordType", "RecordID", "RecordRef", "PreviousStatus", "NewStatus", "ChangedBy", "ChangedByRole", "ChangedAt", "Notes"],
  ActivityLogs: ["Action", "UserEmail", "UserRole", "Details", "EntityType", "EntityID", "Timestamp", "IPAddress"],
  PendingRegistrations: ["Name", "Email", "Phone", "Phone2", "ExistingMark", "Location", "Notes", "Status", "CreatedAt"],
  VerifiedInvoices: ["OrderRecordID", "SubtotalUsd", "DiscountUsd", "DiscountReason", "FxRate", "TotalGhs", "FxEstimated", "Note", "CancelledAt", "CancelReason", "Source"],
  VerifiedInvoiceLines: ["LineKey", "OrderRecordID", "LineNo", "ItemRecordID", "CartonNumber", "Description", "Quantity", "UnitPriceUsd", "BillingBasis", "PackageTier", "RateUsd", "SpecialRateName"],
  VerifiedPayments: ["PaymentKey", "OrderRecordID", "AmountGhs", "Currency", "Method", "PaidAt", "Status", "VoidedAt", "VoidReason", "KeepupReference", "ExternalReference", "UsdEquivalent"],
};

export const ITEM_STATUSES = ["Arrived at Transit Warehouse", "Shipped to Ghana", "Arrived in Ghana", "Awaiting Customs Clearance & Duty Process", "Sorting", "Ready for Pickup", "Completed"];
export const CONTAINER_STATUSES = ["Loading", "Shipped to Ghana", "Arrived in Ghana"];
export const ORDER_STATUSES = ["Pending", "Partial", "Paid", "Cancelled"];
const TIERS = ["basic", "business", "enterprise", "special"];
const LEGACY_TIER = { standard: "basic", discounted: "business", premium: "enterprise" };
const RECORD_TYPES = { Item: "item", Container: "container", Order: "invoice" };
const ROLES = ["super_admin", "warehouse_staff", "customer"];

// a source field whose NAME suggests a secret or an identity link is recorded by name only; its value is never copied into the database
const SENSITIVE_NAME = /uid|token|secret|passw|pwd|api[_-]?key|credential|auth|session|cookie|private/i;

class Reader {
  constructor(table, rec) { this.table = table; this.rec = rec; this.f = rec.fields; this.issues = []; this.used = new Set(); this.legacy = {}; }
  issue(severity, category, field, reason) { this.issues.push({ table: this.table, sourceId: this.rec.id, severity, category, field: field ?? null, reason }); }
  block(category, field, reason) { this.issue("blocking", category, field, reason); }
  review(category, field, reason) { this.issue("review", category, field, reason); }
  get blocked() { return this.issues.some((i) => i.severity === "blocking"); }
  raw(name) { this.used.add(name); const v = get(this.f, name); return v === null ? undefined : v; }
  text(name, { required = false, max = 500, category = "INVALID_VALUE" } = {}) {
    const v = this.raw(name);
    if (v === undefined || (typeof v === "string" && v.trim() === "")) { if (required) this.block(category === "INVALID_VALUE" ? "MISSING_REQUIRED_FIELD" : category, name, `${name} is required`); return undefined; }
    if (typeof v !== "string") { this.block(category, name, `${name} must be text`); return undefined; }
    const t = v.trim();
    if (t.length > max) { this.block(category, name, `${name} is longer than ${max} characters`); return undefined; }
    if (t !== v) this.review("TRIMMED_WHITESPACE", name, `${name} had leading/trailing whitespace (trimmed)`);
    return t;
  }
  bool(name, dflt) {
    const v = this.raw(name);
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") { this.block("INVALID_VALUE", name, `${name} must be true/false`); return dflt; }
    return v;
  }
  decimal(name, { scale = 2, required = false, positive = false, category = "INVALID_MONEY", max } = {}) {
    const v = this.raw(name);
    if (v === undefined || v === "") { if (required) this.block(category, name, `${name} is required`); return undefined; }
    const p = parseDecimal(v, { scale, ...(max ? { max } : {}) });
    if (!p.ok) { this.block(category, name, `${name}: ${p.reason}`); return undefined; }
    if (positive && p.units <= 0n) { this.block(category, name, `${name} must be greater than zero`); return undefined; }
    return p;
  }
  date(name, { required = false, category = "INVALID_DATE" } = {}) {
    const v = this.raw(name);
    if (v === undefined || v === "") { if (required) this.block(category, name, `${name} is required`); return undefined; }
    const p = parseTimestamp(v);
    if (!p.ok) { this.block(category, name, `${name}: ${p.reason}`); return undefined; }
    return p;
  }
  oneOf(name, allowed, { required = false, category = "UNKNOWN_STATUS", map, dflt } = {}) {
    const v = this.raw(name);
    if (v === undefined || v === "") {
      if (dflt !== undefined) { this.issue("info", "DEFAULTED_VALUE", name, `${name} was empty; the live application defaults it to "${dflt}"`); return dflt; }
      if (required) this.block("MISSING_REQUIRED_FIELD", name, `${name} is required`);
      return undefined;
    }
    if (typeof v !== "string") { this.block(category, name, `${name} must be text`); return undefined; }
    const t = v.trim(); const key = map && hasOwn(map, t.toLowerCase()) ? map[t.toLowerCase()] : t;
    const hit = allowed.find((a) => a.toLowerCase() === String(key).toLowerCase());
    if (!hit) { this.block(category, name, `${name} "${t.slice(0, 60)}" is not a recognised value`); return undefined; }
    return hit;
  }
  /** A single-record link (Airtable linked-record field): [] / undefined / ["recX"]. More than one is ambiguous. */
  link(name) {
    const v = this.raw(name);
    if (v === undefined || (Array.isArray(v) && v.length === 0) || v === "") return undefined;
    if (!Array.isArray(v) || v.length > 1 || typeof v[0] !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(v[0])) { this.block("INVALID_LINK", name, `${name} must be one linked record id`); return undefined; }
    return v[0];
  }
  links(name) {
    const v = this.raw(name);
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 500 || v.some((x) => typeof x !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(x))) { this.block("INVALID_LINK", name, `${name} must be a list of record ids`); return []; }
    return v;
  }
  /** Marks unexpected fields: preserved (bounded) in legacy_data, never interpreted. */
  finish() {
    const known = KNOWN_FIELDS[this.table] ?? [];
    const extra = Object.keys(this.f).filter((k) => !known.includes(k)).sort();
    if (extra.length) {
      this.review("UNEXPECTED_FIELD", extra.slice(0, 5).join(","), `${extra.length} field(s) not part of the documented schema were preserved in legacy_data`);
      const kept = {};
      for (const k of extra.slice(0, 20)) {
        const v = this.f[k];
        kept[k] = SENSITIVE_NAME.test(k) ? "[not preserved: the field name looks like a credential or identity]" : typeof v === "string" ? v.slice(0, 500) : typeof v === "number" || typeof v === "boolean" || v === null ? v : "[non-scalar value not preserved]";
      }
      this.legacy.unexpected_fields = kept;
    }
    return this;
  }
}

const money = (p) => (p ? p.text : null);
const done = (r, row, extra = {}) => {
  r.finish();
  if (r.blocked) return { rec: null, issues: r.issues };
  const legacy = { source_table: r.table, source_id: r.rec.id, ...r.legacy };
  return { rec: { table: r.table, sourceId: r.rec.id, row: { ...row, legacy_data: legacy }, ...extra, fp: fingerprint({ t: r.table, row, extra }) }, issues: r.issues };
};

// ---------------------------------------------------------------------------------------------------------------------------
export function normalizeWarehouse(rec) {
  const r = new Reader("Warehouses", rec);
  const row = { name: r.text("Name", { required: true, max: 200 }), address: r.text("Address", { max: 500 }) ?? "", country: r.text("Country", { max: 100 }) ?? null,
    phone: r.text("Phone", { max: 40 }) ?? null, is_active: r.bool("IsActive", true) };
  r.raw("CreatedAt");
  return done(r, row);
}

export function normalizeSupplier(rec) {
  const r = new Reader("Suppliers", rec);
  const rating = r.raw("Rating");
  let ratingValue = null;
  if (rating !== undefined) { if (!Number.isInteger(rating) || rating < 1 || rating > 5) r.block("INVALID_VALUE", "Rating", "Rating must be a whole number 1-5"); else ratingValue = rating; }
  const row = { supplier_ref: r.text("SupplierID", { required: true, max: 60 }), name: r.text("Name", { required: true, max: 200 }), category: r.text("Category", { max: 100 }) ?? null,
    platform: r.text("Platform", { max: 100 }) ?? null, platform_link: r.text("PlatformLink", { max: 500 }) ?? null, contact: r.text("Contact", { max: 200 }) ?? null,
    contact_method: r.text("ContactMethod", { max: 100 }) ?? null, rating: ratingValue, notes: r.text("Notes", { max: 2000 }) ?? null, created_by: r.text("CreatedBy", { max: 200 }) ?? null };
  r.raw("CreatedAt");
  return done(r, row);
}

export function normalizePackageRate(rec) {
  const r = new Reader("PackageRates", rec);
  const tier = r.oneOf("Tier", TIERS, { required: true, category: "UNKNOWN_TIER" });
  const sea = r.decimal("Sea", { scale: 4, required: true, positive: true }); const air = r.decimal("Air", { scale: 4, required: true, positive: true });
  return done(r, { tier, sea_rate: money(sea), air_rate: money(air) });
}

export function normalizeSpecialRate(rec) {
  const r = new Reader("SpecialRates", rec);
  const name = r.text("Name", { required: true, max: 200 });
  const rates = {};
  for (const [k, col] of [["Sea", "sea_rate_usd"], ["Air", "air_rate_usd"]]) {
    const v = r.raw(k);
    if (v === undefined || v === 0 || v === "0") { rates[col] = null; if (v !== undefined) r.review("ZERO_RATE_AS_NULL", k, `${k} rate 0 means "not offered" (stored as no rate)`); continue; }
    const p = parseDecimal(v, { scale: 4 });
    if (!p.ok || p.units <= 0n) { r.block("INVALID_SPECIAL_RATE", k, `${k}: ${p.ok ? "must be greater than zero" : p.reason}`); continue; }
    rates[col] = p.text;
  }
  if (!r.blocked && rates.sea_rate_usd === null && rates.air_rate_usd === null) r.block("INVALID_SPECIAL_RATE", "Sea,Air", "a special rate needs at least one freight rate");
  // D11: customer association and validity are not recorded in Airtable - they are NOT invented; the ambiguity is marked on the row
  return done(r, { name, ...rates, provenance: "legacy_ambiguous",
    provenance_note: "Imported from Airtable: customer association and validity period were not recorded in the source and are not inferred." });
}

export function normalizeSettings(rec) {
  const r = new Reader("Settings", rec);
  const v = r.decimal("UsdToGhs", { scale: 8, required: true, positive: true, category: "INVALID_FX" });
  if (v && (v.units < 10_000_000n || v.units > 100_000_000_000n)) r.block("INVALID_FX", "UsdToGhs", "UsdToGhs must be between 0.1 and 1000");
  r.raw("ShippingRatePerCbm");
  return done(r, { rate: money(v) });
}

export function normalizeCustomer(rec) {
  const r = new Reader("Customers", rec);
  const name = r.text("Name", { required: true, max: 200 });
  const phone = r.text("Phone", { max: 40 }); const email = r.text("Email", { max: 254, category: "INVALID_EMAIL" });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) r.block("INVALID_EMAIL", "Email", "Email is not a valid address");
  const mark = r.text("ShippingMark", { required: true, max: 100, category: "INVALID_SHIPPING_MARK" });
  if (mark && /\s/.test(mark)) r.block("INVALID_SHIPPING_MARK", "ShippingMark", "ShippingMark must not contain spaces");
  else if (mark && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mark)) r.block("INVALID_SHIPPING_MARK", "ShippingMark", "ShippingMark contains unsupported characters");
  else if (mark && !/^(MOVEZZ|PAKKMAXX)-[A-Z0-9-]+$/.test(mark)) r.review("NONSTANDARD_SHIPPING_MARK", "ShippingMark", "historical shipping mark does not follow the MOVEZZ-/PAKKMAXX- pattern; preserved as is (never regenerated)");
  const status = r.oneOf("Status", ["active", "inactive"], { dflt: "active", category: "UNKNOWN_STATUS" });
  const shippingType = r.oneOf("ShippingType", ["air", "sea"], { category: "INVALID_VALUE" });
  const tier = r.oneOf("CustomerPackage", TIERS, { dflt: "basic", map: LEGACY_TIER, category: "UNKNOWN_TIER" });
  const fx = r.raw("ExchangeRate");
  if (fx !== undefined) r.legacy.legacy_exchange_rate = typeof fx === "number" || typeof fx === "string" ? String(fx).slice(0, 30) : "[invalid]";
  const uid = r.raw("FirebaseUID");
  if (uid !== undefined) r.legacy.had_firebase_uid = true;                      // the identifier itself is deliberately NOT carried over
  const warehouse = r.link0("PreferredWarehouse");
  const created = r.date("CreatedAt");
  const row = { name, phone: phone ?? null, email: email ?? null, shipping_mark: mark, shipping_address: r.text("ShippingAddress", { max: 1000 }) ?? null,
    shipping_type: shippingType ?? null, package_tier: tier, notes: r.text("Notes", { max: 2000 }) ?? null, status, created_by: "legacy-import",
    created_at: created?.iso ?? null };
  return done(r, row, { rels: { warehouse } });
}
// PreferredWarehouse is stored as a plain record id string in the live mapper (not an array)
Reader.prototype.link0 = function (name) {
  const v = this.raw(name);
  if (v === undefined || v === "") return undefined;
  const id = Array.isArray(v) && v.length === 1 ? v[0] : v;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(id)) { this.block("INVALID_LINK", name, `${name} must be one record id`); return undefined; }
  return id;
};

export function normalizeUser(rec) {
  // Users are NEVER written to `users` (no Firebase identity is created or linked, no role is assigned). This normalizer only
  // validates the shape so the report can state exactly what was deferred and why.
  const r = new Reader("Users", rec);
  const email = r.text("Email", { required: true, max: 254, category: "INVALID_EMAIL" });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) r.block("INVALID_EMAIL", "Email", "Email is not a valid address");
  const role = r.oneOf("Role", ROLES, { required: true, category: "UNKNOWN_ROLE" });
  const customerRecord = r.link("CustomerRecord");
  const uid = r.raw("FirebaseUID");
  r.raw("CustomerName"); r.raw("CreatedAt"); r.raw("LastLogin");
  r.finish();
  if (r.blocked) return { rec: null, issues: r.issues };
  return { rec: { table: "Users", sourceId: rec.id, row: { email: email.toLowerCase(), role, has_uid: typeof uid === "string" && uid !== "", uid: typeof uid === "string" ? uid : null }, rels: { customer: customerRecord }, fp: fingerprint({ email, role }) }, issues: r.issues };
}

export function normalizeContainer(rec) {
  const r = new Reader("Containers", rec);
  const ref = r.text("ContainerID", { required: true, max: 60 });
  if (ref && !/^PMX-CON-\d{4}-\d{3,}$/.test(ref)) r.review("NONSTANDARD_REFERENCE", "ContainerID", "container reference does not follow PMX-CON-YYYY-NNN; preserved as is");
  const status = r.oneOf("Status", CONTAINER_STATUSES, { dflt: "Loading" });
  const eta = r.date("DepartureDate"); const arrival = r.date("ArrivalDate");
  r.links("Items");
  const row = { container_ref: ref, container_number: r.text("TrackingNumber", { max: 60 }) ?? null, shipping_line: r.text("Name", { max: 200 }) ?? null, description: r.text("Description", { max: 1000 }) ?? null,
    status, eta: eta?.date ?? null, arrival_date: arrival?.date ?? null, notes: r.text("Notes", { max: 2000 }) ?? null, created_by: r.text("CreatedBy", { max: 200 }) ?? null };
  r.date("CreatedAt");
  return done(r, row);
}

export function normalizeItem(rec) {
  const r = new Reader("Items", rec);
  const ref = r.text("ItemRef", { required: true, max: 60 });
  const customer = r.link("Customer"); if (!customer && !r.blocked) r.block("MISSING_CUSTOMER_REFERENCE", "Customer", "the item is not linked to a customer");
  const container = r.link("Container"); const order = r.link("Order");
  const status = r.oneOf("Status", ITEM_STATUSES, { dflt: ITEM_STATUSES[0] });
  const freight = r.oneOf("FreightType", ["air", "sea"], { category: "INVALID_VALUE" });
  const unit = r.oneOf("DimensionUnit", ["cm", "inches"], { dflt: "cm", category: "INVALID_VALUE" });
  const dim = (n, s = 2) => r.decimal(n, { scale: s, category: "INVALID_DIMENSION" });
  const weight = dim("Weight", 3), length = dim("Length"), width = dim("Width"), height = dim("Height");
  const qtyRaw = r.raw("Quantity"); let quantity = 1;
  if (qtyRaw !== undefined) { if (!Number.isInteger(qtyRaw) || qtyRaw < 1 || qtyRaw > 100000) r.block("INVALID_VALUE", "Quantity", "Quantity must be a whole number >= 1"); else quantity = qtyRaw; }
  const received = r.date("DateReceived"); const created = r.date("CreatedAt");
  const estPrice = r.decimal("EstPrice"); const estShip = r.decimal("EstShippingPrice"); const pkgEst = r.decimal("PkgEstShipping"); const pkgRate = r.decimal("PkgShippingRate", { scale: 4 });
  const preCarton = r.decimal("PreCartonPkgEstShipping"); const spRate = r.decimal("SpecialShippingRate", { scale: 4 });
  const special = r.bool("IsSpecialItem", false); const spName = r.text("specialRateName", { max: 200 });
  const cartonNumber = r.text("CartonNumber", { max: 60, category: "INVALID_CARTON" });
  const cl = dim("CartonLength"), cw = dim("CartonWidth"), ch = dim("CartonHeight"), cwt = dim("CartonWeight", 3);
  for (const n of ["CustomerName", "CustomerShippingMark", "ContainerName", "OrderRef"]) r.raw(n);       // lookup/rollup fields: derived, ignored
  const missing = r.bool("IsMissing", false);

  // Pricing snapshots (USD). PkgEstShipping was overwritten with the carton share while an item sat in a carton, so inside a carton the
  // item's own price is taken from the pre-carton snapshot or left unknown - never from the overwritten value.
  const inCarton = !!cartonNumber;
  const tierPrice = inCarton ? preCarton : pkgEst;
  const nz = (p) => (p && p.units > 0n ? p.text : null);
  let billing = "tier"; let spPrice = null;
  if (special) {
    billing = "special";
    if (!spName) r.block("INVALID_SPECIAL_RATE", "specialRateName", "a special item needs the special rate name");
    if (!estShip || estShip.units <= 0n) r.block("INVALID_SPECIAL_RATE", "EstShippingPrice", "a special item needs a positive special price");
    else spPrice = estShip.text;
    if (inCarton) r.block("INVALID_CARTON", "CartonNumber", "special-rate items cannot be in a carton (existing business rule)");
  }
  if (freight === "air" && !weight && !inCarton) r.review("MISSING_WEIGHT", "Weight", "air item without a weight");
  const photos = [];
  const rawPhotos = r.raw("Photos");
  if (rawPhotos !== undefined && !Array.isArray(rawPhotos)) r.block("INVALID_VALUE", "Photos", "Photos must be a list");
  else for (const p of rawPhotos ?? []) photos.push(p);

  const row = { item_ref: ref, description: r.text("Description", { max: 1000 }) ?? "", tracking_number: r.text("TrackingNumber", { max: 100 }) ?? null, status, is_missing: missing,
    freight_type: freight ?? null, weight_kg: money(weight), length: money(length), width: money(width), height: money(height), dimension_unit: unit, quantity,
    received_date: received?.date ?? null, est_price_usd: nz(estPrice), tier_price_usd: nz(tierPrice), tier_rate_usd: nz(pkgRate), billing_basis: billing,
    special_rate_name: special ? spName ?? null : null, special_price_usd: spPrice, special_rate_usd: special ? nz(spRate) : null,
    notes: r.text("Notes", { max: 2000 }) ?? null, created_by: r.text("CreatedBy", { max: 200 }) ?? null };
  if (special && nz(spRate) === null) r.review("MISSING_SPECIAL_RATE_SNAPSHOT", "SpecialShippingRate", "special item without a per-unit special rate snapshot");
  if (!r.blocked && !inCarton && !special && tierPrice === undefined) r.review("UNPRICED_ITEM", "PkgEstShipping", "item has no price snapshot (not invoiceable until priced)");
  return done(r, row, { rels: { customer, container, order },
    carton: inCarton ? { number: cartonNumber, length: money(cl), width: money(cw), height: money(ch), weight: money(cwt), share: money(pkgEst) } : null, photos, createdAt: created?.iso ?? null });
}

export function normalizeOrder(rec) {
  const r = new Reader("Orders", rec);
  const ref = r.text("OrderRef", { required: true, max: 60 });
  const customer = r.link("Customer"); if (!customer && !r.blocked) r.block("MISSING_CUSTOMER_REFERENCE", "Customer", "the order is not linked to a customer");
  const itemIds = r.links("Items");
  const status = r.oneOf("Status", ORDER_STATUSES, { dflt: "Pending" });
  const date = r.date("InvoiceDate", { required: true }); const created = r.date("CreatedAt");
  // InvoiceAmount / Discount / AmountPaid / BalanceDue are read only to be PRESERVED and cross-checked: their currency is ambiguous in
  // Airtable (USD at creation, overwritten with the net GHS amount after Keepup) so they are never the invoice's financial snapshot.
  const claim = {};
  for (const [k, scale] of [["InvoiceAmount", 2], ["Discount", 2], ["AmountPaid", 2], ["BalanceDue", 2]]) {
    const p = r.decimal(k, { scale, category: "INVALID_MONEY" });
    claim[k] = p ? p.text : null;
  }
  const sale = r.text("KeepupSaleId", { max: 100 }); const link = r.text("KeepupLink", { max: 500 });
  r.raw("CustomerName");
  const row = { invoice_ref: ref, invoice_date: date?.date ?? null, keepup_sale_id: sale ?? null, keepup_link: link && /^https:\/\//.test(link) ? link : null, notes: r.text("Notes", { max: 2000 }) ?? null,
    created_at: created?.iso ?? null };
  if (link && !/^https:\/\//.test(link)) r.review("INVALID_LINK", "KeepupLink", "KeepupLink is not https; not imported");
  r.legacy.airtable_claims = claim;
  return done(r, row, { rels: { customer, items: itemIds }, sourceStatus: status, claim });
}

export function normalizeStatusHistory(rec) {
  const r = new Reader("StatusHistory", rec);
  const type = r.oneOf("RecordType", Object.keys(RECORD_TYPES), { required: true, category: "UNKNOWN_RECORD_TYPE" });
  const recordId = r.text("RecordID", { required: true, max: 64 });
  const next = r.text("NewStatus", { required: true, max: 200 }); const prev = r.text("PreviousStatus", { max: 200 });
  const at = r.date("ChangedAt", { required: true });
  const row = { entity_type: type ? RECORD_TYPES[type] : null, new_status: next, old_status: prev ?? null, reason: r.text("Notes", { max: 1000 }) ?? null, occurred_at: at?.iso ?? null,
    changed_by: r.text("ChangedBy", { max: 254 }) ?? null, changed_by_role: r.text("ChangedByRole", { max: 40 }) ?? null, record_ref: r.text("RecordRef", { max: 100 }) ?? null };
  return done(r, row, { rels: { entity: recordId } });
}

export function normalizeActivityLog(rec) {
  const r = new Reader("ActivityLogs", rec);
  const action = r.text("Action", { required: true, max: 100 }); const at = r.date("Timestamp", { required: true });
  const ip = r.text("IPAddress", { max: 45 });
  if (ip && isIP(ip) === 0) r.block("INVALID_VALUE", "IPAddress", "IPAddress is not an IP address");
  const row = { action, created_at: at?.iso ?? null, user_email: r.text("UserEmail", { max: 254 }) ?? null, user_role: r.text("UserRole", { max: 40 }) ?? null, details: r.text("Details", { max: 2000 }) ?? null,
    entity_type: r.text("EntityType", { max: 60 }) ?? null, ip: ip ?? null };
  return done(r, row, { rels: { entity: r.text("EntityID", { max: 100 }) } });
}

export function normalizePendingRegistration(rec) {
  const r = new Reader("PendingRegistrations", rec);
  for (const k of KNOWN_FIELDS.PendingRegistrations) r.raw(k);
  r.finish();
  return { rec: { table: "PendingRegistrations", sourceId: rec.id, row: {}, rels: {}, fp: fingerprint({ id: rec.id }) }, issues: r.issues };
}

// ---- supplemental, VERIFIED financial tables (contract for a future verified extraction) ---------------------------------------
export function normalizeVerifiedInvoice(rec) {
  const r = new Reader("VerifiedInvoices", rec);
  const order = r.text("OrderRecordID", { required: true, max: 64 });
  const subtotal = r.decimal("SubtotalUsd", { required: true }); const discount = r.decimal("DiscountUsd") ?? parseDecimal(0, { scale: 2 });
  const reason = r.text("DiscountReason", { max: 500 });
  const fx = r.decimal("FxRate", { scale: 8, required: true, positive: true, category: "INVALID_FX" });
  const total = r.decimal("TotalGhs", { required: true });
  const estimated = r.bool("FxEstimated", false); const note = r.text("Note", { max: 1000 });
  const cancelledAt = r.date("CancelledAt"); const cancelReason = r.text("CancelReason", { max: 1000 }); r.text("Source", { max: 100 });
  if (fx && (fx.units < 10_000_000n || fx.units > 100_000_000_000n)) r.block("INVALID_FX", "FxRate", "FxRate must be between 0.1 and 1000");
  if (!r.blocked) {
    if (discount.units > subtotal.units) r.block("INVALID_MONEY", "DiscountUsd", "discount exceeds the subtotal");
    else if (discount.units > 0n && !reason) r.block("INVALID_MONEY", "DiscountReason", "a discount needs its recorded reason");
    else if (estimated && !note) r.block("INVALID_FX", "Note", "an estimated FX rate must be explained in Note");
    else if (!estimated) {
      // total = round((subtotal - discount) x fx, 2), half-up, exactly as the database constraint states
      const rounded = mulRound(subtotal.units - discount.units, 2, fx.units, 8, 2);
      if (total.units !== rounded) r.block("INVALID_MONEY", "TotalGhs", `TotalGhs ${total.text} does not equal round((subtotal - discount) x FxRate, 2) = ${unitsToText(rounded, 2)}`);
    }
  }
  const row = { subtotal_usd: money(subtotal), discount_usd: money(discount), discount_reason: reason ?? null, fx_rate: money(fx), total_ghs: money(total), fx_estimated: estimated, note: note ?? null,
    cancelled_at: cancelledAt?.iso ?? null, cancel_reason: cancelReason ?? null };
  return done(r, row, { rels: { order } });
}

export function normalizeVerifiedLine(rec) {
  const r = new Reader("VerifiedInvoiceLines", rec);
  const key = r.text("LineKey", { required: true, max: 100 }); const order = r.text("OrderRecordID", { required: true, max: 64 });
  const no = r.raw("LineNo"); if (!Number.isInteger(no) || no < 1 || no > 10000) r.block("INVALID_VALUE", "LineNo", "LineNo must be a whole number >= 1");
  const item = r.text("ItemRecordID", { max: 64 }); const carton = r.text("CartonNumber", { max: 60 });
  if (item && carton) r.block("INVALID_VALUE", "ItemRecordID", "a line references an item or a carton, not both");
  const qty = r.decimal("Quantity", { scale: 3, positive: true }) ?? parseDecimal(1, { scale: 3 });
  const unit = r.decimal("UnitPriceUsd", { required: true, positive: true });
  const basis = r.oneOf("BillingBasis", ["tier", "special"], { required: true, category: "INVALID_VALUE" });
  const tier = r.oneOf("PackageTier", TIERS, { category: "UNKNOWN_TIER" }); const rate = r.decimal("RateUsd", { scale: 4, positive: true });
  const spName = r.text("SpecialRateName", { max: 200 });
  if (basis === "special" && !spName) r.block("INVALID_SPECIAL_RATE", "SpecialRateName", "a special-basis line needs the special rate name");
  const desc = r.text("Description", { required: true, max: 500 });
  let totalText = null;
  if (!r.blocked) { const t = (qty.units * unit.units + 500n) / 1000n; totalText = unitsToText(t, 2); }
  const row = { line_no: no, description: desc, quantity: money(qty), unit_price_usd: money(unit), line_total_usd: totalText, billing_basis: basis, package_tier: tier ?? null, rate_usd: money(rate), special_rate_name: spName ?? null };
  return done(r, row, { rels: { order, item: item ?? null, carton: carton ?? null }, key });
}

export function normalizeVerifiedPayment(rec) {
  const r = new Reader("VerifiedPayments", rec);
  const key = r.text("PaymentKey", { required: true, max: 100, category: "INVALID_PAYMENT" }); const order = r.text("OrderRecordID", { required: true, max: 64, category: "INVALID_PAYMENT" });
  const amount = r.decimal("AmountGhs", { required: true, positive: true, category: "INVALID_PAYMENT" });
  const currency = r.text("Currency", { max: 3 });
  if (currency !== undefined && currency !== "GHS") r.block("UNEXPECTED_CURRENCY", "Currency", `payments are recorded in GHS; the source says ${currency.slice(0, 3)}`);
  const status = r.oneOf("Status", ["completed", "voided"], { required: true, category: "INVALID_PAYMENT_STATE" });
  const paid = r.date("PaidAt", { required: true, category: "INVALID_DATE" }); const voided = r.date("VoidedAt"); const voidReason = r.text("VoidReason", { max: 1000 });
  const usd = r.decimal("UsdEquivalent", { category: "INVALID_PAYMENT" });
  if (status === "voided" && !r.blocked) {
    if (!voided) r.block("INVALID_PAYMENT_STATE", "VoidedAt", "a voided payment needs VoidedAt");
    if (!voidReason) r.block("INVALID_PAYMENT_STATE", "VoidReason", "a voided payment needs VoidReason");
    if (voided && paid && voided.iso < paid.iso) r.block("INVALID_PAYMENT_STATE", "VoidedAt", "VoidedAt is earlier than PaidAt");
  }
  if (status === "completed" && (voided || voidReason)) r.block("INVALID_PAYMENT_STATE", "VoidedAt", "a completed payment cannot carry void details");
  const row = { amount_ghs: money(amount), method: r.text("Method", { max: 60 }) ?? "other", paid_at: paid?.iso ?? null, status, voided_at: voided?.iso ?? null, void_reason: voidReason ?? null,
    keepup_reference: r.text("KeepupReference", { max: 100 }) ?? null, external_reference: r.text("ExternalReference", { max: 100 }) ?? null, usd_equivalent: money(usd) };
  return done(r, row, { rels: { order }, key });
}

export const NORMALIZERS = {
  Warehouses: normalizeWarehouse, Suppliers: normalizeSupplier, PackageRates: normalizePackageRate, SpecialRates: normalizeSpecialRate, Settings: normalizeSettings,
  Customers: normalizeCustomer, Users: normalizeUser, Containers: normalizeContainer, Items: normalizeItem, Orders: normalizeOrder, StatusHistory: normalizeStatusHistory,
  ActivityLogs: normalizeActivityLog, PendingRegistrations: normalizePendingRegistration, VerifiedInvoices: normalizeVerifiedInvoice, VerifiedInvoiceLines: normalizeVerifiedLine,
  VerifiedPayments: normalizeVerifiedPayment,
};
