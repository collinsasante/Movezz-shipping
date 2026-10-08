// Purge of EXPIRED idempotency keys. The only statement that deletes is the one below: rows whose expires_at is strictly before a cutoff
// captured ONCE at the start of the run (so a long run can never reach rows that expire later), in bounded batches. It never truncates,
// never takes a caller-supplied cutoff, and never touches another table. The application role cannot do this (migration 0015 guard).
export const BATCH = 5000;
export const SQL_COUNT = "SELECT count(*)::int AS n FROM idempotency_keys WHERE expires_at < $1::timestamptz";
export const SQL_DELETE = "WITH d AS (SELECT id FROM idempotency_keys WHERE expires_at < $1::timestamptz ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED) DELETE FROM idempotency_keys k USING d WHERE k.id = d.id";

/** @param {{ query: Function }} client @param {{ dryRun?: boolean, batch?: number }} [o] */
export async function purgeExpired(client, { dryRun = false, batch = BATCH } = {}) {
  if (!Number.isInteger(batch) || batch < 1 || batch > BATCH) throw new Error(`batch must be 1..${BATCH}`);
  const cutoff = (await client.query("SELECT now() AS t")).rows[0].t;
  if (dryRun) return { dryRun: true, cutoff, expired: (await client.query(SQL_COUNT, [cutoff])).rows[0].n, deleted: 0 };
  let deleted = 0;
  for (;;) {
    const r = await client.query(SQL_DELETE, [cutoff, batch]);
    deleted += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < batch) break;
  }
  return { dryRun: false, cutoff, expired: deleted, deleted };
}

/** Strict argument parsing: only these flags exist; anything else (e.g. a cutoff override) is refused. */
export function parseArgs(argv) {
  const out = { dryRun: false, confirmHost: undefined, confirmDatabase: undefined };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--confirm-host=")) out.confirmHost = a.slice("--confirm-host=".length);
    else if (a.startsWith("--confirm-database=")) out.confirmDatabase = a.slice("--confirm-database=".length);
    else throw new Error(`unknown argument "${a.split("=")[0]}" (allowed: --dry-run, --confirm-host=HOST, --confirm-database=NAME)`);
  }
  return out;
}
