#!/usr/bin/env node
// Usage:  MIGRATION_DATABASE_URL=postgres://... node scripts/db-migrate.mjs [up|status|grants] [--confirm-host=HOST]
// Uses MIGRATION_DATABASE_URL only (never DATABASE_URL, which is the runtime role). The URL is never printed.
import pg from "pg";
import { migrate, status, assertSafeTarget } from "./lib/migrate.mjs";

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "up";
const confirmHost = args.find((a) => a.startsWith("--confirm-host="))?.split("=")[1];
const url = process.env.MIGRATION_DATABASE_URL;

try {
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set (use the migration role, not the runtime role).");
  const host = assertSafeTarget(url, confirmHost);
  if (command === "up") {
    const r = await migrate(url, { log: (m) => console.log(`[db] ${m}`) });
    console.log(`[db] host=${host} applied=${r.applied.length} total=${r.total}`);
  } else if (command === "status") {
    for (const s of await status(url)) console.log(`${s.applied ? "applied" : "PENDING"}  ${s.name}`);
  } else if (command === "grants") {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try { await c.query("SELECT apply_runtime_grants('movezz_app')"); console.log("[db] runtime grants applied"); } finally { await c.end(); }
  } else {
    throw new Error(`Unknown command "${command}" (up | status | grants)`);
  }
} catch (err) {
  console.error(`[db] ${err.message}`);
  process.exit(1);
}
