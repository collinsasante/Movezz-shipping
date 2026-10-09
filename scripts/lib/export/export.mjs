// Read-only Airtable exporter (library). It produces the snapshot format the importer reads (scripts/lib/import/snapshot.mjs) plus a manifest,
// using only the public Airtable REST "list records" contract: GET /v0/{base}/{table}?pageSize=100[&offset=...] -> { records: [{ id, createdTime,
// fields }], offset? }, HTTP 429 = wait 30 s, Authorization: Bearer <token>. It never writes to Airtable (GET only), takes the network as an
// injected `fetch`, and writes NOTHING unless every table was read completely, consistently (two passes), without duplicates.
//
// Honest limits: Airtable has no count endpoint and no snapshot isolation. "Complete" therefore means: pagination ended normally in every pass,
// both passes are byte-identical, ids are unique, links resolve, and (checked separately, by a person, against Airtable's own counts at freeze
// time) the per-table counts match. A source that is still being written to is detected only if it changes between the two passes.
import { createHash } from "node:crypto";
import { AIRTABLE_TABLES, SNAPSHOT_FORMAT, parseSnapshotText, snapshotFingerprint } from "../import/snapshot.mjs";
import { canonicalJson } from "../import/util.mjs";

export class ExportError extends Error { constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; } }
export const EXPORTER_VERSION = "1";
export const MANIFEST_FORMAT = "movezz-airtable-export-manifest/1";
const API = "https://api.airtable.com/v0";
const sha = (t) => createHash("sha256").update(t).digest("hex");

/** Link fields (record-id arrays) that the importer follows; every target must exist in the export. */
export const LINKS = [
  ["Items", "Customer", "Customers"], ["Items", "Container", "Containers"], ["Items", "Order", "Orders"], ["Orders", "Customer", "Customers"],
  ["Orders", "Items", "Items"], ["Users", "CustomerRecord", "Customers"], ["Containers", "Items", "Items"],
];

const DEFAULTS = { pageSize: 100, maxAttempts: 5, requestTimeoutMs: 30_000, minIntervalMs: 220, maxPages: 10_000, rateLimitWaitMs: 30_000, baseBackoffMs: 1000, maxBackoffMs: 30_000 };

/** @typedef {{ id: string, createdTime?: string, fields: Record<string, unknown> }} Rec */

function redact(text, token) { return String(text ?? "").split(token || "\u0000").join("[token]").replace(/Bearer\s+\S+/gi, "Bearer [token]").slice(0, 200); }

/**
 * @param {{ baseId: string, token: string, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number, random?: () => number } & Partial<typeof DEFAULTS>} cfg
 */
