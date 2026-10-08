// Encrypted backup / verify / restore-to-new-database (scripts/lib/backup.mjs) against the disposable local database. Uses a throw-away age key pair.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { dbDescribe, createTestDb, customer, type TestDb } from "./helpers";
import { backup, verifyBackup, restoreToNewDatabase, toolsPresent, BackupRefusal } from "../../scripts/lib/backup.mjs";

const have = toolsPresent();
(have ? dbDescribe : describe.skip)("encrypted backup and restore", () => {
  let db: TestDb; let dir: string; let identity: string; let recipient: string; let repo: string;
  const dbName = () => new URL(db.adminUrl).pathname.slice(1);
  const common = () => ({ url: db.adminUrl, confirmHost: "127.0.0.1", confirmDatabase: dbName(), dir, recipient, env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, repoRoot: repo });
  beforeAll(async () => {
    db = await createTestDb(); await customer(db.admin, { name: "Confidential Name Zed" });
    await db.admin.query("SELECT movezz_sec.set_actor_key(decode(repeat('ab', 32), 'hex'))").catch(() => {});
    const root = mkdtempSync(path.join(tmpdir(), "bk-")); dir = path.join(root, "backups"); repo = path.join(root, "repo"); mkdirSync(dir); mkdirSync(repo);
    identity = path.join(root, "id.txt");
    const k = spawnSync("age-keygen", ["-o", identity], { encoding: "utf8" }); recipient = /(age1[0-9a-z]+)/.exec(k.stderr + k.stdout)![1];
  });
  afterAll(async () => { await db?.close(); });

  it("backs up encrypted (no plaintext, 0600, never overwrites), verifies, excludes signing keys, and restores only into a new database", async () => {
    const keys = (await db.admin.query("SELECT count(*)::int AS n FROM movezz_sec.actor_keys")).rows[0].n;
    const r = await backup(common());
    expect(statSync(r.file).mode & 0o777).toBe(0o600); expect(statSync(r.manifest).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith(".partial"))).toEqual([]);
    const raw = readFileSync(r.file); expect(raw.includes("Confidential Name Zed")).toBe(false); expect(raw.includes("PGDMP")).toBe(false);   // ciphertext only
    expect(JSON.stringify(JSON.parse(readFileSync(r.manifest, "utf8")))).not.toMatch(/password|postgres:\/\//i);
    expect(await verifyBackup({ file: r.file, identity, manifest: r.manifest })).toMatchObject({ checksum: true, decrypts: true, hasMigrations: true, signingKeyDataAbsent: true, verdict: "PASS" });
    // restore into a NEW database, compare, then drop it
    const name = `mvz_restore_${Date.now().toString(36)}`;
    const out = await restoreToNewDatabase({ url: db.adminUrl, confirmHost: "127.0.0.1", confirmDatabase: dbName(), newDatabase: name, file: r.file, identity, env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, pg });
    expect(out.database).toBe(name);
    const u = new URL(db.adminUrl); u.pathname = `/${name}`; const rc = new pg.Client({ connectionString: u.toString() }); await rc.connect();
    try {
      expect((await rc.query("SELECT count(*)::int AS n FROM customers WHERE name = 'Confidential Name Zed'")).rows[0].n).toBe(1);
      expect((await rc.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe((await db.admin.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n);
      expect((await rc.query("SELECT count(*)::int AS n FROM movezz_sec.actor_keys")).rows[0].n).toBe(0);   // the signing key never travels in a backup
      expect(keys).toBeGreaterThan(0);   // the source really had a signing key, so the zero above is meaningful
    } finally { await rc.end(); await db.admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
    // second run never overwrites the first
    const r2 = await backup(common()); expect(r2.file).not.toBe(r.file);
    expect(readdirSync(dir).filter((f) => f.endsWith(".dump.age"))).toHaveLength(2);
  });

  it("verify FAILS for the wrong identity, tampered ciphertext and a wrong checksum", async () => {
    const r = await backup(common());
    const other = path.join(path.dirname(identity), "other.txt"); spawnSync("age-keygen", ["-o", other]);
    expect((await verifyBackup({ file: r.file, identity: other })).verdict).toBe("FAIL");
    const bad = path.join(dir, "tampered.dump.age"); const buf = Buffer.from(readFileSync(r.file)); buf[buf.length - 20] ^= 0xff; writeFileSync(bad, buf);
    expect((await verifyBackup({ file: bad, identity })).verdict).toBe("FAIL");
    const man = path.join(dir, "m.json"); writeFileSync(man, JSON.stringify({ sha256: "0".repeat(64) }));
    expect((await verifyBackup({ file: r.file, identity, manifest: man })).verdict).toBe("FAIL");
  });

  it("refuses: repository destination, missing directory, bad recipient, unconfirmed/remote-unverified targets; restore never overwrites or uses a wrong name", async () => {
    await expect(backup({ ...common(), dir: path.join(repo, "x") })).rejects.toThrow(BackupRefusal);
    mkdirSync(path.join(repo, "inside")); await expect(backup({ ...common(), dir: path.join(repo, "inside") })).rejects.toThrow(/outside the repository/);
    await expect(backup({ ...common(), dir: path.join(dir, "missing") })).rejects.toThrow(/does not exist/);
    await expect(backup({ ...common(), recipient: "not-a-key" })).rejects.toThrow(/age public key/);
    await expect(backup({ ...common(), recipient: undefined as unknown as string })).rejects.toThrow(/age public key/);
    const remote = "postgres://owner:SECRETPW@stg-db.example.com/movezz_staging";
    await expect(backup({ ...common(), url: remote, confirmHost: "stg-db.example.com", confirmDatabase: "movezz_staging" })).rejects.toThrow(/Refusing remote target/);
    await expect(backup({ ...common(), url: remote + "?sslmode=verify-full" })).rejects.toThrow(/Refusing remote target/);
    await expect(backup({ ...common(), url: "postgres://u@127.0.0.1/movezz_prod" })).rejects.toThrow(/looks like production/);
    await expect(backup({ ...common(), url: "postgres://u@127.0.0.1/mvz?host=prod.example.com" })).rejects.toThrow(/Refusing target/);
    const f = readdirSync(dir).find((x) => x.endsWith(".dump.age"))!;
    const base = { url: db.adminUrl, confirmHost: "127.0.0.1", confirmDatabase: dbName(), file: path.join(dir, f), identity, env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, pg };
    await expect(restoreToNewDatabase({ ...base, newDatabase: dbName() })).rejects.toThrow(/must match mvz_restore_/);
    await expect(restoreToNewDatabase({ ...base, newDatabase: "postgres" })).rejects.toThrow(/must match/);
    await expect(restoreToNewDatabase({ ...base, newDatabase: "mvz_restore_x; drop database y" })).rejects.toThrow(/must match/);
    const exists = `mvz_restore_exists_${Date.now().toString(36)}`; await db.admin.query(`CREATE DATABASE ${exists}`);
    try { await expect(restoreToNewDatabase({ ...base, newDatabase: exists })).rejects.toThrow(/already exists/); } finally { await db.admin.query(`DROP DATABASE ${exists}`); }
    for (const e of [remote]) { try { await backup({ ...common(), url: e }); } catch (x) { expect(String((x as Error).message)).not.toContain("SECRETPW"); } }
  });
});
