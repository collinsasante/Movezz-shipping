#!/usr/bin/env node
// Re-host Airtable-hosted item photos to Cloudinary (staging/local only; see scripts/lib/rehost/rehost.mjs).
//   plan    read-only: what would be uploaded            IMPORT_DATABASE_URL=... MOVEZZ_IMPORT_ENVIRONMENT=staging ... node scripts/db-rehost-photos.mjs plan
//   run     uploads (needs MOVEZZ_REHOST_CLOUDINARY_URL + MOVEZZ_REHOST_CONFIRM_CLOUD)   [--limit N] [--max-attempts N]
//   report  read-only status; exit code 3 while Airtable-hosted photos remain      [--out reports/rehost.json]
// Never run against production data or a production cloud; the production run is a separate, explicitly approved cutover step.
import pg from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertRehostEnvironment, cloudinaryUploader, rehostPhotos, rehostReport } from "./lib/rehost/rehost.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
let pool;
try {
  if (!["plan", "run", "report"].includes(cmd)) throw new Error("usage: db-rehost-photos.mjs <plan|run|report> [--limit N] [--max-attempts N] [--out FILE]");
  const url = process.env.IMPORT_DATABASE_URL;
  const g = assertRehostEnvironment({ env: process.env, targetUrl: url, mode: cmd });
  pool = new pg.Pool({ connectionString: url, max: 2, ...(cmd === "run" ? {} : { options: "-c default_transaction_read_only=on" }) });
  const limit = Number(opt("--limit") ?? 100); const maxAttempts = Number(opt("--max-attempts") ?? 3);
  let result;
  if (cmd === "report") result = await rehostReport(pool, { maxAttempts });
  else result = await rehostPhotos({ pool, folder: g.folder, limit, maxAttempts, dryRun: cmd === "plan", uploader: cmd === "run" ? await cloudinaryUploader(process.env.MOVEZZ_REHOST_CLOUDINARY_URL) : { cloudName: "", upload: async () => { throw new Error("plan never uploads"); } } });
  const text = JSON.stringify(result, null, 1);
  const out = opt("--out");
  if (out) { const p = path.resolve(process.cwd(), out); if (!p.startsWith(process.cwd() + path.sep)) throw new Error("--out must be inside the working directory"); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text, { mode: 0o600 }); console.log(`report written to ${out}`); }
  else console.log(text);
  if (cmd === "report" && result.remainingAirtable > 0) process.exitCode = 3;
} catch (e) { console.error(`refused: ${e.message}`); process.exitCode = 1; } finally { await pool?.end(); }
