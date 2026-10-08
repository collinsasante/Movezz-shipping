// Staging rehearsal harness (Phase 7J): a repeatable, DISPOSABLE cycle against a LOCAL / explicitly allow-listed non-production PostgreSQL:
//   create database -> apply migrations -> import snapshot (CLI, in a child process) -> reconcile -> resume/duplicate -> backup -> restore -> verify -> drop
// It measures, it does not optimise. It refuses to run unless the environment guard approves the target, and it only ever creates and drops
// databases whose names start with "mvz_rehearsal_". Nothing here knows about any production system.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { assertApprovedEnvironment } from "./import/env-guard.mjs";
import { databaseSignature, parseSnapshotText } from "./import/index.mjs";
import { assertSafeTarget, migrate } from "./migrate.mjs";
import { buildRealisticSnapshot } from "../../tests/fixtures/migration/realistic.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "scripts/db-import.mjs");
export const REHEARSAL_PREFIX = "mvz_rehearsal_";
const ms = (t0) => Math.round(performance.now() - t0);

function run(cmd, args, { env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "", err = "", peak = 0;
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const sample = setInterval(async () => { try { const m = /VmHWM:\s+(\d+) kB/.exec(await readFile(`/proc/${p.pid}/status`, "utf8")); if (m) peak = Math.max(peak, Number(m[1])); } catch { /* process gone */ } }, 20);
    p.on("error", reject);
    p.on("close", (code) => { clearInterval(sample); resolve({ code, out, err, peakRssMb: Math.round(peak / 1024) }); });
  });
}
const withDb = (url, name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

/**
 * One full rehearsal cycle. Returns a metrics object (no secrets). `adminUrl` must point at a superuser connection on a non-production server.
 * @param {{ adminUrl: string, scale?: number, verified?: "none"|"partial", actorKeyB64?: string, environmentClass?: string, keep?: boolean, chunk?: number }} o
 */
export async function rehearse({ adminUrl, scale = 1, verified = "none", actorKeyB64, environmentClass = "local", keep = false }) {
  // the guard sees the operator's REAL environment (so a live credential in the shell refuses the rehearsal); the child processes get a clean one
  const env = { NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: environmentClass, MOVEZZ_IMPORT_ALLOWED_HOSTS: process.env.MOVEZZ_IMPORT_ALLOWED_HOSTS ?? "" };
  assertApprovedEnvironment({ env: { ...process.env, ...env }, targetUrl: adminUrl, mode: "import" }); assertSafeTarget(adminUrl);
  const key = actorKeyB64 ?? randomBytes(32).toString("base64");
  const name = `${REHEARSAL_PREFIX}${randomBytes(4).toString("hex")}`; const restored = `${name}_restored`;
  const m = { scale, verified, database: name, phases: {}, snapshot: {} };
  const root = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const dir = await mkdtemp(path.join(tmpdir(), "rehearsal-"));
  const phase = async (label, fn) => { const t0 = performance.now(); const r = await fn(); m.phases[label] = { ms: ms(t0), ...(r ?? {}) }; return r; };
  let target, back;
  try {
    // ---- 1. source: generate the snapshot file ----
    const gen = await phase("generate snapshot", async () => { const { snapshot, meta } = buildRealisticSnapshot({ scale, verified }); const file = path.join(dir, "snapshot.json"); const text = JSON.stringify(snapshot); await writeFile(file, text); return { file, bytes: text.length, counts: meta.counts, quirks: meta.quirks }; });
    m.snapshot = { bytes: gen.bytes, records: Object.values(gen.counts).reduce((a, b) => a + b, 0), counts: gen.counts };
    // ---- 2. fresh database + migrations ----
    await phase("create + migrate", async () => {
      await root.query(`CREATE DATABASE ${name}`);
      target = withDb(adminUrl, name);
      const r = await migrate(target);
      const c = new pg.Client({ connectionString: target }); await c.connect();
      try { await c.query("SELECT movezz_sec.set_actor_key($1)", [Buffer.from(key, "base64")]); } finally { await c.end(); }
      return { migrations: r.applied.length };
    });
    const cli = (mode, extra = [], over = {}) => run(process.execPath, [CLI, mode, "--snapshot", "snapshot.json", ...extra], { cwd: dir, env: { ...env, IMPORT_DATABASE_URL: target, ACTOR_CONTEXT_KEY: key, ...over } });
    const pool = new pg.Pool({ connectionString: target, max: 2 });
    const stats = async () => (await pool.query("SELECT xact_commit::bigint AS c, tup_inserted::bigint AS i, pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint AS wal FROM pg_stat_database WHERE datname = current_database()")).rows[0];
    // ---- 3. dry-run (read-only) ----
    const before = await pool.query("SELECT (SELECT count(*) FROM customers) AS c");
    await phase("dry-run", async () => { const r = await cli("dry-run"); return { exit: r.code, peakRssMb: r.peakRssMb, verdict: /\[(\w+)\]/.exec(r.out)?.[1] }; });
    m.dryRunWroteNothing = (await pool.query("SELECT (SELECT count(*) FROM customers) AS c, (SELECT count(*) FROM import_batches) AS b")).rows[0].b === "0" && before.rows[0].c === "0";
    // ---- 4. import ----
    const s0 = await stats();
    await phase("import", async () => { const r = await cli("import", ["--initiated-by", "rehearsal", "--metrics-json", "metrics.json", "--report-json", "report.json"]); const tx = JSON.parse(await readFile(path.join(dir, "metrics.json"), "utf8")).transactions;
      const rep = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8")); m.report = { verdict: rep.verdict, imported: rep.postgres.imported, failed: rep.postgres.failed, reconciliation: rep.postgres.reconciledChecks, quarantined: rep.source.totals.quarantined, deferred: rep.source.totals.deferred, duplicated: rep.source.totals.duplicated,
        unresolvedRelationships: rep.integrity.brokenRelationships, financialDiscrepancies: rep.financial?.discrepancies?.length ?? 0, byCategory: rep.quarantine.byCategory };
      return { exit: r.code, peakRssMb: r.peakRssMb, transactions: tx.count, maxTransactionMs: Math.round(tx.maxMs), meanTransactionMs: Math.round(tx.totalMs / Math.max(1, tx.count)) }; });
    const s1 = await stats();
    m.postgres = { commits: Number(s1.c - s0.c), tuplesInserted: Number(s1.i - s0.i), walMb: Math.round(Number(s1.wal - s0.wal) / 1048576 * 10) / 10, databaseMb: Math.round(Number((await pool.query("SELECT pg_database_size(current_database()) AS s")).rows[0].s) / 1048576 * 10) / 10 };
    m.phases.import.recordsPerSecond = Math.round(m.report.imported / (m.phases.import.ms / 1000));
    // ---- 5. reconcile (read-only) and duplicate import ----
    await phase("reconcile", async () => { const r = await cli("reconcile"); return { exit: r.code, peakRssMb: r.peakRssMb, reconciliation: /reconciliation (\d+\/\d+)/.exec(r.out)?.[1] }; });
    const sigA = await sig(pool);
    await phase("duplicate import", async () => { const r = await cli("import", ["--initiated-by", "rehearsal-2"]); return { exit: r.code, imported: /imported (\d+) /.exec(r.out)?.[1] }; });
    m.duplicateImportIdentical = (await sig(pool)) === sigA;
    // ---- 6. backup -> restore -> verify ----
    back = path.join(dir, "backup.dump");
    await phase("backup (pg_dump -Fc)", async () => { // the actor signing keys are secret material: they are NOT written to backups (they are re-provisioned per environment with movezz_sec.set_actor_key)
      const r = await run("pg_dump", ["-Fc", "--exclude-table-data=movezz_sec.actor_keys", "-f", back, target]); if (r.code !== 0) throw new Error(`pg_dump failed: ${r.err.slice(0, 300)}`);
      const text = await run("pg_restore", ["-f", "-", back]);                                  // plain-text view of the whole artifact
      m.backupContainsSigningKey = text.out.includes(Buffer.from(key, "base64").toString("hex")); m.backupContainsPasswordLikeText = /password\s*'[^']+'/i.test(text.out);
      return { bytes: (await readFile(back)).length }; });
    await phase("restore into a new database", async () => {
      await root.query(`CREATE DATABASE ${restored}`);
      const r = await run("pg_restore", ["--no-owner", "-d", withDb(adminUrl, restored), back]); if (r.code !== 0) throw new Error(`pg_restore failed: ${r.err.slice(0, 300)}`);
      const rp = new pg.Pool({ connectionString: withDb(adminUrl, restored), max: 2 });
      try {
        m.restore = { signatureEqual: (await sig(rp)) === sigA, migrations: Number((await rp.query("SELECT count(*) AS n FROM schema_migrations")).rows[0].n), actorKeysInRestoredDatabase: Number((await rp.query("SELECT count(*) AS n FROM movezz_sec.actor_keys")).rows[0].n) };
      } finally { await rp.end(); }
      const r2 = await run(process.execPath, [CLI, "reconcile", "--snapshot", "snapshot.json"], { cwd: dir, env: { ...env, IMPORT_DATABASE_URL: withDb(adminUrl, restored) } });
      m.restore.reconcileExit = r2.code; m.restore.reconciliation = /reconciliation (\d+\/\d+)/.exec(r2.out)?.[1];
    });
    await pool.end();
    return m;
  } finally {
    if (!keep) { for (const d of [name, restored]) { if (!d.startsWith(REHEARSAL_PREFIX)) continue; await root.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {}); } }
    await root.end(); await rm(dir, { recursive: true, force: true });
  }
}
async function sig(pool) { const c = await pool.connect(); try { return await databaseSignature(c); } finally { c.release(); } }
export { parseSnapshotText };
