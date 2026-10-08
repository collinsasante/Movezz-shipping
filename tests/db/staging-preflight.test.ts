// Staging preflight and the stricter remote-target guard. Pure checks use fake connections; one test runs against the disposable local database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { dbDescribe, createTestDb, type TestDb } from "./helpers";
import { resolveTarget } from "../../scripts/lib/target.mjs";
import { evaluateEnvironment } from "../../scripts/lib/import/env-guard.mjs";
import { runPreflight } from "../../scripts/lib/preflight.mjs";
import { assertStagingTarget, assertSafeTarget, loadMigrations, migrate } from "../../scripts/lib/migrate.mjs";
import { snapshotFingerprint, parseSnapshotText } from "../../scripts/lib/import/index.mjs";

const stagingEnv = { NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "staging", MOVEZZ_IMPORT_ALLOWED_HOSTS: "stg-db.example.com", MOVEZZ_IMPORT_CONFIRM_DATABASE: "movezz_staging", MOVEZZ_IMPORT_ALLOW_EXPORT: "1" } as unknown as NodeJS.ProcessEnv;
const REMOTE = "postgres://owner@stg-db.example.com/movezz_staging?sslmode=verify-full";
let names: string[] = []; const sums = new Map<string, string>();
beforeAll(async () => { const m = await loadMigrations(); names = m.map((x: { name: string }) => x.name); for (const x of m) sums.set(x.name, x.checksum); });
const fakeConnect = (state: { applied?: string[]; ssl?: boolean; tables?: number; app?: object | null; user?: string; keys?: number; badChecksum?: string; runtime?: object }) => async () => ({
  async end() {},
  async query(sql: string) {
    const rows = (r: object[]) => ({ rows: r });
    if (/sec_create/.test(sql)) return rows([{ sec_create: false, db_create: false, owned: 0, memberships: 0, keys_read: false, mig_write: false, ...(state.runtime ?? {}) }]);
    if (/current_user AS u, current_database/.test(sql)) return rows([{ u: state.user ?? "movezz_owner", d: "movezz_staging", su: false }]);
    if (/pg_stat_ssl/.test(sql)) return rows([{ ssl: state.ssl ?? true }]);
    if (/FROM pg_roles WHERE rolname = 'movezz_app'/.test(sql)) return rows(state.app === null ? [] : [state.app ?? { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false }]);
    if (/to_regclass/.test(sql)) return rows([{ t: state.applied !== undefined }]);
    if (/information_schema\.tables/.test(sql)) return rows([{ n: state.tables ?? 0 }]);
    if (/FROM schema_migrations/.test(sql)) return rows((state.applied ?? []).map((name) => ({ name, checksum: state.badChecksum === name ? "0" : sums.get(name) })));
    if (/actor_keys/.test(sql)) return rows([{ n: state.keys ?? 1 }]);
    if (/current_user AS u/.test(sql)) return rows([{ u: "movezz_app" }]);
    if (/has_schema_privilege/.test(sql)) return rows([{ ok: false }]);
    throw new Error(`unexpected query ${sql}`);
  },
});
const by = (r: { checks: { id: string; status: string; detail?: string }[] }, frag: string) => r.checks.find((c) => c.id.includes(frag));
const tools = () => true;
const base = { env: stagingEnv, ownerUrl: REMOTE, runtimeUrl: "postgres://movezz_app@stg-db.example.com/movezz_staging?sslmode=verify-full", tools };

