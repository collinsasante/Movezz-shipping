// db-purge-idempotency: strict target guard, strict arguments, and a delete that can only remove expired keys.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { dbDescribe, createTestDb, type TestDb } from "./helpers";
import { purgeExpired, parseArgs, SQL_DELETE } from "../../scripts/lib/purge-idempotency.mjs";
import { runPreflight } from "../../scripts/lib/preflight.mjs";

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "db-purge-idempotency.mjs");
const run = (env: Record<string, string | undefined>, args: string[] = []) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv });
const STG = { MOVEZZ_IMPORT_ENVIRONMENT: "staging" };
const TLS = "?sslmode=verify-full";

describe("db-purge-idempotency refuses unsafe targets before connecting", () => {
  const confirm = ["--confirm-host=stg-db.example.invalid", "--confirm-database=movezz_staging"];
  const cases: [string, string, Record<string, string>, string[]][] = [
    ["a ?host= override of a loopback URL", "postgres://u:SECRETPW@127.0.0.1/movezz_dev?host=stg-db.example.invalid", {}, []],
    ["an empty host", "postgres:///movezz_dev", {}, []],
    ["a host list", "postgres://u@h1.invalid,h2.invalid/movezz_dev", {}, []],
    ["a unix socket path", "postgres://u@127.0.0.1/movezz_dev?host=/var/run/postgresql", {}, []],
    ["hostaddr", "postgres://u@127.0.0.1/movezz_dev?hostaddr=203.0.113.9", {}, []],
    ["connection options", "postgres://u@127.0.0.1/movezz_dev?options=-c%20role%3Dx", {}, []],
    ["libpq-compat TLS", `postgres://u@stg-db.example.invalid/movezz_staging${TLS}&uselibpqcompat=true`, STG, confirm],
    ["a production-named loopback tunnel", "postgres://u@127.0.0.1/movezz_prod", {}, []],
    ["a production-named remote database", `postgres://u@stg-db.example.invalid/movezz_prod${TLS}`, STG, ["--confirm-host=stg-db.example.invalid", "--confirm-database=movezz_prod"]],
    ["a production-named remote host", `postgres://u@prod-db.example.invalid/movezz_staging${TLS}`, STG, ["--confirm-host=prod-db.example.invalid", "--confirm-database=movezz_staging"]],
    ["a remote URL without TLS", "postgres://u:SECRETPW@stg-db.example.invalid/movezz_staging", STG, confirm],
    ["a remote URL with sslmode=require only", "postgres://u@stg-db.example.invalid/movezz_staging?sslmode=require", STG, confirm],
    ["verify-full with certificate checks switched off", `postgres://u@stg-db.example.invalid/movezz_staging${TLS}`, { ...STG, NODE_TLS_REJECT_UNAUTHORIZED: "0" }, confirm],
    ["a remote URL without the staging class", `postgres://u@stg-db.example.invalid/movezz_staging${TLS}`, {}, confirm],
    ["a remote URL with class production", `postgres://u@stg-db.example.invalid/movezz_staging${TLS}`, { MOVEZZ_IMPORT_ENVIRONMENT: "production" }, confirm],
    ["a remote URL without --confirm-host", `postgres://u@stg-db.example.invalid/movezz_staging${TLS}`, STG, ["--confirm-database=movezz_staging"]],
    ["a remote URL without --confirm-database", `postgres://u@stg-db.example.invalid/movezz_staging${TLS}`, STG, ["--confirm-host=stg-db.example.invalid"]],
    ["a wrong --confirm-database", `postgres://u@stg-db.example.invalid/movezz_staging${TLS}`, STG, ["--confirm-host=stg-db.example.invalid", "--confirm-database=other"]],
  ];
  for (const [name, url, env, args] of cases)
    it(`refuses ${name}`, () => {
      const r = run({ MIGRATION_DATABASE_URL: url, ...env }, args);
      expect(r.status).toBe(1); expect(r.stderr).toMatch(/purge refused or failed: .*(Refusing|refus)/i);
      expect(r.stderr + r.stdout).not.toMatch(/SECRETPW|ENOTFOUND|ECONNREFUSED|purged|dry-run\]/);   // refused before any connection attempt, and no secret echoed
    });
  it("ignores DATABASE_URL and PG* environment variables (only MIGRATION_DATABASE_URL counts)", () => {
    const r = run({ DATABASE_URL: "postgres://u@127.0.0.1/movezz_dev", PGHOST: "127.0.0.1", PGDATABASE: "movezz_dev" });
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/MIGRATION_DATABASE_URL is not set/);
    const r2 = run({ MIGRATION_DATABASE_URL: "postgres://u@stg-db.example.invalid/movezz_staging", PGSSLMODE: "verify-full", PGHOST: "127.0.0.1", ...STG }, ["--confirm-host=stg-db.example.invalid", "--confirm-database=movezz_staging"]);
    expect(r2.status).toBe(1); expect(r2.stderr).toMatch(/verified TLS/);                     // PGSSLMODE in the environment cannot stand in for sslmode in the URL
  });
  it("accepts only its three flags; a cutoff or table override is refused", () => {
    for (const a of ["--before=2099-01-01", "--all", "--truncate", "--table=invoices", "--force", "--cutoff=now", "extra"]) {
      const r = run({ MIGRATION_DATABASE_URL: "postgres://u@127.0.0.1/movezz_dev" }, [a]); expect(r.status, a).toBe(1); expect(r.stderr).toMatch(/unknown argument/);
    }
    expect(() => parseArgs(["--dry-run", "--confirm-host=h", "--confirm-database=d"])).not.toThrow();
  });
  it("a passing preflight grants nothing: the same command is refused with or without one", async () => {
    const url = `postgres://u@stg-db.example.invalid/movezz_staging${TLS}`;
    const pf = await runPreflight({ env: { NODE_ENV: "test", ...STG, MOVEZZ_IMPORT_ALLOWED_HOSTS: "stg-db.example.invalid", MOVEZZ_IMPORT_CONFIRM_DATABASE: "movezz_staging" } as unknown as NodeJS.ProcessEnv, ownerUrl: url, tools: () => true });
    expect(pf.checks.find((c) => /unambiguous/.test(c.id))?.status).toBe("PASS");
    const r = run({ MIGRATION_DATABASE_URL: url, ...STG, MOVEZZ_PREFLIGHT_OK: "1", MOVEZZ_IMPORT_CONFIRM_DATABASE: "movezz_staging", MOVEZZ_IMPORT_ALLOWED_HOSTS: "stg-db.example.invalid" });
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/--confirm-host/);                     // flags, not preflight/env, authorise
  });
});

