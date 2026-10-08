// Stage 1 - SOURCE SNAPSHOT and stage 2 - DISCOVERY.
//
// A snapshot is a local JSON file that mirrors the Airtable tables documented in this repository. The importer never talks to
// Airtable: it only reads a file, and the file is UNTRUSTED input - size-capped, depth-capped, free of prototype-polluting keys,
// control characters and oversized values (records that violate this are marked `tainted` and quarantined, never normalized).
//
//   { "format": "movezz-airtable-snapshot/1",
//     "source": { "kind": "fixture" | "export", "label": "...", "capturedAt": "2026-01-01T00:00:00Z" },
//     "tables": { "Customers": [ { "id": "recA1", "fields": { ... } }, ... ], ... } }
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ImportError } from "./errors.mjs";
import { canonicalJson, fingerprint, parseTimestamp } from "./util.mjs";

export const SNAPSHOT_FORMAT = "movezz-airtable-snapshot/1";

/** Tables read from Airtable (names as in src/lib/airtable.ts TABLES). */
export const AIRTABLE_TABLES = ["Warehouses", "Suppliers", "PackageRates", "SpecialRates", "Settings", "Customers", "Users", "Containers", "Items", "Orders", "StatusHistory", "ActivityLogs", "PendingRegistrations"];
/**
 * Supplemental tables a FUTURE verified extraction must provide (e.g. from verified Keepup/finance data). They are NOT Airtable
 * tables: the Airtable Orders table alone cannot prove currency, FX or payments (docs/DECISIONS.md D15, CHARACTERIZATION-BASELINE #2-#5).
 */
export const VERIFIED_TABLES = ["VerifiedInvoices", "VerifiedInvoiceLines", "VerifiedPayments"];
export const KNOWN_TABLES = [...AIRTABLE_TABLES, ...VERIFIED_TABLES];

export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxRecordsPerTable: 200_000, maxFieldsPerRecord: 200, maxStringLength: 20_000, maxDepth: 6, maxArrayLength: 1_000 });

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

/** Reads a snapshot file safely: must resolve (symlinks included) inside `allowedRoot`, be a regular file and fit the size cap. */
export async function readSnapshotFile(file, { allowedRoot = process.cwd(), limits = DEFAULT_LIMITS } = {}) {
  if (typeof file !== "string" || file.includes("\0")) throw new ImportError("SNAPSHOT_PATH", "Invalid snapshot path");
  let real; let root;
  try { real = await realpath(path.resolve(file)); root = await realpath(path.resolve(allowedRoot)); }
  catch { throw new ImportError("SNAPSHOT_PATH", "Snapshot file not found"); }
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new ImportError("SNAPSHOT_PATH", "Snapshot file must be inside the allowed directory");
  const st = await lstat(real);
  if (!st.isFile()) throw new ImportError("SNAPSHOT_PATH", "Snapshot path is not a regular file");
  if (st.size > limits.maxBytes) throw new ImportError("SNAPSHOT_TOO_LARGE", `Snapshot is ${st.size} bytes; the limit is ${limits.maxBytes}`);
  return parseSnapshotText(await readFile(real, "utf8"), limits);
}

/** Scans a JSON value for unsafe content. Returns a list of { category, reason } (empty = clean). */
function scanValue(v, limits, depth, path, out) {
  if (out.length >= 5) return;
  if (typeof v === "string") {
    if (v.length > limits.maxStringLength) out.push({ category: "OVERSIZED_FIELD", reason: `${path} is longer than ${limits.maxStringLength} characters` });
    else if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)) out.push({ category: "UNSAFE_CONTENT", reason: `${path} contains control characters` });
    return;
  }
  if (v === null || typeof v === "number" || typeof v === "boolean") return;
  if (depth > limits.maxDepth) { out.push({ category: "UNSAFE_CONTENT", reason: `${path} is nested deeper than ${limits.maxDepth}` }); return; }
  if (Array.isArray(v)) {
    if (v.length > limits.maxArrayLength) { out.push({ category: "OVERSIZED_FIELD", reason: `${path} has more than ${limits.maxArrayLength} entries` }); return; }
    v.forEach((x, i) => scanValue(x, limits, depth + 1, `${path}[${i}]`, out));
    return;
  }
  const keys = Object.keys(v);
  if (keys.length > limits.maxFieldsPerRecord) { out.push({ category: "OVERSIZED_FIELD", reason: `${path} has more than ${limits.maxFieldsPerRecord} keys` }); return; }
  for (const k of keys) {
    if (DANGEROUS_KEYS.has(k)) { out.push({ category: "UNSAFE_CONTENT", reason: `${path} contains the reserved key "${k}"` }); continue; }
    scanValue(v[k], limits, depth + 1, `${path}.${k.slice(0, 40)}`, out);
  }
}