export function createAirtableReader(cfg) {
  const o = { ...DEFAULTS, ...cfg };
  if (!/^app[A-Za-z0-9]{10,}$/.test(o.baseId ?? "")) throw new ExportError("CONFIG", "the base id must look like appXXXXXXXXXXXXXX");
  if (!o.token || o.token.length < 10) throw new ExportError("CONFIG", "an Airtable token is required");
  const doFetch = o.fetchImpl ?? fetch; const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); const rnd = o.random ?? Math.random;
  let last = 0; const stats = { requests: 0, retries: 0, rateLimited: 0 };

  async function get(table, offset) {
    const url = new URL(`${API}/${o.baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set("pageSize", String(o.pageSize));
    if (offset) url.searchParams.set("offset", offset);
    let lastErr = "unknown";
    for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
      const wait = (o.now ?? Date.now)() - last; if (wait < o.minIntervalMs) await sleep(o.minIntervalMs - wait);   // ~5 requests/s per base is Airtable's documented limit
      last = (o.now ?? Date.now)(); stats.requests++;
      let res;
      try {
        res = await doFetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${o.token}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(o.requestTimeoutMs) });
      } catch (e) { lastErr = `network/timeout (${e?.name ?? "error"})`; stats.retries++; if (attempt < o.maxAttempts) await sleep(Math.min(o.maxBackoffMs, o.baseBackoffMs * 2 ** (attempt - 1)) * (0.5 + rnd() / 2)); continue; }
      if (res.status === 429) {
        stats.rateLimited++; stats.retries++; lastErr = "rate limited (429)";
        const ra = Number(res.headers.get("retry-after")); if (attempt < o.maxAttempts) await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 120_000) : o.rateLimitWaitMs); continue;
      }
      if (res.status === 408 || res.status >= 500) { lastErr = `HTTP ${res.status}`; stats.retries++; if (attempt < o.maxAttempts) await sleep(Math.min(o.maxBackoffMs, o.baseBackoffMs * 2 ** (attempt - 1)) * (0.5 + rnd() / 2)); continue; }
      if (res.status === 401 || res.status === 403) throw new ExportError("AUTH", `Airtable refused the token for table ${table} (HTTP ${res.status}); nothing was exported`);
      if (res.status === 404) throw new ExportError("TABLE_MISSING", `table ${table} was not found in the base (HTTP 404); nothing was exported`);
      if (!res.ok) throw new ExportError("HTTP", `table ${table}: unexpected HTTP ${res.status}; nothing was exported`);
      let body;
      try { body = await res.json(); } catch { lastErr = "unparsable response"; stats.retries++; continue; }
      if (!body || !Array.isArray(body.records) || (body.offset !== undefined && typeof body.offset !== "string")) { lastErr = "malformed page"; stats.retries++; continue; }
      return body;
    }
    throw new ExportError("RETRIES_EXHAUSTED", `table ${table}: ${lastErr} after ${o.maxAttempts} attempts; nothing was exported`);
  }

  /** @returns {Promise<{ records: Rec[], pages: number }>} one full pass over one table */
  async function readTable(table) {
    const records = []; const ids = new Set(); const offsets = new Set(); let offset; let pages = 0;
    do {
      if (++pages > o.maxPages) throw new ExportError("PAGINATION", `table ${table}: more than ${o.maxPages} pages; refusing to continue`);
      const body = await get(table, offset);
      for (const r of body.records) {
        if (!r || typeof r.id !== "string" || r.fields === null || typeof r.fields !== "object" || Array.isArray(r.fields)) throw new ExportError("MALFORMED", `table ${table}: a record has no id or fields object`);
        if (ids.has(r.id)) throw new ExportError("DUPLICATE_ID", `table ${table}: record ${r.id} was returned twice (records moved during pagination); the source is not stable`);
        ids.add(r.id); records.push({ id: r.id, createdTime: typeof r.createdTime === "string" ? r.createdTime : undefined, fields: r.fields });
      }
      offset = body.offset;
      if (offset !== undefined) { if (offsets.has(offset)) throw new ExportError("PAGINATION", `table ${table}: the pagination cursor repeated`); offsets.add(offset); }
    } while (offset !== undefined);
    return { records, pages };
  }
  return { readTable, stats };
}

const sortById = (recs) => [...recs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const contentHash = (recs) => sha(canonicalJson(sortById(recs).map((r) => ({ id: r.id, fields: r.fields }))));
const idHash = (recs) => sha(sortById(recs).map((r) => r.id).join("\n"));
const timeHash = (recs) => sha(sortById(recs).map((r) => `${r.id}\t${r.createdTime ?? ""}`).join("\n"));

/** Link integrity over the exported tables. Returns missing targets per link field (counts + a bounded sample of ids). */
export function checkLinks(tables) {
  const idsOf = Object.fromEntries(Object.entries(tables).map(([t, recs]) => [t, new Set(recs.map((r) => r.id))]));
  const out = [];
  for (const [table, field, target] of LINKS) {
    let checked = 0; let missing = 0; const sample = [];
    for (const r of tables[table] ?? []) {
      const v = r.fields[field]; if (!Array.isArray(v)) continue;
      for (const id of v) { if (typeof id !== "string") continue; checked++; if (!idsOf[target]?.has(id)) { missing++; if (sample.length < 10) sample.push(id); } }
    }
    out.push({ table, field, target, checked, missing, sample });
  }
  return out;
}

/**
 * Reads every required table `passes` times and builds the snapshot + manifest in memory. Throws ExportError (nothing is written by this function).
 * @param {{ reader: ReturnType<typeof createAirtableReader>, baseId: string, passes?: number, label?: string, authorizedBy: string, allowMissingLinks?: boolean, now?: () => Date, tables?: string[] }} o
 */
export async function runExport({ reader, baseId, passes = 2, label = "airtable-export", authorizedBy, allowMissingLinks = false, now = () => new Date(), tables = AIRTABLE_TABLES }) {
  if (!Number.isInteger(passes) || passes < 1 || passes > 3) throw new ExportError("CONFIG", "passes must be 1..3");
  if (!authorizedBy || authorizedBy.trim().length < 3) throw new ExportError("AUTHORIZATION", "the person authorising the export must be named");
  const startedAt = now();
  // Pass 1 reads every table; each further pass re-reads EVERY table and compares it with pass 1. Reading whole passes (not table by table) means a
  // change anywhere during the export window, in any table, shows up as a difference; cross-table skew cannot hide between a table's two reads.
  const first = {}; const perTable = {};
  for (const t of tables) { const a = await reader.readTable(t); first[t] = a.records; perTable[t] = { records: a.records.length, pages: a.pages, passesCompared: 1 }; }
  for (let p = 2; p <= passes; p++) {
    for (const t of tables) {
      const b = await reader.readTable(t);
      if (contentHash(b.records) !== contentHash(first[t]) || idHash(b.records) !== idHash(first[t]))
        throw new ExportError("INCONSISTENT", `table ${t} changed between pass 1 and pass ${p} (${first[t].length} vs ${b.records.length} records): the source is not frozen; nothing was exported`);
      perTable[t].passesCompared = p;
    }
  }
  const links = checkLinks(first);
  const missingLinks = links.reduce((n, l) => n + l.missing, 0);
  if (missingLinks > 0 && !allowMissingLinks) throw new ExportError("MISSING_LINKS", `${missingLinks} linked record id(s) point at records that are not in the export: ${links.filter((l) => l.missing).map((l) => `${l.table}.${l.field}->${l.target}: ${l.missing}`).join("; ")}`, links);

  const capturedAt = startedAt.toISOString();
  const snapshot = { format: SNAPSHOT_FORMAT, source: { kind: "export", label, capturedAt }, tables: {} };
  for (const t of tables) snapshot.tables[t] = sortById(first[t]).map((r) => ({ id: r.id, ...(r.createdTime ? { createdTime: r.createdTime } : {}), fields: JSON.parse(canonicalJson(r.fields)) }));
  const text = JSON.stringify(snapshot);
  const parsed = parseSnapshotText(text);                      // exactly what the importer will see
  const fingerprint = snapshotFingerprint(parsed);
  const tainted = Object.fromEntries(Object.entries(parsed.tables).map(([t, rows]) => [t, rows.filter((r) => r.taint).length]).filter(([, n]) => n > 0));
  const knownDeterministic = Object.fromEntries(tables.map((t) => [t, { records: first[t].length, idSetSha256: idHash(first[t]), contentSha256: contentHash(first[t]), createdTimeSha256: timeHash(first[t]) }]));
  const manifest = {
    format: MANIFEST_FORMAT, exporterVersion: EXPORTER_VERSION, snapshotFormat: SNAPSHOT_FORMAT,
    deterministic: { tables: knownDeterministic, totalRecords: tables.reduce((n, t) => n + first[t].length, 0), fingerprint, links: links.map(({ table, field, target, checked, missing }) => ({ table, field, target, checked, missing })) },
    run: { baseId, authorizedBy: authorizedBy.trim(), startedAt: capturedAt, finishedAt: now().toISOString(), passes, requests: reader.stats.requests, retries: reader.stats.retries, rateLimited: reader.stats.rateLimited, pages: Object.fromEntries(tables.map((t) => [t, perTable[t].pages])), allowMissingLinks, importerTaintedRecords: tainted },
    warnings: [ ...(missingLinks ? [`${missingLinks} dangling link(s) were allowed by the operator`] : []), ...(Object.keys(tainted).length ? ["some records would be quarantined by the importer's content rules"] : []), ...(passes < 2 ? ["single pass: consistency was not checked"] : []) ],
  };
  return { text, manifest, snapshot: parsed };
}
