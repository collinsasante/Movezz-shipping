#!/usr/bin/env node
// Operator job: deletes EXPIRED idempotency keys (expires_at < the start of the run) in bounded batches. The application role cannot delete
// them (migration 0015); this runs as the table owner via MIGRATION_DATABASE_URL, never via DATABASE_URL, and never on a schedule the
// application controls. The target goes through the same strict guard as migrations / bootstrap (scripts/lib/migrate.mjs assertStagingTarget:
// URL read as pg reads it, remote needs host + exact database + MOVEZZ_IMPORT_ENVIRONMENT=staging + sslmode=verify-full, no production names).
// A preflight result is never consulted: the guard is re-evaluated on every run.
// Usage: MIGRATION_DATABASE_URL=postgres://... node scripts/db-purge-idempotency.mjs [--dry-run] [--confirm-host=HOST --confirm-database=NAME]
import pg from "pg";
import { assertStagingTarget } from "./lib/migrate.mjs";
import { purgeExpired, parseArgs } from "./lib/purge-idempotency.mjs";

const redact = (m) => String(m).replace(/postgres(ql)?:\/\/\S+/g, "[url]");
let client;
try {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set (the owner connection; DATABASE_URL is never used)");
  const { host } = assertStagingTarget({ url, confirmHost: args.confirmHost, confirmDatabase: args.confirmDatabase });
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000, ...(args.dryRun ? { options: "-c default_transaction_read_only=on" } : {}) });
  await client.connect();
  await client.query("SET lock_timeout = '5s'");
  const r = await purgeExpired(client, { dryRun: args.dryRun });
  console.log(args.dryRun ? `[dry-run] ${r.expired} expired idempotency key(s) on ${host}` : `purged ${r.deleted} expired idempotency key(s) on ${host}`);
} catch (e) {
  console.error(`purge refused or failed: ${redact(e.message)}`);
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