describe("remote target guard for write operations", () => {
  const env = { MOVEZZ_IMPORT_ENVIRONMENT: "staging" } as unknown as NodeJS.ProcessEnv;
  it("loopback passes unchanged", () => expect(assertStagingTarget({ url: "postgres://u@127.0.0.1/x", env: {} as NodeJS.ProcessEnv }).local).toBe(true));
  it("remote needs host + exact database + staging class + TLS and must not look like production", () => {
    const ok = { url: REMOTE, confirmHost: "stg-db.example.com", confirmDatabase: "movezz_staging", env };
    expect(assertStagingTarget(ok).local).toBe(false);
    for (const [name, over] of [["no host confirmation", { confirmHost: undefined }], ["wrong database", { confirmDatabase: "other" }], ["no database confirmation", { confirmDatabase: undefined }],
      ["no staging class", { env: {} as NodeJS.ProcessEnv }], ["class 'production'", { env: { MOVEZZ_IMPORT_ENVIRONMENT: "production" } as unknown as NodeJS.ProcessEnv }],
      ["no TLS", { url: "postgres://o@stg-db.example.com/movezz_staging" }], ["sslmode=disable", { url: "postgres://o@stg-db.example.com/movezz_staging?sslmode=disable" }],
      ["production-looking database", { url: "postgres://o@stg-db.example.com/movezz_prod?sslmode=verify-full", confirmDatabase: "movezz_prod" }],
      ["production-looking host", { url: "postgres://o@prod-db.example.com/m?sslmode=verify-full", confirmHost: "prod-db.example.com", confirmDatabase: "m" }]] as [string, object][])
      expect(() => assertStagingTarget({ ...ok, ...over }), name).toThrow(/Refusing remote target/);
  });
  it("db-migrate (including `grants`) refuses an unconfirmed remote target before connecting", () => {
    for (const cmd of ["up", "grants", "status"]) {
      const r = spawnSync("node", ["scripts/db-migrate.mjs", cmd, "--confirm-host=stg-db.example.com"], { encoding: "utf8", env: { PATH: process.env.PATH, MIGRATION_DATABASE_URL: REMOTE } as unknown as NodeJS.ProcessEnv, timeout: 15000 });
      expect(r.status, cmd).toBe(1); expect(r.stderr).toMatch(/Refusing remote target/); expect(r.stderr).not.toContain("owner@");
    }
  });
});

