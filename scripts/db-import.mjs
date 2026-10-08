#!/usr/bin/env node
// Import / dry-run / reconcile CLI for the LOCAL snapshot importer (Phase 7I). It never contacts Airtable, Firebase, Keepup, Cloudinary or
// Cloudflare: it reads a local snapshot file and talks to ONE PostgreSQL database that must pass the environment guard.
//
//   MOVEZZ_IMPORT_ENVIRONMENT=local|test|staging  IMPORT_DATABASE_URL=postgres://...  ACTOR_CONTEXT_KEY=<base64>   (import only)
//   node scripts/db-import.mjs dry-run   --snapshot FILE [--report-json OUT.json]
//   node scripts/db-import.mjs import    --snapshot FILE --initiated-by LABEL [--report-json OUT.json]
//   node scripts/db-import.mjs reconcile --snapshot FILE [--report-json OUT.json]
// A dry-run without IMPORT_DATABASE_URL is fully offline. Exit codes: 0 READY / READY_WITH_REVIEW, 2 NOT_READY, 1 refused or failed.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { ImportRefusal } from "./lib/import/errors.mjs";
import { snapshotFingerprint } from "./lib/import/snapshot.mjs";
import { createLogger, dryRun, importSnapshot, reconcileSnapshot, readSnapshotFile, renderReport, reportToJson } from "./lib/import/index.mjs";

const [mode, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

async function main() {
  if (!["dry-run", "import", "reconcile", "fingerprint"].includes(mode)) throw new Error("usage: db-import.mjs <fingerprint|dry-run|import|reconcile> --snapshot FILE [--expect-fingerprint SHA256] [--initiated-by LABEL] [--report-json FILE]");
  const file = opt("--snapshot"); if (!file) throw new Error("--snapshot FILE is required");
  if (mode === "fingerprint") {   // offline: prints the data fingerprint of an export so it can be compared with what the exporter recorded
    process.stdout.write(snapshotFingerprint(await readSnapshotFile(file, { allowedRoot: process.cwd() })) + "\n");
    return;
  }
  const env = { ...process.env, MOVEZZ_IMPORT_MODE: mode };
  const targetUrl = process.env.IMPORT_DATABASE_URL;
  const snapshot = await readSnapshotFile(file, { allowedRoot: process.cwd() });
  const expected = opt("--expect-fingerprint");   // source integrity: the export must be exactly the one that was approved
  if (expected !== undefined && expected !== snapshotFingerprint(snapshot)) throw new Error("The snapshot does not match --expect-fingerprint; nothing was read from or written to the database");
  let pool;
  if (targetUrl) {
    // read-only modes also get a READ ONLY session at the connection level, on top of the READ ONLY transactions
    pool = new pg.Pool({ connectionString: targetUrl, max: 2, ...(mode === "import" ? {} : { options: "-c default_transaction_read_only=on" }) });
    pool.on("error", () => {});
  } else if (mode !== "dry-run") throw new Error("IMPORT_DATABASE_URL is required for import and reconcile");
  try {
    const initiatedBy = opt("--initiated-by") ?? "";
    const r = mode === "dry-run" ? await dryRun({ snapshot, pool, env, targetUrl })
      : mode === "import" ? await importSnapshot({ snapshot, pool, env, targetUrl, initiatedBy, log: createLogger({ sink: process.env.MOVEZZ_LOG === "json" ? (l) => process.stderr.write(l + "\n") : undefined }) })
      : await reconcileSnapshot({ snapshot, pool, env, targetUrl });
    process.stdout.write(renderReport(r.report) + "\n");
    const mj = opt("--metrics-json");
    if (mj && r.metrics) await writeFile(path.resolve(mj), JSON.stringify(r.metrics) + "\n", { flag: "wx" });
    const out = opt("--report-json");
    if (out) {
      const p = path.resolve(out);
      if (path.relative(process.cwd(), p).startsWith("..")) throw new Error("--report-json must be inside the working directory");
      await writeFile(p, reportToJson(r.report) + "\n", { flag: "wx" });          // never overwrites an existing file
    }
    process.exitCode = r.report.verdict === "NOT_READY" ? 2 : 0;
  } finally { await pool?.end(); }
}
main().catch((e) => {
  console.error(e instanceof ImportRefusal ? `REFUSED: ${e.message}` : `import failed: ${e.message}`);
  process.exitCode = 1;
});
