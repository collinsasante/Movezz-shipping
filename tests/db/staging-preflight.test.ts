// Staging preflight and the stricter remote-target guard. Pure checks use fake connections; one test runs against the disposable local database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { dbDescribe, createTestDb, type TestDb } from "./helpers";
import { runPreflight } from "../../scripts/lib/preflight.mjs";
import { assertStagingTarget, loadMigrations } from "../../scripts/lib/migrate.mjs";
import { snapshotFingerprint, parseSnapshotText } from "../../scripts/lib/import/index.mjs";

const stagingEnv = { NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "staging", MOVEZZ_IMPORT_ALLOWED_HOSTS: "stg-db.example.com", MOVEZZ_IMPORT_CONFIRM_DATABASE: "movezz_staging", MOVEZZ_IMPORT_ALLOW_EXPORT: "1" } as unknown as NodeJS.ProcessEnv;
const REMOTE = "postgres://owner@stg-db.example.com/movezz_staging?sslmode=require";
let names: string[] = []; const sums = new Map<string, string>();
beforeAll(async () => { const m = await loadMigrations(); names = m.map((x: { name: string }) => x.name); for (const x of m) sums.set(x.name, x.checksum); });
const fakeConnect = (state: { applied?: string[]; ssl?: boolean; tables?: number; app?: object | null; user?: string; keys?: number; badChecksum?: string }) => async () => ({
  async end() {},
  async query(sql: string) {
    const rows = (r: object[]) => ({ rows: r });
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
const base = { env: stagingEnv, ownerUrl: REMOTE, runtimeUrl: "postgres://movezz_app@stg-db.example.com/movezz_staging?sslmode=require", tools };

describe("remote target guard for write operations", () => {
  const env = { MOVEZZ_IMPORT_ENVIRONMENT: "staging" } as unknown as NodeJS.ProcessEnv;
  it("loopback passes unchanged", () => expect(assertStagingTarget({ url: "postgres://u@127.0.0.1/x", env: {} as NodeJS.ProcessEnv }).local).toBe(true));
  it("remote needs host + exact database + staging class + TLS and must not look like production", () => {
    const ok = { url: REMOTE, confirmHost: "stg-db.example.com", confirmDatabase: "movezz_staging", env };
    expect(assertStagingTarget(ok).local).toBe(false);
    for (const [name, over] of [["no host confirmation", { confirmHost: undefined }], ["wrong database", { confirmDatabase: "other" }], ["no database confirmation", { confirmDatabase: undefined }],
      ["no staging class", { env: {} as NodeJS.ProcessEnv }], ["class 'production'", { env: { MOVEZZ_IMPORT_ENVIRONMENT: "production" } as unknown as NodeJS.ProcessEnv }],
      ["no TLS", { url: "postgres://o@stg-db.example.com/movezz_staging" }], ["sslmode=disable", { url: "postgres://o@stg-db.example.com/movezz_staging?sslmode=disable" }],
      ["production-looking database", { url: "postgres://o@stg-db.example.com/movezz_prod?sslmode=require", confirmDatabase: "movezz_prod" }],
      ["production-looking host", { url: "postgres://o@prod-db.example.com/m?sslmode=require", confirmHost: "prod-db.example.com", confirmDatabase: "m" }]] as [string, object][])
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
    expect(by(await runPreflight({ ...base, ownerUrl: "postgres://o@stg-db.example.com/movezz_staging", connect: fakeConnect({}) }), "URL requests TLS")?.status).toBe("FAIL");
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
  it("refuses a production-looking target, a forbidden credential, or an Airtable variable in the shell", async () => {
    expect((await runPreflight({ ...base, ownerUrl: "postgres://o@stg-db.example.com/movezz_prod?sslmode=require", connect: fakeConnect({}) })).verdict).toBe("FAIL");
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
    const r = await runPreflight({ ...base, ownerUrl: "postgres://owner:SECRETPW@stg-db.example.com/movezz_staging?sslmode=require", connect: async () => { throw new Error("connect ECONNREFUSED postgres://owner:SECRETPW@stg-db.example.com/movezz_staging"); } });
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