describe("staging preflight (read-only, honest about what it cannot verify)", () => {
  it("with nothing provided it is BLOCKED, never READY", async () => {
    const r = await runPreflight({ env: { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv, tools });
    expect(r.verdict).toBe("BLOCKED"); expect(by(r, "export snapshot")?.status).toBe("BLOCKED"); expect(by(r, "staging Cloudflare")?.status).toBe("NOT_RUN");
  });
  it("a fully prepared empty staging database passes the database checks, but the remaining inputs still block", async () => {
    const r = await runPreflight({ ...base, connect: fakeConnect({}) });
    for (const f of ["connection is actually encrypted", "owner role is not a superuser", "runtime role is unprivileged", "database is empty before the first migration", "owner and runtime roles are different", "runtime role cannot create objects"]) expect(by(r, f)?.status, f).toBe("PASS");
    expect(r.verdict).toBe("BLOCKED");
  });
  it("fails on: no TLS in the URL, unencrypted session, privileged runtime role, missing runtime role, non-empty unmigrated database, unknown or out-of-order migrations", async () => {
    expect(by(await runPreflight({ ...base, ownerUrl: "postgres://o@stg-db.example.com/movezz_staging", connect: fakeConnect({}) }), "remote URL requests VERIFIED TLS")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, connect: fakeConnect({ ssl: false }) }), "actually encrypted")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, connect: fakeConnect({ app: { rolsuper: false, rolcreaterole: true, rolcreatedb: false, rolbypassrls: false } }) }), "runtime role is unprivileged")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, connect: fakeConnect({ app: null }) }), "runtime role movezz_app exists")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, connect: fakeConnect({ tables: 3 }) }), "database is empty")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, connect: fakeConnect({ applied: [...names.slice(0, 2), "9999_unknown.sql"] }) }), "prefix")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, connect: fakeConnect({ applied: [names[1], names[0]] }) }), "prefix")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, connect: fakeConnect({ user: "movezz_app" }) }), "owner and runtime roles are different")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, connect: fakeConnect({ applied: names.slice(0, 3), badChecksum: names[1] }) }), "byte for byte")?.status).toBe("FAIL");
    const full = await runPreflight({ ...base, connect: fakeConnect({ applied: names, keys: 0 }) });
    expect(by(full, "actor signing key")?.status).toBe("BLOCKED"); expect(by(full, "prefix")?.status).toBe("PASS");
  });
  it("runtime role: fails on schema-management rights, owned tables, role memberships, signing-key read, and a different database", async () => {
    for (const bad of [{ sec_create: true }, { db_create: true }, { owned: 2 }, { memberships: 1 }, { keys_read: true }, { mig_write: true }]) {
      const r = await runPreflight({ ...base, connect: fakeConnect({ runtime: bad }) });
      expect(r.checks.filter((c) => /^runtime role/.test(c.id) && c.status === "FAIL"), JSON.stringify(bad)).toHaveLength(1);
    }
    expect(by(await runPreflight({ ...base, runtimeUrl: "postgres://movezz_app@other-db.example.com/movezz_staging?sslmode=verify-full", connect: fakeConnect({}) }), "same host and database")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...base, runtimeUrl: "postgres://movezz_app@stg-db.example.com/movezz_staging?sslmode=require", connect: fakeConnect({}) }), "runtime URL requests VERIFIED TLS")?.status).toBe("FAIL");
  });
  it("refuses a production-looking target, a forbidden credential, or an Airtable variable in the shell", async () => {
    expect((await runPreflight({ ...base, ownerUrl: "postgres://o@stg-db.example.com/movezz_prod?sslmode=verify-full", connect: fakeConnect({}) })).verdict).toBe("FAIL");
    expect((await runPreflight({ ...base, env: { ...stagingEnv, AIRTABLE_API_KEY: "x" } as unknown as NodeJS.ProcessEnv, connect: fakeConnect({}) })).verdict).toBe("FAIL");
    expect((await runPreflight({ ...base, env: { ...stagingEnv, KEEPUP_API_KEY: "x" } as unknown as NodeJS.ProcessEnv, connect: fakeConnect({}) })).verdict).toBe("FAIL");
    expect((await runPreflight({ ...base, env: { ...stagingEnv, MOVEZZ_IMPORT_CONFIRM_DATABASE: undefined } as unknown as NodeJS.ProcessEnv, connect: fakeConnect({}) })).verdict).toBe("FAIL");
  });
  it("export: a fingerprint is mandatory and must equal the exporter's value; paths cannot escape; exports stay out of the repository", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pf-")); const work = path.join(root, "work"); const repo = path.join(root, "repo"); mkdirSync(work); mkdirSync(repo);
    const text = readFileSync(path.join(__dirname, "..", "fixtures", "migration", "synthetic-clean.json"), "utf8");
    writeFileSync(path.join(work, "e.json"), text);
    const good = snapshotFingerprint(parseSnapshotText(text));
    const common = { ...base, connect: fakeConnect({}), cwd: work, repoRoot: repo };
    expect(by(await runPreflight({ ...common, snapshotPath: "e.json" }), "recorded fingerprint")?.status).toBe("BLOCKED");
    expect(by(await runPreflight({ ...common, snapshotPath: "e.json", expectFingerprint: "0".repeat(64) }), "fingerprint")?.status).toMatch(/FAIL/);
    expect(by(await runPreflight({ ...common, snapshotPath: "e.json", expectFingerprint: good }), "equals the exporter")?.status).toBe("PASS");
    expect(by(await runPreflight({ ...common, snapshotPath: "../outside.json" }), "inside the working directory")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...common, snapshotPath: "missing.json" }), "exists")?.status).toBe("FAIL");
    expect(by(await runPreflight({ ...common, cwd: repo, repoRoot: repo, snapshotPath: "x.json" }), "exists")?.status).toBe("FAIL");
  });
  it("backup destination must exist outside the repository", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pf-")); const repo = path.join(root, "repo"); mkdirSync(path.join(repo, "inside"), { recursive: true }); mkdirSync(path.join(root, "bk"));
    const mk = (dir: string) => runPreflight({ ...base, connect: fakeConnect({}), cwd: repo, repoRoot: repo, env: { ...stagingEnv, MOVEZZ_BACKUP_DIR: dir } as unknown as NodeJS.ProcessEnv });
    expect(by(await mk(path.join(root, "bk")), "backup destination is outside")?.status).toBe("PASS");
    expect(by(await mk("inside"), "backup destination is outside")?.status).toBe("FAIL");
    expect(by(await mk(path.join(root, "nope")), "backup destination is outside")?.status).toBe("FAIL");
  });
  it("never leaks the connection string in its report", async () => {
    const r = await runPreflight({ ...base, ownerUrl: "postgres://owner:SECRETPW@stg-db.example.com/movezz_staging?sslmode=verify-full", connect: async () => { throw new Error("connect ECONNREFUSED postgres://owner:SECRETPW@stg-db.example.com/movezz_staging"); } });
    expect(JSON.stringify(r)).not.toContain("SECRETPW");
  });
});

