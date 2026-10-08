// Forward-only SQL migration runner.
//  - migrations live in db/migrations/NNNN_name.sql and run in filename order
//  - every file runs in ONE transaction together with its schema_migrations row (all or nothing)
//  - applied files are checksummed: editing an applied migration is refused (write a new one instead)
//  - a session advisory lock prevents two runners from migrating the same database at once
//  - the runner never drops, truncates or resets anything
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, "../../db/migrations");
const LOCK_KEY = 7282001;
const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** @param {string} [dir] */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const out = [];
  for (const file of files) {
    const m = NAME_RE.exec(file);
    if (!m) throw new Error(`Migration file name must look like 0001_name.sql: ${file}`);
    const sql = await readFile(path.join(dir, file), "utf8");
    out.push({ version: Number(m[1]), name: file, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  const versions = out.map((o) => o.version);
  if (new Set(versions).size !== versions.length) throw new Error("Duplicate migration version numbers");
  versions.forEach((v, i) => {
    if (v !== i + 1) throw new Error(`Migration versions must be contiguous from 0001 (found ${v} at position ${i + 1})`);
  });
  return out;
}

/**
 * Applies pending migrations. `url` should be the MIGRATION credentials, never the runtime ones.
 * @param {string} url
 * @param {{ log?: (message: string) => void, dir?: string }} [options]
 */
export async function migrate(url, { log = () => {}, dir } = {}) {
  const migrations = await loadMigrations(dir);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
    const applied = new Map(rows.map((r) => [r.version, r]));
    for (const row of rows) {
      const local = migrations.find((m) => m.version === row.version);
      if (!local) throw new Error(`Database has migration ${row.name} which is missing from db/migrations`);
      if (local.checksum !== row.checksum) {
        throw new Error(`Migration ${row.name} was modified after it was applied. Never edit an applied migration; add a new one.`);
      }
    }
    const ran = [];
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      log(`applying ${m.name}`);
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${m.name} failed and was rolled back: ${err.message}`);
      }
      ran.push(m.name);
    }
    return { applied: ran, total: migrations.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

/**
 * @param {string} url
 * @param {{ dir?: string }} [options]
 */
export async function status(url, { dir } = {}) {
  const migrations = await loadMigrations(dir);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS t");
    const rows = exists.rows[0].t ? (await client.query("SELECT version FROM schema_migrations")).rows : [];
    const done = new Set(rows.map((r) => r.version));
    return migrations.map((m) => ({ name: m.name, applied: done.has(m.version) }));
  } finally {
    await client.end();
  }
}

/** Refuses non-local databases unless the operator names the host explicitly. */
/**
 * @param {string} url
 * @param {string} [confirmHost]
 */
export function assertSafeTarget(url, confirmHost) {
  const host = new URL(url).hostname;
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!local && confirmHost !== host) {
    throw new Error(`Refusing to migrate remote host "${host}". Re-run with --confirm-host=${host} once you have checked the target.`);
  }
  return host;
}
