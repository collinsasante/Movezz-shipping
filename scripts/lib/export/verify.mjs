// Verification of an export against an INDEPENDENTLY supplied fingerprint. The expected value must come from outside this package (the person who
// froze and exported the base, over another channel). The function refuses to run without it and never derives it from the manifest, so a
// snapshot cannot vouch for itself. The manifest's own copy is only checked FOR CONSISTENCY with the expected value.
import { createHash } from "node:crypto";
import { AIRTABLE_TABLES, parseSnapshotText, snapshotFingerprint } from "../import/snapshot.mjs";
import { canonicalJson } from "../import/util.mjs";
import { ExportError, MANIFEST_FORMAT, checkLinks } from "./export.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const byId = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** @param {{ snapshotText: string, manifestText: string, expectFingerprint: string, expectCounts?: Record<string, number> }} o */
export function verifyExport({ snapshotText, manifestText, expectFingerprint, expectCounts }) {
  if (typeof expectFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(expectFingerprint)) throw new ExportError("CONFIG", "an independently supplied expected fingerprint (64 hex characters) is required");
  const checks = []; const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  let manifest; try { manifest = JSON.parse(manifestText); } catch { throw new ExportError("MANIFEST", "the manifest is not valid JSON"); }
  add("manifest format", manifest?.format === MANIFEST_FORMAT);
  const snap = parseSnapshotText(snapshotText);
  add("snapshot declares itself a real export", snap.source.kind === "export");
  const actual = snapshotFingerprint(snap);
  add("data fingerprint equals the INDEPENDENTLY supplied value", actual === expectFingerprint, actual === expectFingerprint ? "match" : "MISMATCH");
  add("manifest fingerprint equals the supplied value (consistency only)", manifest?.deterministic?.fingerprint === expectFingerprint);
  add("every required table is present", AIRTABLE_TABLES.every((t) => snap.tables[t] !== undefined), AIRTABLE_TABLES.filter((t) => snap.tables[t] === undefined).join(","));
  add("no unknown tables, no envelope problems", snap.unknownTables.length === 0 && snap.envelopeProblems.length === 0);
  const dup = []; const perTable = {};
  for (const t of AIRTABLE_TABLES) {
    const rows = snap.tables[t] ?? []; const ids = rows.map((r) => r.id);
    if (new Set(ids).size !== ids.length) dup.push(t);
    perTable[t] = { records: rows.length, idSetSha256: sha(byId(rows).map((r) => r.id).join("\n")), contentSha256: sha(canonicalJson(byId(rows).map((r) => ({ id: r.id, fields: r.fields })))) };
  }
  add("no duplicate ids", dup.length === 0, dup.join(","));
  const m = manifest?.deterministic?.tables ?? {};
  const diff = AIRTABLE_TABLES.filter((t) => m[t]?.records !== perTable[t].records || m[t]?.idSetSha256 !== perTable[t].idSetSha256 || m[t]?.contentSha256 !== perTable[t].contentSha256);
  add("manifest per-table counts and hashes equal the snapshot", diff.length === 0, diff.join(","));
  const links = checkLinks(Object.fromEntries(AIRTABLE_TABLES.map((t) => [t, (snap.tables[t] ?? []).map((r) => ({ id: r.id, fields: r.fields }))])));
  const missing = links.reduce((n, l) => n + l.missing, 0);
  add("all linked records resolve", missing === 0 || manifest?.run?.allowMissingLinks === true, `${missing} dangling`);
  add("consistency was checked (two or more passes)", (manifest?.run?.passes ?? 0) >= 2);
  let completenessConfirmed = false;
  if (expectCounts && Object.keys(expectCounts).length) {
    const bad = Object.entries(expectCounts).filter(([t, n]) => perTable[t]?.records !== n).map(([t, n]) => `${t}: expected ${n}, export has ${perTable[t]?.records ?? "none"}`);
    const missingTables = AIRTABLE_TABLES.filter((t) => expectCounts[t] === undefined);
    add("record counts equal the independently supplied counts", bad.length === 0, bad.join("; "));
    add("independent counts were supplied for every table", missingTables.length === 0, missingTables.join(","));
    completenessConfirmed = bad.length === 0 && missingTables.length === 0;
  }
  const ok = checks.every((c) => c.ok);
  return { verdict: !ok ? "FAIL" : completenessConfirmed ? "VERIFIED" : "FINGERPRINT_VERIFIED_COMPLETENESS_UNCONFIRMED", ok, completenessConfirmed, checks, counts: Object.fromEntries(AIRTABLE_TABLES.map((t) => [t, perTable[t].records])) };
}