dbDescribe("staging preflight against the disposable local database", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.close(); });
  it("reads a real migrated database without writing to it", async () => {
    const before = (await db.admin.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n;
    const connect = async (url: string) => { const c = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on" }); await c.connect(); return c; };
    const r = await runPreflight({ env: { NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test" } as unknown as NodeJS.ProcessEnv, ownerUrl: db.adminUrl, runtimeUrl: db.appUrl, connect, tools });
    expect(by(r, "applied migrations are a prefix")?.status).toBe("PASS"); expect(by(r, "pending migrations")?.detail).toBe("none");
    expect(by(r, "runtime connection uses movezz_app")?.status).toBe("PASS"); expect(by(r, "runtime role cannot create objects")?.status).toBe("PASS");
    expect(by(r, "runtime role is unprivileged")?.status).toBe("PASS"); expect(r.checks.filter((c) => c.status === "FAIL").map((c) => c.id)).toEqual(["owner role is not a superuser"]);   // the disposable local owner is the postgres superuser: the check correctly flags it
    expect((await db.admin.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n).toBe(before);
  });
});

describe("target resolution: the guards judge what pg will really connect to", () => {
  const stg = { MOVEZZ_IMPORT_ENVIRONMENT: "staging", MOVEZZ_IMPORT_ALLOWED_HOSTS: "stg-db.example.com", MOVEZZ_IMPORT_CONFIRM_DATABASE: "movezz_staging" } as unknown as NodeJS.ProcessEnv;
  const confirm = { confirmHost: "stg-db.example.com", confirmDatabase: "movezz_staging", env: stg };
  const tls = "?sslmode=verify-full";
  it("refuses ambiguous or overriding URLs everywhere (migrate guard, safe-target guard, importer guard)", () => {
    const evil = [
      "postgres://u@127.0.0.1/movezz_dev?host=db.prod.example.com",           // pg connects to the ?host= value, not to the loopback in the URL
      "postgres://u@stg-db.example.com/movezz_staging?sslmode=verify-full&host=other.example.com",
      "postgres:///movezz_dev", "postgres://u@/movezz_dev", "postgres://u@h1,h2/movezz_dev", "postgres://u@127.0.0.1/movezz_dev?host=/var/run/postgresql",
      "postgres://u@127.0.0.1/movezz_dev?hostaddr=203.0.113.9", "postgres://u@127.0.0.1/movezz_dev?service=prod", "postgres://u@127.0.0.1/movezz_dev?options=-c%20role%3Dx",
      "postgres://u@stg-db.example.com/movezz_staging?sslmode=verify-full&uselibpqcompat=true", "postgres://u@127.0.0.1/", "mysql://u@127.0.0.1/db", "not a url", "",
    ];
    for (const url of evil) {
      expect(() => resolveTarget(url), url).toThrow();
      expect(() => assertStagingTarget({ url, ...confirm }), url).toThrow(/Refusing target/);
      expect(() => assertSafeTarget(url, "stg-db.example.com"), url).toThrow();
      expect(evaluateEnvironment({ env: { ...stg, NODE_ENV: "test" } as NodeJS.ProcessEnv, targetUrl: url, mode: "reconcile" }).ok, url).toBe(false);
    }
  });
  it("host variations: IPv6 loopback and case are normalised; non-loopback look-alikes are remote", () => {
    expect(resolveTarget("postgres://u@[::1]/movezz_dev")).toMatchObject({ host: "::1", local: true });
    expect(resolveTarget("postgres://u@LOCALHOST/movezz_dev").local).toBe(true);
    for (const h of ["127.0.0.2", "localhost.example.com", "0.0.0.0", "127.0.0.1.nip.io"]) expect(resolveTarget(`postgres://u@${h}/movezz_dev`).local, h).toBe(false);
    expect(resolveTarget("postgres://u@127.1/movezz_dev").local).toBe(false);   // only exact loopback spellings count as local (stricter than the OS resolver)
    expect(resolveTarget("postgres://u@stg-db.example.com/movezz_staging" + tls).tlsVerified).toBe(true);
  });
  it("TLS counts as verified only for sslmode=verify-full with certificate checking on", () => {
    const base = "postgres://u@stg-db.example.com/movezz_staging";
    for (const q of ["", "?sslmode=disable", "?sslmode=prefer", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=no-verify", "?ssl=true"]) expect(resolveTarget(base + q).tlsVerified, q).toBe(false);
    expect(resolveTarget(base + tls).tlsVerified).toBe(true);
    expect(resolveTarget(base + tls, { NODE_TLS_REJECT_UNAUTHORIZED: "0" } as unknown as NodeJS.ProcessEnv).tlsVerified).toBe(false);
    expect(() => assertStagingTarget({ url: base + "?sslmode=require", ...confirm })).toThrow(/verified TLS/);
    expect(() => assertStagingTarget({ url: base + tls, ...confirm, env: { ...stg, NODE_TLS_REJECT_UNAUTHORIZED: "0" } as unknown as NodeJS.ProcessEnv })).toThrow(/verified TLS/);
    expect(assertStagingTarget({ url: base + tls, ...confirm }).local).toBe(false);
    expect(evaluateEnvironment({ env: { ...stg, NODE_ENV: "test" } as NodeJS.ProcessEnv, targetUrl: base + "?sslmode=require", mode: "reconcile" }).checks.find((c: { name: string }) => /verified TLS/.test(c.name))?.ok).toBe(false);
    expect(evaluateEnvironment({ env: { ...stg, NODE_ENV: "test" } as NodeJS.ProcessEnv, targetUrl: base + tls, mode: "reconcile" }).ok).toBe(true);
  });
  it("a loopback tunnel to a production-named database is refused too; ordinary local names still work", () => {
    expect(() => assertStagingTarget({ url: "postgres://u@127.0.0.1/movezz_prod", env: {} as NodeJS.ProcessEnv })).toThrow(/looks like production/);
    expect(() => assertStagingTarget({ url: "postgres://u@127.0.0.1/movezz_production", env: {} as NodeJS.ProcessEnv })).toThrow(/looks like production/);
    for (const db of ["movezz_dev", "mvz_ui", "mvz_test_ab12", "mvz_rehearsal_ab12cd34_restored"]) expect(assertStagingTarget({ url: `postgres://u@127.0.0.1/${db}`, env: {} as NodeJS.ProcessEnv }).local).toBe(true);
  });
  it("a successful or failed preflight grants nothing: the write guards give the same answer with or without one", () => {
    const url = "postgres://u@stg-db.example.com/movezz_staging" + tls;
    expect(() => assertStagingTarget({ url, env: stg })).toThrow();                                  // no confirmations -> refused, whatever any preflight said
    expect(() => assertStagingTarget({ url, ...confirm, env: { ...stg, MOVEZZ_PREFLIGHT_OK: "1" } as unknown as NodeJS.ProcessEnv })).not.toThrow();   // only explicit confirmations matter
    expect(() => assertStagingTarget({ url, confirmHost: confirm.confirmHost, env: { ...stg, MOVEZZ_PREFLIGHT_OK: "1" } as unknown as NodeJS.ProcessEnv })).toThrow();   // an env flag cannot replace them
  });
});

dbDescribe("migration history integrity", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.close(); });
  const fresh = async () => { const d = await createTestDb(); return d; };
  it("an edited applied migration, a renamed one, a missing file and an out-of-order history are all refused; a clean history re-runs as a no-op", async () => {
    expect((await migrate(db.adminUrl)).applied).toEqual([]);                                         // deterministic: unchanged files, nothing to apply
    const d = await fresh();
    try {
      await d.admin.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 2");
      await expect(migrate(d.adminUrl)).rejects.toThrow(/modified after it was applied/);
      await d.admin.query("UPDATE schema_migrations SET checksum = (SELECT checksum FROM schema_migrations WHERE version = 1) WHERE version = 2");   // an attacker-style 'fix' to another valid checksum is still wrong
      await expect(migrate(d.adminUrl)).rejects.toThrow(/modified after it was applied/);
    } finally { await d.close(); }
    const r = await fresh();
    try {
      const sums = (await loadMigrations()).map((m: { version: number; checksum: string }) => m);
      await r.admin.query("UPDATE schema_migrations SET checksum = $2 WHERE version = $1", [2, sums.find((m: { version: number }) => m.version === 2)!.checksum]);
      await r.admin.query("UPDATE schema_migrations SET name = '0002_other.sql' WHERE version = 2");
      await expect(migrate(r.adminUrl)).rejects.toThrow(/applied as 0002_other.sql/);
      await r.admin.query("UPDATE schema_migrations SET name = (SELECT name FROM schema_migrations WHERE version = 2 LIMIT 0) WHERE false");
    } finally { await r.close(); }
    const o = await fresh();
    try {
      await o.admin.query("DELETE FROM schema_migrations WHERE version = 3");                             // a hole below the highest applied version
      await expect(migrate(o.adminUrl)).rejects.toThrow(/out of order/);
      const before = (await o.admin.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n;
      expect(before).toBe(names.length - 1);                                                              // and nothing was applied while refusing
    } finally { await o.close(); }
    const m = await fresh();
    try {
      await m.admin.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, '0999_ghost.sql', repeat('a', 64))");
      await expect(migrate(m.adminUrl)).rejects.toThrow(/missing from db\/migrations/);                     // history the repository does not know
    } finally { await m.close(); }
  });
  it("preflight reports the same defects without writing", async () => {
    const d = await fresh();
    try {
      await d.admin.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 4");
      const connect = async (url: string) => { const c = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on" }); await c.connect(); return c; };
      const r = await runPreflight({ env: { NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test" } as unknown as NodeJS.ProcessEnv, ownerUrl: d.adminUrl, connect, tools });
      expect(by(r, "byte for byte")?.status).toBe("FAIL");
      expect((await d.admin.query("SELECT checksum FROM schema_migrations WHERE version = 4")).rows[0].checksum).toBe("0".repeat(64));
    } finally { await d.close(); }
  });
});
