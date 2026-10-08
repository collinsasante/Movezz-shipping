// REALISTIC (source-code-derived) Airtable snapshot generator. NOT production data and NOT a production validation: nothing was read from
// Airtable. It reproduces the behaviours the repository's own code and tests show Airtable producing (see docs/MIGRATION-IMPORT.md §14):
//   * empty / false / 0-length values are OMITTED from records (a checkbox that is off, a cleared text field, an unlinked record field)
//   * linked-record and lookup fields are ARRAYS (Customer, Container, Order, Items, CustomerRecord, CustomerName, CustomerShippingMark, OrderRef)
//   * deleting a record (customers.delete, orders.delete) leaves NO order status "Cancelled": an order is deleted instead, items are unlinked
//   * attachments carry id/url/filename/size/type/width/height/thumbnails
//   * app-computed numbers carry float noise; staff-entered numbers can have more decimals than the new schema stores
//   * plain-text id fields (StatusHistory.RecordID, ActivityLogs.EntityID, Customers.PreferredWarehouse) CAN dangle; linked fields cannot
//   * formula/rollup fields added by staff appear as unexpected fields with free-form names
// Every field the generator emits is checked against the census derived from src/lib/airtable.ts (deriveSourceShape).
import { SNAPSHOT_FORMAT } from "../../../scripts/lib/import/snapshot.mjs";
import { deriveSourceShape } from "./source-shape.mjs";

function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * @param {{ scale?: number, seed?: number, verified?: "none" | "partial" }} [opts]
 * @returns {{ snapshot: any, meta: any }}
 */
