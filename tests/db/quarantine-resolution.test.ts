// Phase 7K: the smallest quarantine-resolution mechanism. Records decisions only; never edits data; fails closed.
import { describe, it, expect, afterEach } from "vitest";
import { dbDescribe, createTestDb, sqlstate, TEST_ACTOR_KEY_B64, type TestDb } from "./helpers";
import { importSnapshot, parseSnapshotText } from "../../scripts/lib/import/index.mjs";
import { listQuarantine, resolveQuarantine, unresolvedSummary } from "../../scripts/lib/import/resolution.mjs";
import { buildRealisticSnapshot } from "../fixtures/migration/realistic.mjs";
import { actorKeyFromEnv } from "../../src/lib/db/actor";

dbDescribe("quarantine resolution (PostgreSQL)", () => {
  let db: TestDb;
  afterEach(async () => { await db?.close(); });
  const setup = async () => {
    db = await createTestDb();
    const { snapshot } = buildRealisticSnapshot({ scale: 1 });
    const env = { NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test", ACTOR_CONTEXT_KEY: TEST_ACTOR_KEY_B64 };
    await importSnapshot({ snapshot: parseSnapshotText(JSON.stringify(snapshot)), pool: db.admin as never, env, targetUrl: db.adminUrl, initiatedBy: "rehearsal" } as never);
  };

  it("lists, summarises and resolves; the original row is untouched; every bad input is refused; decisions are append-only and owner-only", async () => {
    await setup();
    const all = await listQuarantine(db.admin);
    const before = await unresolvedSummary(db.admin);
    expect(all.length).toBeGreaterThan(0);
    const target = all[0];
    await expect(resolveQuarantine(db.admin, { quarantineId: Number(target.id), resolution: "excluded", reason: "short", resolvedBy: "ops" })).rejects.toThrow(/reason/);
    await expect(resolveQuarantine(db.admin, { quarantineId: Number(target.id), resolution: "excluded", reason: "long enough reason", resolvedBy: " " })).rejects.toThrow(/resolved-by/);
    await expect(resolveQuarantine(db.admin, { quarantineId: Number(target.id), resolution: "fixed" as never, reason: "long enough reason", resolvedBy: "ops" })).rejects.toThrow(/resolution must/);
    await expect(resolveQuarantine(db.admin, { quarantineId: Number(target.id), resolution: "corrected_in_new_snapshot", reason: "long enough reason", resolvedBy: "ops" })).rejects.toThrow(/fingerprint/);
    await expect(resolveQuarantine(db.admin, { quarantineId: 999999, resolution: "excluded", reason: "long enough reason", resolvedBy: "ops" })).rejects.toMatchObject({ code: "23503" });
    await resolveQuarantine(db.admin, { quarantineId: Number(target.id), resolution: "excluded", reason: "owner decided this record is not migrated", resolvedBy: "ops-lead" });
    await expect(resolveQuarantine(db.admin, { quarantineId: Number(target.id), resolution: "excluded", reason: "second decision attempt", resolvedBy: "ops" })).rejects.toMatchObject({ code: "23505" });
    const after = await unresolvedSummary(db.admin);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(Object.values(before).reduce((a, b) => a + b, 0) - 1);
    expect((await listQuarantine(db.admin, { unresolvedOnly: true })).some((r: { id: number }) => r.id === target.id)).toBe(false);
    const row = (await db.admin.query("SELECT reason, category FROM import_quarantine WHERE id = $1", [target.id])).rows[0];
    expect(row).toMatchObject({ reason: target.reason, category: target.category });
    expect(await sqlstate(db.admin.query("UPDATE import_quarantine_resolutions SET reason = 'edited reason here'"))).toBe("MV004");
    expect(await sqlstate(db.admin.query("DELETE FROM import_quarantine_resolutions"))).toBe("MV004");
    expect(await sqlstate(db.app.query("SELECT 1 FROM import_quarantine_resolutions"))).toBe("42501");
    const ok = await resolveQuarantine(db.admin, { quarantineId: Number(all[1].id), resolution: "corrected_in_new_snapshot", reason: "corrected in the source and re-exported", resolvedBy: "ops-lead", newSnapshotFingerprint: "a".repeat(64) });
    expect(ok.id).toBeTruthy();
  });
});

describe("production actor key validation", () => {
  it("refuses a missing, short or non-random key in production but accepts a random one", () => {
    const saved = { k: process.env.ACTOR_CONTEXT_KEY, n: process.env.NODE_ENV };
    const set = (v: string | undefined, n: string) => { (process.env as Record<string, string | undefined>).NODE_ENV = n; if (v === undefined) delete process.env.ACTOR_CONTEXT_KEY; else process.env.ACTOR_CONTEXT_KEY = v; };
    try {
      set(undefined, "production"); expect(() => actorKeyFromEnv()).toThrow(/not configured/);
      set(Buffer.alloc(16, 7).toString("base64"), "production"); expect(() => actorKeyFromEnv()).toThrow(/32 bytes/);
      set(Buffer.alloc(32, 7).toString("base64"), "production"); expect(() => actorKeyFromEnv()).toThrow(/not a random key/);
      set(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString("base64"), "production"); expect(actorKeyFromEnv().length).toBe(32);
    } finally { set(saved.k, saved.n ?? "test"); }
  });
});
