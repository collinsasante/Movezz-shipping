// SOURCE-CODE-DERIVED shape census. NOT production validation: the Airtable base was never read. This parses src/lib/airtable.ts
// (the only code that reads/writes Airtable) and reports, per table, every field name the application reads or writes and HOW it reads it
// (scalar, array/linked/lookup, attachment list). The importer's allow-lists and the realistic fixture are checked against this census,
// so a field the application really uses can never be missing from the importer, and the census follows the code if the code changes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../../src/lib/airtable.ts", import.meta.url));
const TABLE_OF = { CUSTOMERS: "Customers", ITEMS: "Items", ORDERS: "Orders", CONTAINERS: "Containers", STATUS_HISTORY: "StatusHistory", ACTIVITY_LOGS: "ActivityLogs", USERS: "Users",
  SUPPLIERS: "Suppliers", WAREHOUSES: "Warehouses", SPECIAL_RATES: "SpecialRates", PACKAGE_RATES: "PackageRates", SETTINGS: "Settings", PENDING_REGISTRATIONS: "PendingRegistrations" };
const MAPPERS = { Customers: "mapCustomer", Items: "mapItem", Orders: "mapOrder", Containers: "mapContainer", StatusHistory: "mapStatusHistory", ActivityLogs: "mapActivityLog", Users: "mapUser",
  Suppliers: "mapSupplier", Warehouses: "mapWarehouse", SpecialRates: "mapSpecialRate", PackageRates: "mapPackageRateRecord" };
const NOISE = new Set(["repair", "fields", "field", "direction", "Validation", "recordType", "recordId", "recordRef", "changedBy", "changedAt", "effort"]);

/** @returns {Record<string, { fields: string[], reads: Record<string, 'array'|'scalar'|'attachments'>, writes: string[] }>} */
export function deriveSourceShape(text = readFileSync(SRC, "utf8")) {
  const shape = {};
  const t = (name) => (shape[name] ??= { fields: new Set(), reads: {}, writes: new Set() });
  for (const [table, fn] of Object.entries(MAPPERS)) {
    const i = text.indexOf(`function ${fn}(`); const j = text.indexOf("\n}\n", i);
    const body = text.slice(i, j);
    for (const m of body.matchAll(/f\["(\w+)"\]([^\n]*)/g)) {
      const [, name, rest] = m;
      t(table).fields.add(name);
      t(table).reads[name] = /as ItemPhoto\[\]/.test(rest) ? "attachments" : /as string\[\]|\[0\]|Array\.isArray/.test(rest) || /\(f\["\w+"\] as string\[\]\)/.test(rest) ? "array" : "scalar";
    }
    // the mapper reads some lookups through a local variable
    if (table === "Users" && /rawName/.test(body)) { t(table).reads.CustomerName = "array"; t(table).fields.add("CustomerName"); }
  }
  for (const m of text.matchAll(/(createRecord|updateRecord)\(\s*TABLES\.(\w+)\s*,[^{]*\{([^}]*)\}/g)) {
    const table = TABLE_OF[m[2]]; if (!table) continue;
    for (const k of m[3].matchAll(/(?:^|[\s,{])([A-Za-z]\w*)\s*:/g)) if (!NOISE.has(k[1])) { t(table).fields.add(k[1]); t(table).writes.add(k[1]); }
  }
  for (const m of text.matchAll(/fields\["(\w+)"\]\s*=/g)) { /* written through a local FieldSet: attributed by the importer test to the owning table */ void m; }
  const out = {};
  for (const [name, v] of Object.entries(shape)) {
    for (const n of NOISE) v.fields.delete(n);
    out[name] = { fields: [...v.fields].sort(), reads: v.reads, writes: [...v.writes].sort() };
  }
  return out;
}

/** Fields the application writes through a FieldSet variable (so they are invisible to the literal scan): collected from the whole file. */
export function fieldSetWrites(text = readFileSync(SRC, "utf8")) {
  return [...new Set([...text.matchAll(/fields\["(\w+)"\]\s*=/g)].map((m) => m[1]).concat([...text.matchAll(/(?:pricingFields|statusUpdateFields|repair)\["(\w+)"\]/g)].map((m) => m[1])))].sort();
}