export function buildRealisticSnapshot({ scale = 1, seed = 20260301, verified = "none" } = {}) {
  const rnd = prng(seed); const pick = (a) => a[Math.floor(rnd() * a.length)]; const chance = (p) => rnd() < p; const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const shape = deriveSourceShape();
  const meta = { quirks: {}, scale };
  const q = (k, n = 1) => { meta.quirks[k] = (meta.quirks[k] ?? 0) + n; };
  const used = new Set();
  const newId = (prefix = "rec") => { for (;;) { let s = prefix; for (let i = 0; i < 14; i++) s += ALNUM[Math.floor(rnd() * ALNUM.length)]; if (!used.has(s)) { used.add(s); return s; } } };
  /** Airtable omits empty values. */
  const air = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0)));
  const created = (d) => new Date(Date.UTC(2024, 0, 1) + d * 3600e3 * 7.3).toISOString();
  const t = { Warehouses: [], Suppliers: [], PackageRates: [], SpecialRates: [], Settings: [], Customers: [], Users: [], Containers: [], Items: [], Orders: [], StatusHistory: [], ActivityLogs: [], PendingRegistrations: [] };
  const add = (table, fields, id = newId()) => { t[table].push({ id, fields: air(fields) }); return id; };

  // ---- reference data ----
  const wh = [add("Warehouses", { Name: "Amrahia Warehouse", Address: "Adenta-Dodowa Road", Country: "Ghana", Phone: "0302000000", IsActive: true }), add("Warehouses", { Name: "Guangzhou Transit", Address: "Baiyun District", Country: "China", IsActive: true }), add("Warehouses", { Name: "Old Depot", Address: "", IsActive: false })];
  const ghostWarehouse = newId();                                                         // a warehouse that was deleted but is still named in a text field
  for (let i = 0; i < 8; i++) add("Suppliers", { SupplierID: `SUP-${String(i + 1).padStart(4, "0")}`, Name: `Supplier ${i + 1}`, Category: pick(["Electronics", "Clothing", undefined]), Platform: pick(["Alibaba", "1688", undefined]), Rating: chance(0.5) ? int(1, 5) : undefined, Notes: chance(0.3) ? " spaced note " : "", CreatedBy: "staff@example.invalid" });
  for (const [tier, sea, air_] of [["basic", 350, 8], ["business", 280, 6], ["enterprise", 450, 12], ["special", 500, 15]]) add("PackageRates", { Tier: tier, Sea: sea, Air: air_ });
  add("SpecialRates", { Name: "VIP Gold", Sea: 300, Air: 6 }); add("SpecialRates", { Name: "Air Only", Sea: 0, Air: 5 }); add("SpecialRates", { Name: "Bulk", Sea: 250, Air: 0 }); add("SpecialRates", { Name: "Bulk", Sea: 240, Air: 0 }); q("duplicate_special_rate_name");
  add("Settings", { UsdToGhs: 12.5, ShippingRatePerCbm: 350 });

  // ---- customers ----
  const nCust = 60 * scale; const marks = new Map(); const custs = [];
  for (let i = 0; i < nCust; i++) {
    const first = pick(["Ama", "Kofi", "Yaw", "Efua", "Kwame", "Abena", "Esi", "Kojo", "Nana"]), last = pick(["Mensah", "Boateng", "Asare", "Owusu", "Adjei", "Danso", "Appiah"]);
    const phone = `02${int(40, 59)}${String(int(0, 9999999)).padStart(7, "0")}`;
    const base = `MOVEZZ-${first[0]}${last[0]}${phone.slice(-4)}`; const n = (marks.get(base) ?? 0) + 1; marks.set(base, n);
    const mark = n === 1 ? base : `${base}-${n}`;                                          // uniqueShippingMark() appends -2, -3 ...
    if (n > 1) q("shipping_mark_suffix");
    const pkg = chance(0.3) ? pick(["standard", "discounted", "premium"]) : pick(["basic", "business", "enterprise", undefined]);
    if (["standard", "discounted", "premium"].includes(pkg)) q("legacy_package_name");
    const f = { Name: chance(0.05) ? ` ${first} ${last} ` : `${first} ${last}`, Phone: chance(0.1) ? `+233 ${phone.slice(1, 3)} ${phone.slice(3)}` : phone, Email: chance(0.85) ? `${first}.${last}.${i}@example.invalid`.toLowerCase() : undefined,
      ShippingMark: mark, ShippingAddress: `${mark}, A-Z Bulk Warehouse, Amrahia, Adenta-Dodowa Road`, FirebaseUID: chance(0.7) ? `uid${newId("")}` : undefined, Status: chance(0.85) ? "active" : chance(0.5) ? "inactive" : undefined,
      ShippingType: pick(["air", "sea", undefined]), CustomerPackage: pkg, ExchangeRate: chance(0.1) ? pick([12.5, "14", 13.75]) : undefined, Notes: chance(0.2) ? "VIP" : "",
      PreferredWarehouse: chance(0.3) ? (chance(0.1) ? ghostWarehouse : pick(wh)) : undefined, CreatedAt: created(i), CreatedBy: chance(0.8) ? "staff@example.invalid" : undefined };
    if (f.ExchangeRate === "14") q("numeric_string_exchange_rate");
    if (f.PreferredWarehouse === ghostWarehouse) q("dangling_preferred_warehouse");
    if (chance(0.04)) { f["Days As Customer"] = int(1, 900); f["Loyalty (old)"] = pick(["gold", "silver"]); q("staff_formula_fields"); }
    custs.push({ id: add("Customers", f), f });
  }
  // the same person registered twice (different phone formatting) and a shared phone
  const dupSrc = custs[3].f; add("Customers", { ...dupSrc, ShippingMark: dupSrc.ShippingMark + "-9", Phone: dupSrc.Phone.replace(/^0/, "+233"), CreatedAt: created(nCust + 1) }); q("duplicate_customer_same_email");
  const sharedPhone = custs[5].f.Phone; add("Customers", { Name: "Someone Else", Phone: sharedPhone, ShippingMark: "MOVEZZ-SE" + sharedPhone.slice(-4), Status: "active", CreatedAt: created(nCust + 2) }); q("shared_phone_different_person");
  const deletedCust = newId();                                                            // customers.delete() removed it: items lost their link
  // ---- containers ----
  const nCont = 6 * scale; const conts = [];
  for (let i = 0; i < nCont; i++) conts.push(add("Containers", { ContainerID: `PMX-CON-${i < nCont / 2 ? 2025 : 2026}-${String(i + 1).padStart(3, "0")}`, Name: chance(0.7) ? pick(["MSC", "Maersk", "COSCO"]) : undefined, Description: chance(0.3) ? "Mixed cargo" : undefined,
    Status: pick(["Loading", "Shipped to Ghana", "Arrived in Ghana"]), DepartureDate: `2025-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`, TrackingNumber: `MSCU${int(1000000, 9999999)}`, CreatedAt: created(i * 3), CreatedBy: "staff@example.invalid" }));
  add("Containers", { ContainerID: "PMX-CON-2025-001", Name: "Duplicate of #1", TrackingNumber: "DUP1" }); q("duplicate_container_ref");
  add("Containers", { ContainerID: "PMX-CON-007", TrackingNumber: "OLDFMT", Status: "Arrived in Ghana" }); q("pre_year_container_ref");

  // ---- items ----
  const nItem = 400 * scale; const items = []; const STAT = ["Arrived at Transit Warehouse", "Shipped to Ghana", "Arrived in Ghana", "Awaiting Customs Clearance & Duty Process", "Sorting", "Ready for Pickup", "Completed"];
  const attachment = (i) => { const id = newId("att"); return { id, url: `https://v5.airtableusercontent.com/v1/${i}/${id}.jpg`, filename: `IMG_${i}.jpg`, size: int(20000, 900000), type: "image/jpeg", width: 1200, height: 900,
    thumbnails: { small: { url: `https://v5.airtableusercontent.com/s/${id}`, width: 36, height: 27 }, large: { url: `https://v5.airtableusercontent.com/l/${id}`, width: 512, height: 384 }, full: { url: `https://v5.airtableusercontent.com/f/${id}`, width: 3000, height: 3000 } } }; };
  const cartonDefs = new Map();
  for (let i = 0; i < nItem; i++) {
    const c = pick(custs); const air_ = chance(0.4); const orphan = chance(0.02);
    const dims = () => { const d = pick([30, 40, 55.5, 60, 100]); return chance(0.03) ? d + 0.125 : d; };           // 3-decimal staff entry: more precision than the new schema stores
    const inCarton = !air_ && chance(0.2); let cn, cdef;
    if (inCarton) { cn = `CTN-${String(int(1, Math.max(4, nItem / 8))).padStart(4, "0")}`; cdef = cartonDefs.get(cn) ?? { L: 100, W: 100, H: chance(0.1) ? undefined : 50, cust: c.id, container: pick(conts) }; q(cdef.H === undefined ? "carton_incomplete_measurements" : "carton_member"); if (!cartonDefs.has(cn)) cartonDefs.set(cn, cdef); }
    const special = chance(0.03); const price = air_ ? Math.round(int(1, 40) * 8 * 100) / 100 : Math.round(int(5, 90) * 3.5 * 100) / 100;
    const f = { ItemRef: `ITM-${String(i + 1).padStart(4, "0")}`, Customer: orphan ? undefined : [inCarton ? cdef.cust : c.id], CustomerName: orphan ? undefined : [c.f.Name], CustomerShippingMark: orphan ? undefined : [c.f.ShippingMark], Container: inCarton ? (chance(0.9) ? [cdef.container] : [pick(conts)]) : chance(0.5) ? [pick(conts)] : undefined,
      Status: chance(0.01) ? "Received" : pick(STAT), FreightType: pick(["air", "sea", undefined]), Description: pick(["Shoes", "Phones", " Fabric ", "Bags", "Watches"]), DateReceived: `2025-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
      DimensionUnit: pick(["cm", "inches", undefined]), IsMissing: chance(0.02), Quantity: chance(0.3) ? int(1, 5) : undefined, CreatedAt: created(i), CreatedBy: "staff@example.invalid", Notes: chance(0.1) ? "fragile" : "",
      Photos: chance(0.5) ? Array.from({ length: int(1, 3) }, (_, k) => attachment(i * 3 + k)) : undefined };
    if (orphan) q("item_without_customer_link");
    if (air_) { f.FreightType = "air"; f.Weight = chance(0.05) ? 0.1 + 0.2 : Math.round(rnd() * 3000) / 100 + 0.5; f.PkgShippingRate = 8; f.PkgEstShipping = inCarton ? Math.round(price / 3 * 100) / 100 : price; }
    else { f.FreightType = chance(0.9) ? "sea" : undefined; f.Length = dims(); f.Width = dims(); f.Height = dims(); f.PkgShippingRate = 350; f.PkgEstShipping = price; }
    if (f.Length && f.Length % 1 === 0.125) q("three_decimal_dimension");
    if (f.Weight === 0.1 + 0.2) q("float_noise_weight");
    if (chance(0.05)) { f.EstPrice = 0.1 * 3 * 100; q("float_noise_price"); }
    if (inCarton) { Object.assign(f, { CartonNumber: cn, CartonLength: cdef.L, CartonWidth: cdef.W, CartonHeight: cdef.H, PreCartonPkgEstShipping: price, FreightType: "sea", Length: dims(), Width: dims(), Height: dims() }); delete f.Weight; }
    if (special) { Object.assign(f, { IsSpecialItem: true, specialRateName: "VIP Gold", EstShippingPrice: Math.round(price * 0.9 * 100) / 100, SpecialShippingRate: 300 }); delete f.CartonNumber; q("special_item"); }
    if (chance(0.03)) { f["Days In Transit"] = int(1, 80); f["Internal Code (new)"] = `X${i}`; q("staff_formula_fields"); }
    if (chance(0.02)) { f.Weight = "12.5"; q("numeric_string_weight"); }
    if (chance(0.01)) { f.DateReceived = "03/04/2025"; q("malformed_date"); }
    if (chance(0.01)) { f.Weight = "abc"; q("invalid_number"); }
    const id = add("Items", f); items.push({ id, f, customer: orphan ? null : (inCarton ? cdef.cust : c.id), inCarton });
  }
  // ---- orders: the app creates them Pending with InvoiceAmount in USD; Keepup later overwrites InvoiceAmount with the net GHS ----
  const nOrder = 90 * scale; const free = items.filter((x) => x.customer && !x.inCarton); const orders = [];
  for (let i = 0; i < nOrder && free.length > 3; i++) {
    const first = free.shift(); const members = [first]; while (chance(0.5) && free.length && members.length < 4) { const m = free.findIndex((x) => x.customer === first.customer); if (m < 0) break; members.push(free.splice(m, 1)[0]); }
    const usd = Math.round(members.reduce((s, m) => s + (m.f.PkgEstShipping ?? 0), 0) * 100) / 100; const keepup = chance(0.6);
    const paid = keepup && chance(0.5); const ghs = Math.round(usd * 12.5 * 100) / 100; const status = paid ? "Paid" : keepup && chance(0.3) ? "Partial" : "Pending";
    const f = { OrderRef: `ORD-${String(i + 1).padStart(5, "0")}`, Customer: [first.customer], Items: members.map((m) => m.id), InvoiceAmount: keepup ? ghs : usd, Discount: chance(0.1) ? 5 : undefined, Status: status, InvoiceDate: chance(0.5) ? created(i) : created(i).slice(0, 10),
      CreatedAt: created(i), KeepupSaleId: keepup ? String(100000 + i) : undefined, KeepupLink: keepup ? `https://keepup.invalid/sale/${100000 + i}` : undefined,
      AmountPaid: status === "Paid" ? ghs : status === "Partial" ? Math.round(ghs / 2 * 100) / 100 : undefined, BalanceDue: status === "Paid" ? 0 : status === "Partial" ? Math.round(ghs / 2 * 100) / 100 : keepup ? ghs : undefined, CustomerName: [custs.find((c) => c.id === first.customer)?.f.Name] };
    q(keepup ? "order_amount_is_ghs" : "order_amount_is_usd");
    const id = add("Orders", f); orders.push({ id, f, members, usd, ghs, status });
    for (const m of members) { m.f.Order = [id]; m.f.OrderRef = [f.OrderRef]; const rec = t.Items.find((r) => r.id === m.id); rec.fields.Order = [id]; rec.fields.OrderRef = [f.OrderRef]; }
  }
  // an item linked to two orders and an order/item pair that disagree
  if (orders.length > 4) { const rec = t.Items.find((r) => r.id === orders[2].members[0].id); rec.fields.Order = [orders[2].id, orders[3].id]; q("item_with_two_order_links"); const o = t.Orders.find((r) => r.id === orders[4].id); o.fields.Items = [...o.fields.Items, items[0].id]; q("order_lists_foreign_item"); }

  // ---- history (some about records that were deleted afterwards) ----
  const hist = (rt, rid, ref, prev, next, i) => add("StatusHistory", { RecordType: rt, RecordID: rid, RecordRef: ref, PreviousStatus: prev, NewStatus: next, ChangedBy: chance(0.8) ? "staff@example.invalid" : undefined, ChangedByRole: pick(["warehouse_staff", "super_admin"]), ChangedAt: new Date(Date.UTC(2025, 0, 1) + i * 3600e3 * 5).toISOString(), Notes: chance(0.1) ? "bulk update" : "" });
  for (let i = 0; i < 450 * scale; i++) { const it = pick(items); hist("Item", it.id, it.f.ItemRef, pick([...STAT, undefined]), pick(STAT), i); }
  for (let i = 0; i < 40 * scale; i++) { hist("Item", newId(), `ITM-9${i}`, "Sorting", "Completed", 500 + i); q("history_of_deleted_item"); }
  for (const o of orders.slice(0, 40 * scale)) hist("Order", o.id, o.f.OrderRef, "Pending", o.status, 1000);
  for (const c of conts.slice(0, 6)) hist("Container", c, "PMX", "Loading", "Shipped to Ghana", 2000);
  for (let i = 0; i < 300 * scale; i++) add("ActivityLogs", { Action: pick(["CREATE_ITEM", "UPDATE_ITEM", "LOGIN", "CREATE_ORDER"]), UserEmail: "staff@example.invalid", UserRole: pick(["warehouse_staff", "super_admin"]), Details: "…", EntityType: chance(0.7) ? pick(["Item", "Order"]) : "", EntityID: chance(0.5) ? pick(items).id : chance(0.2) ? newId() : "", Timestamp: new Date(Date.UTC(2025, 1, 1) + i * 3600e3).toISOString(), IPAddress: chance(0.3) ? "203.0.113.7" : undefined });
  // ---- users: staff + customer logins (some customer logins point at records that no longer exist as linked records) ----
  add("Users", { FirebaseUID: "uidAdmin1", Email: "admin@example.invalid", Role: "super_admin", LastLogin: created(500), CreatedAt: created(1) });
  add("Users", { FirebaseUID: "uidStaff1", Email: "staff@example.invalid", Role: "warehouse_staff", LastLogin: created(400), CreatedAt: created(2) });
  for (let i = 0; i < 18 * scale; i++) { const c = custs[i]; add("Users", { FirebaseUID: c.f.FirebaseUID ?? `uidX${i}`, Email: c.f.Email ?? `login${i}@example.invalid`, Role: "customer", CustomerRecord: [c.id], CustomerName: [c.f.Name], CreatedAt: created(i), LastLogin: created(i + 40) }); }
  for (let i = 0; i < 5; i++) add("PendingRegistrations", { Name: `Applicant ${i}`, Email: `applicant${i}@example.invalid`, Phone: `0555000${i}00`, Phone2: chance(0.5) ? "0555999999" : undefined, ExistingMark: "", Location: "Accra", Status: i === 0 ? "Created" : "Pending" });

  // ---- OPTIONAL synthetic stand-in for the (non-existent) verified extraction: a consistent subset, so the financial path can be exercised at scale ----
  if (verified === "partial") {
    t.VerifiedInvoices = []; t.VerifiedInvoiceLines = []; t.VerifiedPayments = [];
    orders.filter((_, i) => i % 3 === 0).forEach((o, i) => {
      const sub = o.usd; if (!(sub > 0)) return; const fx = 12.5; const total = Math.round(sub * fx * 100) / 100;
      add("VerifiedInvoices", { OrderRecordID: o.id, SubtotalUsd: sub, DiscountUsd: 0, FxRate: fx, TotalGhs: total, Source: "synthetic-stand-in" }, `vi${i}`);
      o.members.forEach((m, k) => add("VerifiedInvoiceLines", { LineKey: `L-${o.id}-${k}`, OrderRecordID: o.id, LineNo: k + 1, ItemRecordID: m.id, Description: m.f.Description.trim(), UnitPriceUsd: m.f.PkgEstShipping, BillingBasis: "tier" }, `vl${i}_${k}`));
      if (o.status !== "Pending") add("VerifiedPayments", { PaymentKey: `P-${o.id}`, OrderRecordID: o.id, AmountGhs: o.status === "Paid" ? total : Math.round(total / 2 * 100) / 100, Currency: "GHS", Method: "momo", PaidAt: "2025-06-01T10:00:00Z", Status: "completed" }, `vp${i}`);
    });
  }

  // ---- conformance with the code-derived census: every emitted field must be one the application reads or writes (or a declared extra) ----
  const extras = { Items: ["Days In Transit", "Internal Code (new)"], Customers: ["Days As Customer", "Loyalty (old)"] };
  const bad = [];
  for (const [table, rows] of Object.entries(t)) {
    if (table.startsWith("Verified")) continue;                                // the verified supplement is a contract of the importer, not an Airtable table
    const known = new Set([...(shape[table]?.fields ?? []), ...(extras[table] ?? [])]);
    if (table === "PendingRegistrations") for (const k of ["Phone2", "ExistingMark", "Location", "Email"]) known.add(k);
    for (const r of rows) for (const [k, v] of Object.entries(r.fields)) {
      if (!known.has(k)) bad.push(`${table}.${k}`);
      if (shape[table]?.reads[k] === "array" && !Array.isArray(v) && !(table === "Users" && k === "CustomerName")) bad.push(`${table}.${k} must be an array`);
    }
  }
  if (bad.length) throw new Error(`realistic fixture drifted from the source-code census: ${[...new Set(bad)].join(", ")}`);
  const snapshot = { format: SNAPSHOT_FORMAT, source: { kind: "fixture", label: `realistic-${scale}x-${verified}`, capturedAt: "2026-03-01T00:00:00.000Z" }, tables: Object.fromEntries(Object.entries(t).filter(([, v]) => v.length)) };
  meta.counts = Object.fromEntries(Object.entries(snapshot.tables).map(([k, v]) => [k, v.length]));
  meta.ordersOnItems = orders.reduce((s, o) => s + o.members.length, 0);
  return { snapshot, meta };
}
