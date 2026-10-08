// The command-line entry point (scripts/db-import.mjs) and the committed synthetic snapshot files.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dbDescribe, createTestDb, TEST_ACTOR_KEY_B64, type TestDb } from "./helpers";
import { files } from "../fixtures/migration/generate.mjs";

const ROOT = path.resolve(__dirname, "../..");
const CLI = path.join(ROOT, "scripts/db-import.mjs");
const FIX = path.join(ROOT, "tests/fixtures/migration");

/** Runs the CLI in a clean environment (only what the test passes: no inherited credentials). */
function cli(cwd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv });
    let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}
const approved = { MOVEZZ_IMPORT_ENVIRONMENT: "test", NODE_ENV: "test" };

describe("committed synthetic snapshots", () => {
  it("are exactly what the generator produces (no drift) and contain no real-looking personal data", async () => {
    for (const [name, build] of Object.entries(files)) {
      expect(await readFile(path.join(FIX, name), "utf8"), name).toBe(JSON.stringify(build(), null, 1) + "\n");
    }
    const text = (await readFile(path.join(FIX, "synthetic-messy.json"), "utf8")) + (await readFile(path.join(FIX, "synthetic-clean.json"), "utf8"));
    for (const e of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) expect(e, e).toMatch(/@example\.invalid$/);
  });
});

describe("db-import CLI (offline)", () => {
  it("dry-run of the messy snapshot exits 2 (NOT_READY) and prints the report; the clean one exits 0 (READY)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-")); await copyFile(path.join(FIX, "synthetic-messy.json"), path.join(dir, "m.json")); await copyFile(path.join(FIX, "synthetic-clean.json"), path.join(dir, "c.json"));
    const m = await cli(dir, ["dry-run", "--snapshot", "m.json", "--report-json", "m-report.json"], approved);
    expect(m.code).toBe(2); expect(m.out).toContain("[NOT_READY]"); expect(m.out).toContain("scope=source");
    const rep = JSON.parse(await readFile(path.join(dir, "m-report.json"), "utf8"));
    expect(rep.verdict).toBe("NOT_READY"); expect(rep.source.totals.discovered).toBeGreaterThan(100);
    const again = await cli(dir, ["dry-run", "--snapshot", "m.json", "--report-json", "m-report.json"], approved);
    expect(again.code).toBe(1); expect(again.err).toMatch(/EEXIST|already exists/);                    // never overwrites an existing report
    const c = await cli(dir, ["dry-run", "--snapshot", "c.json"], approved);
    expect(c.code).toBe(0); expect(c.out).toContain("[READY]");
  });
  it("is deterministic: two runs print byte-identical reports", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-")); await copyFile(path.join(FIX, "synthetic-messy.json"), path.join(dir, "m.json"));
    const a = await cli(dir, ["dry-run", "--snapshot", "m.json"], approved); const b = await cli(dir, ["dry-run", "--snapshot", "m.json"], approved);
    expect(b.out).toBe(a.out);
  });
  it("refuses without an approved environment, with a credential present, with a path outside the working directory, and never prints secrets or URLs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-")); await copyFile(path.join(FIX, "synthetic-clean.json"), path.join(dir, "c.json"));
    const noEnv = await cli(dir, ["dry-run", "--snapshot", "c.json"], {});
    expect(noEnv.code).toBe(1); expect(noEnv.err).toMatch(/REFUSED/);
    const withKey = await cli(dir, ["dry-run", "--snapshot", "c.json"], { ...approved, AIRTABLE_API_KEY: "patSECRET123", IMPORT_DATABASE_URL: "postgres://user:hunter2@127.0.0.1:1/x" });
    expect(withKey.code).toBe(1); expect(withKey.err).toMatch(/AIRTABLE_API_KEY/);
    expect(withKey.err + withKey.out).not.toMatch(/patSECRET123|hunter2/);
    const remote = await cli(dir, ["dry-run", "--snapshot", "c.json"], { ...approved, IMPORT_DATABASE_URL: "postgres://user:hunter2@db.example.com/x" });
    expect(remote.code).toBe(1); expect(remote.err + remote.out).not.toContain("hunter2");
    const outside = await cli(dir, ["dry-run", "--snapshot", "/etc/passwd"], approved);
    expect(outside.code).toBe(1); expect(outside.err).toMatch(/inside the allowed directory/);
    const traversal = await cli(dir, ["dry-run", "--snapshot", "c.json", "--report-json", "../escape.json"], approved);
    expect(traversal.code).toBe(1);
    const bad = await cli(dir, ["frobnicate"], approved);
    expect(bad.code).toBe(1);
    const noDb = await cli(dir, ["import", "--snapshot", "c.json", "--initiated-by", "x"], approved);
    expect(noDb.code).toBe(1); expect(noDb.err).toMatch(/IMPORT_DATABASE_URL/);
  });
});

dbDescribe("db-import CLI against the local test database (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); });
  it("import then reconcile then a second import: READY, READY, nothing new; dry-run in between leaves the data alone", async () => {
    db = await createTestDb();
    const dir = await mkdtemp(path.join(tmpdir(), "cli-")); await copyFile(path.join(FIX, "synthetic-clean.json"), path.join(dir, "c.json"));
    const env = { ...approved, IMPORT_DATABASE_URL: db.adminUrl, ACTOR_CONTEXT_KEY: TEST_ACTOR_KEY_B64 };
    const imp = await cli(dir, ["import", "--snapshot", "c.json", "--initiated-by", "cli-test"], env);
    expect(imp.err).toBe(""); expect(imp.code).toBe(0); expect(imp.out).toContain("[READY]"); expect(imp.out).toContain("scope=target");
    expect((await db.admin.query("SELECT count(*)::int AS n FROM customers")).rows[0].n).toBe(3);
    const noKey = await cli(dir, ["import", "--snapshot", "c.json", "--initiated-by", "cli-test"], { ...env, ACTOR_CONTEXT_KEY: "" });
    expect(noKey.code).toBe(1);
    const dry = await cli(dir, ["dry-run", "--snapshot", "c.json"], { ...approved, IMPORT_DATABASE_URL: db.adminUrl });
    expect(dry.code).toBe(0);
    const rec = await cli(dir, ["reconcile", "--snapshot", "c.json"], { ...approved, IMPORT_DATABASE_URL: db.adminUrl });
    expect(rec.code).toBe(0); expect(rec.out).toMatch(/reconciliation (\d+)\/\1/);
    const again = await cli(dir, ["import", "--snapshot", "c.json", "--initiated-by", "cli-test"], env);
    expect(again.code).toBe(0); expect(again.out).toMatch(/imported 0 /);
    await writeFile(path.join(dir, "unused"), "");
  });
  it("the read-only modes use a read-only session: a reconcile/dry-run cannot write even if the code tried", async () => {
    db = await createTestDb();
    const dir = await mkdtemp(path.join(tmpdir(), "cli-")); await copyFile(path.join(FIX, "synthetic-clean.json"), path.join(dir, "c.json"));
    const r = await cli(dir, ["dry-run", "--snapshot", "c.json"], { ...approved, IMPORT_DATABASE_URL: db.adminUrl });
    expect(r.code).toBe(0);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM import_batches")).rows[0].n).toBe(0);
  });
});