dbDescribe("what the purge can and cannot delete (disposable local database)", () => {
  let db: TestDb; let url: string;
  // fixture rows are inserted as the superuser with triggers bypassed (the application path needs a signed actor; this test is about the purge)
  const addKey = async (key: string, status: string, expires: string) => {
    const c = await db.admin.connect();
    try { await c.query("SET session_replication_role = replica");
      return (await c.query(`INSERT INTO idempotency_keys (scope, key, status, expires_at) VALUES ('test.scope', $1, $2, ${expires}) RETURNING id`, [key, status])).rows[0].id as string;
    } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const keys = async () => (await db.admin.query("SELECT key FROM idempotency_keys ORDER BY key")).rows.map((r) => r.key as string);
  beforeAll(async () => { db = await createTestDb(); url = db.adminUrl; });
  afterAll(async () => { await db?.close(); });

  it("deletes only keys that expired before the run started; boundary, in-progress, completed and future keys are kept; other tables are untouched", async () => {
    await db.admin.query("INSERT INTO customers (name, phone, email, shipping_mark) VALUES ('Keep Me', '0244000001', 'k@example.invalid', 'MOVEZZ-KEEP01')");
    await addKey("expired-completed-1", "completed", "now() - interval '1 second'");
    await addKey("expired-failed-2", "failed", "now() - interval '40 days'");
    await addKey("expired-inprogress-3", "in_progress", "now() - interval '2 days'");
    await addKey("active-completed-4", "completed", "now() + interval '1 second'");
    await addKey("active-inprogress-5", "in_progress", "now() + interval '29 days'");
    await addKey("active-completed-6", "completed", "now() + interval '30 days'");
    const counts = async () => Object.fromEntries(await Promise.all(["customers", "audit_logs", "invoices", "items", "users"].map(async (t) => [t, (await db.admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n])));
    const before = await counts();
    const dry = await purgeExpired(db.admin as never, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, expired: 3, deleted: 0 }); expect(await keys()).toHaveLength(6);                // a dry run deletes nothing
    const r = await purgeExpired(db.admin as never);
    expect(r).toMatchObject({ deleted: 3 });
    expect(await keys()).toEqual(["active-completed-4", "active-completed-6", "active-inprogress-5"]);
    expect(await counts()).toEqual(before);                                                                                    // nothing else changed
    expect(await purgeExpired(db.admin as never)).toMatchObject({ deleted: 0 });                                               // idempotent
  });
  it("a key expiring exactly AT the cutoff is not deleted (strict <), and rows that expire after the run started are out of reach", async () => {
    await db.admin.query("DELETE FROM idempotency_keys");
    const edge = await addKey("edge-key-0001", "completed", "now() + interval '3 seconds'");
    const cutoff = (await db.admin.query("SELECT expires_at AS t FROM idempotency_keys WHERE id = $1", [edge])).rows[0].t;
    const r = await db.admin.query(SQL_DELETE.replace("LIMIT $2", "LIMIT 10"), [cutoff]);
    expect(r.rowCount).toBe(0);                                                                                                // expires_at = cutoff -> kept
    const r2 = await db.admin.query(SQL_DELETE.replace("LIMIT $2", "LIMIT 10"), [new Date(cutoff.getTime() + 1)]);
    expect(r2.rowCount).toBe(1);                                                                                               // cutoff one ms later -> expired
  });
  it("batches: a small batch size still removes every expired key and nothing else", async () => {
    await db.admin.query("DELETE FROM idempotency_keys");
    for (let i = 0; i < 11; i++) await addKey(`old-key-${String(i).padStart(4, "0")}`, "completed", "now() - interval '1 day'");
    await addKey("new-key-0001", "completed", "now() + interval '5 days'");
    expect(await purgeExpired(db.admin as never, { batch: 3 })).toMatchObject({ deleted: 11 });
    expect(await keys()).toEqual(["new-key-0001"]);
    await expect(purgeExpired(db.admin as never, { batch: 0 })).rejects.toThrow(/batch must be/);
    await expect(purgeExpired(db.admin as never, { batch: 5001 })).rejects.toThrow(/batch must be/);
  });
  it("the application role still cannot delete keys, and a read-only session cannot purge", async () => {
    const id = await addKey("app-cannot-del-1", "completed", "now() - interval '1 day'");
    await expect(db.app.query("DELETE FROM idempotency_keys WHERE id = $1", [id])).rejects.toThrow();
    const pg = (await import("pg")).default; const c = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on" }); await c.connect();
    try { await expect(purgeExpired(c as never)).rejects.toThrow(/read-only/); } finally { await c.end(); }
    expect((await keys()).includes("app-cannot-del-1")).toBe(true);
  });
  it("end to end on loopback: no confirmation flags needed; --dry-run reports; a real run purges", async () => {
    await db.admin.query("DELETE FROM idempotency_keys");
    await addKey("cli-expired-001", "completed", "now() - interval '1 day'"); await addKey("cli-active-0001", "completed", "now() + interval '1 day'");
    const dry = run({ MIGRATION_DATABASE_URL: url }, ["--dry-run"]); expect(dry.status).toBe(0); expect(dry.stdout).toMatch(/\[dry-run\] 1 expired/);
    expect(await keys()).toHaveLength(2);
    const real = run({ MIGRATION_DATABASE_URL: url }); expect(real.status).toBe(0); expect(real.stdout).toMatch(/purged 1 expired/);
    expect(await keys()).toEqual(["cli-active-0001"]);
  });
});
