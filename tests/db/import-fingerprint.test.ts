// Source integrity for an export handed over for a staging rehearsal: the fingerprint can be printed offline and enforced with --expect-fingerprint.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve(__dirname, "../../scripts/db-import.mjs");
const FIX = path.resolve(__dirname, "../fixtures/migration/synthetic-clean.json");
const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });

describe("export fingerprint check", () => {
  it("prints a stable fingerprint offline, accepts the right one and refuses a changed export before touching any database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mvz-export-")); copyFileSync(FIX, path.join(dir, "export.json"));
    const fp = run(dir, ["fingerprint", "--snapshot", "export.json"]); expect(fp.status).toBe(0);
    const sha = fp.stdout.trim(); expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const env = { MOVEZZ_IMPORT_ENVIRONMENT: "test", NODE_ENV: "test" };
    expect(run(dir, ["dry-run", "--snapshot", "export.json", "--expect-fingerprint", sha], env).status).not.toBe(1);        // offline dry-run proceeds (0 or 2 = verdict)
    const bad = run(dir, ["dry-run", "--snapshot", "export.json", "--expect-fingerprint", "0".repeat(64)], env);
    expect(bad.status).toBe(1); expect(bad.stderr).toMatch(/does not match/);
    const j = JSON.parse(readFileSync(path.join(dir, "export.json"), "utf8")); const t = Object.keys(j.tables)[0]; j.tables[t][0].fields = { ...j.tables[t][0].fields, Tampered: "x" };
    writeFileSync(path.join(dir, "changed.json"), JSON.stringify(j));
    expect(run(dir, ["fingerprint", "--snapshot", "changed.json"]).stdout.trim()).not.toBe(sha);
  });
  it("a snapshot outside the working directory is refused (the operator runs the tool from the staging directory that holds the export)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mvz-cwd-"));
    const r = run(dir, ["fingerprint", "--snapshot", FIX]); expect(r.status).toBe(1);
  });
  it("a snapshot that declares itself a real export is refused without --expect-fingerprint (and with a wrong one), before any database access", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mvz-exp-")); const j = JSON.parse(readFileSync(FIX, "utf8")); j.source = { ...j.source, kind: "export" };
    writeFileSync(path.join(dir, "e.json"), JSON.stringify(j));
    const env = { MOVEZZ_IMPORT_ENVIRONMENT: "staging", MOVEZZ_IMPORT_ALLOW_EXPORT: "1", NODE_ENV: "test" };
    const none = run(dir, ["dry-run", "--snapshot", "e.json"], env); expect(none.status).toBe(1); expect(none.stderr).toMatch(/--expect-fingerprint/);
    const wrong = run(dir, ["dry-run", "--snapshot", "e.json", "--expect-fingerprint", "f".repeat(64)], env); expect(wrong.status).toBe(1); expect(wrong.stderr).toMatch(/does not match/);
    const fp = run(dir, ["fingerprint", "--snapshot", "e.json"]).stdout.trim();
    expect(run(dir, ["dry-run", "--snapshot", "e.json", "--expect-fingerprint", fp], env).status).not.toBe(1);
  });
});
