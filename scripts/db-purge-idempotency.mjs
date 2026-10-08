#!/usr/bin/env node
// Operator job: deletes EXPIRED idempotency keys (expires_at < now()) in bounded batches. The application role cannot delete them
// (migration 0015); this runs as the table owner via MIGRATION_DATABASE_URL, never via DATABASE_URL, and never on a schedule the
// application controls. Usage: MIGRATION_DATABASE_URL=postgres://... node scripts/db-purge-idempotency.mjs [--confirm-host=HOST] [--dry-run]
import pg from "pg";
import { assertSafeTarget } from "./lib/migrate.mjs";

const args = process.argv.slice(2);
const url = process.env.MIGRATION_DATABASE_URL;
const dry = args.includes("--dry-run");
const confirmHost = args.find((a) => a.startsWith("--confirm-host="))?.split("=")[1];
try {
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set");
  const host = assertSafeTarget(url, confirmHost);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (dry) {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE expires_at < now()");
      console.log(`[dry-run] ${rows[0].n} expired idempotency key(s) on ${host}`);
    } else {
      let total = 0;
      for (;;) {
        const r = await client.query("WITH d AS (SELECT id FROM idempotency_keys WHERE expires_at < now() ORDER BY expires_at LIMIT 5000 FOR UPDATE SKIP LOCKED) DELETE FROM idempotency_keys k USING d WHERE k.id = d.id");
        total += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) < 5000) break;
      }
      console.log(`purged ${total} expired idempotency key(s) on ${host}`);
    }
  } finally { await client.end(); }
} catch (e) {
  console.error(`purge failed: ${e.message}`);
  process.exit(1);
}
