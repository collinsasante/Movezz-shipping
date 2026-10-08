// The first super_admin is created by an operator on the owner connection, never through the API or the runtime role.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { dbDescribe, createTestDb, sqlstate, type TestDb } from "./helpers";

const SCRIPT = path.resolve(__dirname, "../../scripts/db-bootstrap-admin.mjs");
dbDescribe("PostgreSQL admin bootstrap", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.close(); });
  const run = (args: string[], url = db.adminUrl) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", MIGRATION_DATABASE_URL: url } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });

  it("creates a super_admin only with a confirmed host and a valid identity; duplicates and bad input are refused", async () => {
    const host = new URL(db.adminUrl).hostname;
    expect(run(["--email", "boss@example.invalid", "--firebase-uid", "uid_boss_1", "--confirm-host", "wrong"]).status).toBe(1);
    expect(run(["--email", "nope", "--firebase-uid", "uid_boss_1", "--confirm-host", host]).status).toBe(1);
    expect(run(["--email", "boss@example.invalid", "--firebase-uid", "x", "--confirm-host", host]).status).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(0);
    const ok = run(["--email", "Boss@Example.invalid", "--firebase-uid", "uid_boss_1", "--confirm-host", host]);
    expect(ok.status).toBe(0);
    expect((await db.admin.query("SELECT role, email, is_active FROM users WHERE auth_uid = 'uid_boss_1'")).rows[0]).toEqual({ role: "super_admin", email: "boss@example.invalid", is_active: true });
    const a = (await db.admin.query("SELECT actor_type, action, entity_type, after_data FROM audit_logs WHERE action = 'user.bootstrap_admin'")).rows;
    expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ actor_type: "system", entity_type: "user", after_data: { role: "super_admin", email: "boss@example.invalid" } });   // the first administrator is audited
    const dup = run(["--email", "boss@example.invalid", "--firebase-uid", "uid_boss_1", "--confirm-host", host]);
    expect(dup.status).toBe(1); expect(dup.stderr).toMatch(/already has/);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'user.bootstrap_admin'")).rows[0].n).toBe(1);   // a refused retry leaves no second record
  });
  it("refuses an overriding or unverified-TLS remote URL before connecting", () => {
    for (const url of ["postgres://u@127.0.0.1/mvz_test?host=db.example.com", "postgres://u@db.example.com/mvz_test", "postgres://u@db.example.com/mvz_test?sslmode=require"]) {
      const r = spawnSync("node", ["scripts/db-bootstrap-admin.mjs", "--email", "boss@example.invalid", "--firebase-uid", "uid_boss_9", "--confirm-host", "db.example.com", "--confirm-database", "mvz_test"], { encoding: "utf8", env: { PATH: process.env.PATH, MIGRATION_DATABASE_URL: url, MOVEZZ_IMPORT_ENVIRONMENT: "staging" } as unknown as NodeJS.ProcessEnv, timeout: 15000 });
      expect(r.status, url).toBe(1); expect(r.stderr).toMatch(/refused|Refusing/i);
    }
  });
  it("the runtime role cannot create a super_admin", async () => {
    expect(await sqlstate(db.app.query("INSERT INTO users (auth_uid,email,role) VALUES ('uid_x','x@example.invalid','super_admin')"))).not.toBe("OK");
  });
});
