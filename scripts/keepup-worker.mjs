#!/usr/bin/env node
// Runs ONE pass of the Keepup sync worker (src/lib/db/workers/keepup-worker.ts) against a local or staging database. Operator tool for rehearsals
// and the controlled sandbox test; it is NOT a production scheduler (none exists: docs/CUTOVER-RUNBOOK.md G9/G10).
//
//   DATABASE_URL=<movezz_app url> ACTOR_CONTEXT_KEY=<integration/app key> MOVEZZ_KEEPUP_MODE=sandbox KEEPUP_API_KEY=... KEEPUP_BASE_URL=... \
//   node scripts/keepup-worker.mjs --once [--confirm-host H --confirm-database D] [--allow-mock] [--owner NAME]
//
// Safety: the database goes through the same strict target guard as every other operator tool (loopback, or staging with verified TLS and
// explicit confirmations; production-looking names refused). Mode `live` is REFUSED here on purpose (real invoices must never be produced from a
// rehearsal database); `disabled` refuses; `mock` needs --allow-mock. Only counts are printed: no URL, key, customer or invoice data.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { assertStagingTarget } from "./lib/migrate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/\S+/g, "[url]");
let pool; let tmp;
try {
  if (!args.includes("--once")) throw new Error("only --once is supported (this tool is not a scheduler)");
  const url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL is not set (the runtime role, movezz_app)");
  assertStagingTarget({ url, confirmHost: opt("--confirm-host"), confirmDatabase: opt("--confirm-database") });
  const { build } = await import("esbuild").catch(() => { throw new Error("esbuild is needed to run the TypeScript worker (it ships with the dev dependencies: run npm ci)"); });
  tmp = mkdtempSync(path.join(REPO, ".keepup-worker-"));
  const out = path.join(tmp, "worker.mjs");
  await build({ stdin: { contents: `export { runKeepupWorkerOnce } from "./src/lib/db/workers/keepup-worker.ts"; export { createKeepupGateway, describeKeepup } from "./src/lib/integrations/keepup-runtime.ts";`, resolveDir: REPO, sourcefile: "entry.ts", loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: out, external: ["pg"], logLevel: "silent", tsconfig: path.join(REPO, "tsconfig.json") });
  const w = await import(pathToFileURL(out).href);
  const env = (k) => process.env[k];
  const status = w.describeKeepup(env);
  if (status.mode === "live") throw new Error("live Keepup mode is refused by this tool: real invoices must not be created from a rehearsal run");
  if (status.mode === "disabled") throw new Error(`Keepup is disabled or misconfigured${status.problems.length ? `: ${status.problems.join("; ")}` : " (set MOVEZZ_KEEPUP_MODE=sandbox)"}`);
  if (status.mode === "mock" && !args.includes("--allow-mock")) throw new Error("mock mode needs --allow-mock (a mock never talks to Keepup)");
  const gateway = w.createKeepupGateway(env);
  if (gateway.kind === "http-production" || !gateway.kind) throw new Error(`refusing to run with a ${gateway.kind ?? "unidentified"} gateway (checked at execution time, independent of the arguments)`);
  pool = new pg.Pool({ connectionString: url, max: 2 }); pool.on("error", () => {});
  const result = await w.runKeepupWorkerOnce(pool, { gateway, owner: opt("--owner") ?? "keepup-cli-1", batch: 5, leaseSeconds: 120, callTimeoutMs: 20_000 });
  console.log(JSON.stringify({ mode: status.mode, gateway: gateway.kind ?? "unknown", result }));
} catch (e) { console.error(`keepup worker refused or failed: ${redact(e.message)}`); process.exitCode = 1; }
finally { await pool?.end().catch(() => {}); if (tmp) rmSync(tmp, { recursive: true, force: true }); }
