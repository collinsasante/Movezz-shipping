#!/usr/bin/env node
// Quarantine review / resolution (Phase 7K). Same safety guard as the importer: local / test / allow-listed staging only, no live credentials.
//   IMPORT_DATABASE_URL=... MOVEZZ_IMPORT_ENVIRONMENT=local node scripts/db-quarantine.mjs list [--unresolved] [--batch ID]
//   node scripts/db-quarantine.mjs summary
//   node scripts/db-quarantine.mjs resolve --id N --resolution excluded|corrected_in_new_snapshot --reason "..." --resolved-by LABEL [--new-snapshot SHA256]
import pg from "pg";
import { assertApprovedEnvironment } from "./lib/import/env-guard.mjs";
import { listQuarantine, resolveQuarantine, unresolvedSummary } from "./lib/import/resolution.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
let pool;
try {
  if (!["list", "summary", "resolve"].includes(cmd)) throw new Error("usage: db-quarantine.mjs <list|summary|resolve> ...");
  const url = process.env.IMPORT_DATABASE_URL;
  assertApprovedEnvironment({ env: { ...process.env, MOVEZZ_IMPORT_MODE: cmd === "resolve" ? "import" : "reconcile" }, targetUrl: url });
  pool = new pg.Pool({ connectionString: url, max: 1, ...(cmd === "resolve" ? {} : { options: "-c default_transaction_read_only=on" }) });
  if (cmd === "list") console.log(JSON.stringify(await listQuarantine(pool, { unresolvedOnly: rest.includes("--unresolved"), batchId: opt("--batch") ?? null }), null, 1));
  else if (cmd === "summary") console.log(JSON.stringify(await unresolvedSummary(pool)));
  else console.log(JSON.stringify(await resolveQuarantine(pool, {
    quarantineId: Number(opt("--id")), resolution: opt("--resolution"), reason: opt("--reason"), resolvedBy: opt("--resolved-by"), newSnapshotFingerprint: opt("--new-snapshot") ?? null,
  })));
} catch (e) { console.error(`refused: ${e.message}`); process.exitCode = 1; } finally { await pool?.end(); }
