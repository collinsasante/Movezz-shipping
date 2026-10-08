#!/usr/bin/env node
// Read-only staging preflight (see scripts/lib/preflight.mjs). Writes nothing. Exit 0 = READY, 1 = FAIL, 3 = BLOCKED on owner inputs.
//   MOVEZZ_IMPORT_ENVIRONMENT=staging IMPORT_DATABASE_URL=... [DATABASE_URL=<movezz_app url>] [MOVEZZ_BACKUP_DIR=...] \
//   node scripts/staging-preflight.mjs [--snapshot FILE --expect-fingerprint SHA256]
import pg from "pg";
import { runPreflight } from "./lib/preflight.mjs";

const opt = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const connect = async (url) => { const c = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on", connectionTimeoutMillis: 8000 }); await c.connect(); return c; };
const r = await runPreflight({ ownerUrl: process.env.IMPORT_DATABASE_URL, runtimeUrl: process.env.DATABASE_URL, snapshotPath: opt("--snapshot"), expectFingerprint: opt("--expect-fingerprint"), connect });
for (const c of r.checks) console.log(`${c.status.padEnd(8)} ${c.id}${c.detail ? `  — ${c.detail}` : ""}`);
console.log(`\nverdict: ${r.verdict}  (pass ${r.pass}, fail ${r.fail}, blocked ${r.blocked}, not run ${r.notRun})`);
process.exitCode = r.verdict === "READY" ? 0 : r.verdict === "FAIL" ? 1 : 3;
