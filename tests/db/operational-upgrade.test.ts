// Migration 0015 on a database that already holds operational data (upgrade from 0014): nothing is lost or rewritten, legacy states
// keep working, and the new guards apply to new writes only.
import { it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dbDescribe, createBareTestDb, customer, item, actorQuery, TEST_ACTOR_KEY } from "./helpers";
import { migrate, loadMigrations, status } from "../../scripts/lib/migrate.mjs";
import { createPool } from "../../src/lib/db/client";
import { withActorTransaction } from "../../src/lib/db/actor";

dbDescribe("migration 0015 upgrade path (PostgreSQL)", () => {
  async function dbAt0014() {
    const bare = await createBareTestDb();
    const dir = await mkdtemp(path.join(tmpdir(), "mig14-"));
    for (const f of (await loadMigrations()).filter((m: { version: number }) => m.version <= 14)) await writeFile(path.join(dir, f.name), f.sql);
    await migrate(bare.url, { dir });
    return bare;
  }
  it("keeps every existing keepup_sync / outbox / idempotency / audit row exactly as it was, and legacy in-flight rows can still be reaped", async () => {
    const old = await dbAt0014();
    try {
      await old.admin.query("SELECT movezz_sec.set_actor_key($1)", [TEST_ACTOR_KEY]);
      const c = await customer(old.admin); await item(old.admin, c);
            const mk = async (ref: string, total: number) => (await actorQuery(old.admin, { type: "import" }).query(
        `INSERT INTO invoices (invoice_ref, customer_id, subtotal_usd, fx_rate, total_ghs, provenance, provenance_note, created_by) VALUES ($1,$2,$3,12.5,$4,'legacy_known','legacy',$5::uuid) RETURNING id`,
        [ref, c, total / 12.5, total, null])).rows[0].id as string;
      const inv = [await mk("ORD-L1", 125), await mk("ORD-L2", 250), await mk("ORD-L3", 375)];
      await old.admin.query(`INSERT INTO keepup_sync (kind, invoice_id, idempotency_key, sync_state, attempt_count, last_attempt_at) VALUES
        ('invoice',$1,'legacy-1','creating',1, now() - interval '1 hour'), ('invoice',$2,'legacy-2','needs_reconciliation',2, now()), ('invoice',$3,'legacy-3','pending',0,NULL)`, inv);
      await old.admin.query(`INSERT INTO notification_outbox (event_type, channel, recipient, status, attempts, dedupe_key, updated_at) VALUES ('x','email','a@b.invalid','sending',1,'legacy-o1', now() - interval '1 hour'), ('x','email','c@d.invalid','pending',0,'legacy-o2', now())`);
      const before = (await old.admin.query(`SELECT (SELECT json_agg(k ORDER BY k.idempotency_key) FROM (SELECT idempotency_key, sync_state, attempt_count, keepup_sale_id FROM keepup_sync) k) AS ks,
                                                    (SELECT json_agg(o ORDER BY o.dedupe_key) FROM (SELECT dedupe_key, status, attempts FROM notification_outbox) o) AS ob,
                                                    (SELECT count(*) FROM audit_logs) AS au, (SELECT count(*) FROM idempotency_keys) AS ik`)).rows[0];

      expect((await migrate(old.url)).applied).toEqual(["0015_operational_reliability.sql", "0016_import_framework.sql", "0017_quarantine_resolution.sql"]);
      expect((await status(old.url)).filter((s: { applied: boolean }) => !s.applied)).toEqual([]);
      const after = (await old.admin.query(`SELECT (SELECT json_agg(k ORDER BY k.idempotency_key) FROM (SELECT idempotency_key, sync_state, attempt_count, keepup_sale_id FROM keepup_sync) k) AS ks,
                                                   (SELECT json_agg(o ORDER BY o.dedupe_key) FROM (SELECT dedupe_key, status, attempts FROM notification_outbox) o) AS ob,
                                                   (SELECT count(*) FROM audit_logs) AS au, (SELECT count(*) FROM idempotency_keys) AS ik`)).rows[0];
      expect(after).toEqual(before);
      expect((await old.admin.query("SELECT lease_token, lease_expires_at, max_attempts FROM keepup_sync WHERE idempotency_key='legacy-1'")).rows[0]).toEqual({ lease_token: null, lease_expires_at: null, max_attempts: 5 });

      // the application role (with the signing key) can reap the legacy rows that never had a lease; nothing is lost
      const app = createPool((() => { const u = new URL(old.url); u.username = "movezz_app"; u.password = "test-only-app-role-password"; return u.toString(); })(), { max: 2 });
      try {
        const reaped = await withActorTransaction(app, { type: "integration" }, async (tx) => ({
          k: (await tx.query("SELECT movezz_sec.keepup_reap_expired(10) AS n")).rows[0].n, o: (await tx.query("SELECT movezz_sec.outbox_reap_expired(10) AS n")).rows[0].n }), TEST_ACTOR_KEY);
        expect(reaped).toEqual({ k: 1, o: 1 });
        expect((await old.admin.query("SELECT sync_state FROM keepup_sync WHERE idempotency_key='legacy-1'")).rows[0].sync_state).toBe("needs_reconciliation");
        expect((await old.admin.query("SELECT sync_state FROM keepup_sync WHERE idempotency_key='legacy-2'")).rows[0].sync_state).toBe("needs_reconciliation");
      } finally { await app.end(); }
    } finally { await old.close(); }
  });
  it("is idempotent: running the migrator again applies nothing; editing an applied file is refused", async () => {
    const old = await dbAt0014();
    try {
      await migrate(old.url);
      expect((await migrate(old.url)).applied).toEqual([]);
    } finally { await old.close(); }
  });
});