/** Parses and structurally validates snapshot text. Throws ImportError for anything that makes the WHOLE file unusable. */
export function parseSnapshotText(text, limits = DEFAULT_LIMITS) {
  if (typeof text !== "string") throw new ImportError("SNAPSHOT_INVALID", "Snapshot is not text");
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) throw new ImportError("SNAPSHOT_TOO_LARGE", "Snapshot exceeds the size limit");
  let raw;
  try { raw = JSON.parse(text); } catch { throw new ImportError("SNAPSHOT_INVALID", "Snapshot is not valid JSON"); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ImportError("SNAPSHOT_INVALID", "Snapshot must be a JSON object");
  if (raw.format !== SNAPSHOT_FORMAT) throw new ImportError("SNAPSHOT_INVALID", `Unsupported snapshot format (expected ${SNAPSHOT_FORMAT})`);
  const src = raw.source;
  if (src === null || typeof src !== "object" || !["fixture", "export"].includes(src.kind)) throw new ImportError("SNAPSHOT_INVALID", 'source.kind must be "fixture" or "export"');
  const cap = parseTimestamp(src.capturedAt);
  if (!cap.ok) throw new ImportError("SNAPSHOT_INVALID", "source.capturedAt must be an ISO-8601 timestamp");
  if (raw.tables === null || typeof raw.tables !== "object" || Array.isArray(raw.tables)) throw new ImportError("SNAPSHOT_INVALID", "tables must be an object");

  /** @type {Record<string, {id: string, fields: Record<string, unknown>, taint?: {category: string, reason: string}[], index: number}[]>} */
  const tables = Object.create(null);
  const unknownTables = [];
  const envelopeProblems = [];
  for (const name of Object.keys(raw.tables)) {
    if (DANGEROUS_KEYS.has(name)) throw new ImportError("SNAPSHOT_INVALID", "Snapshot contains a reserved table name");
    const rows = raw.tables[name];
    if (!KNOWN_TABLES.includes(name)) { unknownTables.push({ table: name, records: Array.isArray(rows) ? rows.length : 0 }); continue; }
    if (!Array.isArray(rows)) throw new ImportError("SNAPSHOT_INVALID", `Table ${name} must be an array`);
    if (rows.length > limits.maxRecordsPerTable) throw new ImportError("SNAPSHOT_TOO_LARGE", `Table ${name} has more than ${limits.maxRecordsPerTable} records`);
    tables[name] = [];
    rows.forEach((r, index) => {
      if (r === null || typeof r !== "object" || Array.isArray(r) || typeof r.id !== "string" || !ID_RE.test(r.id) || DANGEROUS_KEYS.has(r.id) || r.fields === null || typeof r.fields !== "object" || Array.isArray(r.fields)) {
        envelopeProblems.push({ table: name, sourceId: `${name}#${index}`, category: "INVALID_ENVELOPE", reason: "record needs a string id (3-64 of A-Z a-z 0-9 _ -) and a fields object" });
        return;
      }
      const taint = [];
      scanValue(r.fields, limits, 0, "fields", taint);
      // own-property, null-prototype copy: later code can never reach Object.prototype through a source key
      const fields = Object.create(null);
      for (const k of Object.keys(r.fields)) if (!DANGEROUS_KEYS.has(k)) fields[k] = r.fields[k];
      tables[name].push({ id: r.id, fields, index, ...(taint.length ? { taint } : {}) });
    });
  }
  return { format: raw.format, source: { kind: src.kind, label: typeof src.label === "string" ? src.label.slice(0, 200) : "", capturedAt: cap.iso }, tables, unknownTables, envelopeProblems };
}

/** Order-independent fingerprint of the DATA (not the label): the same records always give the same value. */
export function snapshotFingerprint(snapshot) {
  const body = {};
  for (const name of Object.keys(snapshot.tables).sort()) {
    // ties (duplicate source ids) are ordered by content so the fingerprint never depends on file order
    body[name] = [...snapshot.tables[name]].map((r) => ({ id: r.id, fields: r.fields, c: canonicalJson(r.fields) })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.c < b.c ? -1 : a.c > b.c ? 1 : 0)).map(({ id, fields }) => ({ id, fields }));
  }
  return fingerprint({ format: snapshot.format, kind: snapshot.source.kind, tables: body });
}

/** Stage 2: what is in the snapshot. Pure and deterministic. */
export function discover(snapshot, knownFields = {}) {
  const tables = {};
  const duplicateIds = [];
  for (const name of Object.keys(snapshot.tables).sort()) {
    const rows = snapshot.tables[name];
    const seen = new Map(); const unexpected = new Map();
    for (const r of rows) {
      seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
      for (const k of Object.keys(r.fields)) if (knownFields[name] && !knownFields[name].includes(k)) unexpected.set(k, (unexpected.get(k) ?? 0) + 1);
    }
    for (const [id, n] of seen) if (n > 1) duplicateIds.push({ table: name, sourceId: id, copies: n });
    tables[name] = { records: rows.length, uniqueIds: seen.size, tainted: rows.filter((r) => r.taint).length, unexpectedFields: Object.fromEntries([...unexpected].sort()) };
  }
  return { tables, duplicateIds, unknownTables: snapshot.unknownTables, envelopeProblems: snapshot.envelopeProblems.length };
}
