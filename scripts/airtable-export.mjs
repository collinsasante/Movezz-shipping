#!/usr/bin/env node
// Read-only Airtable export (GET requests only) and independent verification. See scripts/lib/export/export.mjs for the guarantees.
//
//   export  MOVEZZ_EXPORT_AIRTABLE_TOKEN=<read-only token> MOVEZZ_EXPORT_AIRTABLE_BASE=app... \
//           node scripts/airtable-export.mjs export --authorized-by "<name>" --confirm-base app... --out-dir /abs/dir --confirm-destination /abs/dir [--label L] [--passes 2|3] [--allow-missing-links]
//   verify  node scripts/airtable-export.mjs verify --snapshot F --manifest M --expect-fingerprint <value given to you by the exporter, out of band> [--expect-count Customers=123 ...]
//
// The credential variables are deliberately NOT AIRTABLE_API_KEY / AIRTABLE_BASE_ID, so the live application's configuration can never be used by accident.
// Run it only after the freeze (docs/CUTOVER-RUNBOOK.md §2) and only with written authorisation. This repository's tests never contact Airtable.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAirtableReader, runExport, ExportError } from "./lib/export/export.mjs";
import { verifyExport } from "./lib/export/verify.mjs";
import { assertDestination, writeNew } from "./lib/export/destination.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const all = (n) => rest.flatMap((a, i) => (a === n ? [rest[i + 1]] : []));
const token = process.env.MOVEZZ_EXPORT_AIRTABLE_TOKEN;
const redact = (m) => String(m).split(token || "\u0000").join("[token]");
try {
  if (cmd === "export") {
    const baseId = process.env.MOVEZZ_EXPORT_AIRTABLE_BASE;
    if (!token || !baseId) throw new ExportError("CONFIG", "MOVEZZ_EXPORT_AIRTABLE_TOKEN and MOVEZZ_EXPORT_AIRTABLE_BASE are required");
    if (opt("--confirm-base") !== baseId) throw new ExportError("AUTHORIZATION", "--confirm-base must equal MOVEZZ_EXPORT_AIRTABLE_BASE (name the base you are authorised to export)");
    const authorizedBy = opt("--authorized-by");
    if (!authorizedBy || authorizedBy.trim().length < 3) throw new ExportError("AUTHORIZATION", "--authorized-by must name the person who authorised this export");
    const dir = assertDestination(opt("--out-dir"), opt("--confirm-destination"), REPO);
    const passes = Number(opt("--passes") ?? 2); if (!(passes >= 2 && passes <= 3)) throw new ExportError("CONFIG", "a real export needs --passes 2 or 3 (consistency check)");
    const label = (opt("--label") ?? "airtable-export").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "airtable-export";
    const reader = createAirtableReader({ baseId, token });
    const r = await runExport({ reader, baseId, passes, label, authorizedBy, allowMissingLinks: rest.includes("--allow-missing-links") });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
    const snapFile = path.join(dir, `${label}-${stamp}.snapshot.json`); const manFile = path.join(dir, `${label}-${stamp}.manifest.json`);
    writeNew(snapFile, r.text); writeNew(manFile, JSON.stringify(r.manifest, null, 1));
    console.log(JSON.stringify({ written: [path.basename(snapFile), path.basename(manFile)], directory: dir, totalRecords: r.manifest.deterministic.totalRecords, counts: Object.fromEntries(Object.entries(r.manifest.deterministic.tables).map(([t, v]) => [t, v.records])),
      fingerprint: r.manifest.deterministic.fingerprint, warnings: r.manifest.warnings, next: "Record the fingerprint and the per-table counts on a SEPARATE channel from the files; verification requires them." }, null, 1));
  } else if (cmd === "verify") {
    const counts = {}; for (const kv of all("--expect-count")) { const [t, n] = String(kv).split("="); if (!t || !/^\d+$/.test(n ?? "")) throw new ExportError("CONFIG", `--expect-count needs Table=N, got "${kv}"`); counts[t] = Number(n); }
    const res = verifyExport({ snapshotText: readFileSync(opt("--snapshot") ?? "", "utf8"), manifestText: readFileSync(opt("--manifest") ?? "", "utf8"), expectFingerprint: opt("--expect-fingerprint") ?? "", expectCounts: counts });
    for (const c of res.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    console.log(`\nverdict: ${res.verdict}`);
    process.exitCode = res.verdict === "VERIFIED" ? 0 : res.verdict === "FAIL" ? 1 : 3;
  } else throw new ExportError("CONFIG", "usage: airtable-export.mjs <export|verify> ...");
} catch (e) { console.error(`refused or failed: ${redact(e.message)}`); process.exitCode = 1; }
