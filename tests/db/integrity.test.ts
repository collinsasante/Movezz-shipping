// Keepup sync state, notification outbox, history/audit append-only guarantees, idempotency scoping,
// ownership representation and legacy-identity preservation.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbDescribe, createTestDb, customer, item, staffUser, fxRate, packageRates, sqlstate, actorQuery, type TestDb } from "./helpers";
import { createInvoice } from "../../src/lib/db/invoices";
import { user, withActorTransaction } from "../../src/lib/db/actor";
import { recordAudit, recordStatusEvent } from "../../src/lib/db/audit";
import { beginIdempotent, completeIdempotent, fingerprint } from "../../src/lib/db/idempotency";
import { DomainError } from "../../src/lib/db/errors";

let kn = 0;
const key = () => `integ-${Date.now()}-${++kn}-abcdefgh`;

dbDescribe("history, integrations and ownership (PostgreSQL)", () => {
  let db: TestDb; let actor: string;
  beforeAll(async () => { db = await createTestDb(); actor = await staffUser(db.admin); await packageRates(db.admin); await fxRate(db.admin); });
  afterAll(async () => { await db?.close(); });

  const newInvoice = async () => {
    const c = await customer(db.admin); const i = await item(db.admin, c);
    const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() });
    return { c, i, invoice };
  };

  describe("Keepup sync state", () => {
    it("persists attempts, errors and retry scheduling, and supports a due-work query", async () => {
      const { invoice } = await newInvoice();
      await db.app.query(`UPDATE keepup_sync SET sync_state='creating', attempt_count = attempt_count + 1, last_attempt_at = now() WHERE invoice_id=$1`, [invoice.id]);
      await db.app.query(`UPDATE keepup_sync SET sync_state='failed', last_error=$2, next_retry_at = now() - interval '1 minute' WHERE invoice_id=$1`, [invoice.id, "HTTP 503 from Keepup"]);
      const due = await db.app.query(`SELECT invoice_id, attempt_count, last_error FROM keepup_sync WHERE sync_state IN ('pending','failed') AND next_retry_at <= now()`);
      expect(due.rows).toContainEqual({ invoice_id: invoice.id, attempt_count: 1, last_error: "HTTP 503 from Keepup" });
    });
    it("an unknown outcome is representable (needs_reconciliation) and a later success records the external sale", async () => {
      const { invoice } = await newInvoice();
      await db.app.query(`UPDATE keepup_sync SET sync_state='needs_reconciliation', last_error='timeout after request sent' WHERE invoice_id=$1`, [invoice.id]);
      expect((await db.app.query(`SELECT count(*)::int AS n FROM keepup_sync WHERE sync_state='needs_reconciliation' AND invoice_id=$1`, [invoice.id])).rows[0].n).toBe(1);
      await db.app.query(`UPDATE keepup_sync SET sync_state='synced', keepup_sale_id='KU-1001', external_status='unpaid', last_success_at=now(), last_error=NULL, response_meta='{"share_link":"https://keepup.example.invalid/s/1001"}' WHERE invoice_id=$1`, [invoice.id]);
      await db.app.query(`UPDATE invoices SET keepup_sale_id='KU-1001', keepup_link='https://keepup.example.invalid/s/1001' WHERE id=$1`, [invoice.id]);
      expect((await db.admin.query(`SELECT sync_state, keepup_sale_id FROM keepup_sync WHERE invoice_id=$1`, [invoice.id])).rows[0]).toEqual({ sync_state: "synced", keepup_sale_id: "KU-1001" });
    });
    it("one Keepup sale per invoice and one external sale id per sale (duplicates are impossible)", async () => {
      const a = await newInvoice(); const b = await newInvoice();
      await actorQuery(db.admin).query(`UPDATE invoices SET keepup_sale_id='KU-DUP' WHERE id=$1`, [a.invoice.id]);
      expect(await sqlstate(actorQuery(db.admin).query(`UPDATE invoices SET keepup_sale_id='KU-DUP' WHERE id=$1`, [b.invoice.id]))).toBe("23505");
      expect(await sqlstate(db.admin.query(`INSERT INTO keepup_sync (kind, invoice_id, idempotency_key) VALUES ('invoice',$1,'another-key-1')`, [a.invoice.id]))).toBe("23505");
    });
    it("state values and payment linkage are constrained; errors are length-limited", async () => {
      const { invoice } = await newInvoice();
      expect(await sqlstate(db.admin.query(`UPDATE keepup_sync SET sync_state='done' WHERE invoice_id=$1`, [invoice.id]))).toBe("23514");
      expect(await sqlstate(db.admin.query(`INSERT INTO keepup_sync (kind, invoice_id, idempotency_key) VALUES ('payment',$1,'pay-no-payment-id')`, [invoice.id]))).toBe("23514");
      expect(await sqlstate(db.admin.query(`UPDATE keepup_sync SET last_error=$2 WHERE invoice_id=$1`, [invoice.id, "x".repeat(2001)]))).toBe("23514");
    });
  });

  describe("notification outbox", () => {
    it("is written with the business change, de-duplicated, and ready for a worker", async () => {
      const { invoice } = await newInvoice();
      expect(await sqlstate(db.admin.query(`INSERT INTO notification_outbox (event_type, channel, recipient, dedupe_key) VALUES ('invoice.created','email','x@example.invalid',$1)`, [`invoice.created:${invoice.id}`]))).toBe("23505");
      expect(await sqlstate(db.admin.query(`INSERT INTO notification_outbox (event_type, channel, recipient) VALUES ('x','pigeon','x@example.invalid')`))).toBe("23514");
      expect((await db.app.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE status='pending' AND next_attempt_at <= now()`)).rows[0].n).toBeGreaterThan(0);
      expect(await sqlstate(db.admin.query(`INSERT INTO notification_outbox (event_type, channel, recipient, status) VALUES ('x','email','y@example.invalid','sent')`))).toBe("23514"); // sent needs sent_at
    });
  });

  describe("append-only history", () => {
    it("status_events and audit_logs reject UPDATE, DELETE and TRUNCATE for everyone, including the owner", async () => {
      await newInvoice();
      for (const [t, col] of [["status_events", "new_status"], ["audit_logs", "action"]]) {
        expect(await sqlstate(db.admin.query(`UPDATE ${t} SET ${col} = 'x'`)), `${t} update`).toBe("MV004");
        expect(await sqlstate(db.admin.query(`DELETE FROM ${t}`)), `${t} delete`).toBe("MV004");
        expect(await sqlstate(db.admin.query(`TRUNCATE ${t}`)), `${t} truncate`).toBe("MV004");
        expect(await sqlstate(db.app.query(`DELETE FROM ${t}`)), `${t} delete (runtime)`).toBe("42501");
        expect(await sqlstate(db.app.query(`UPDATE ${t} SET ${col} = 'x'`)), `${t} update (runtime)`).toBe("42501");
      }
    });
    it("a status change appends a new event; the old one is untouched", async () => {
      const c = await customer(db.admin); const i = await item(db.admin, c);
      for (const [from, to] of [[null, "Arrived at Transit Warehouse"], ["Arrived at Transit Warehouse", "Shipped to Ghana"]] as const) {
        await withActorTransaction(db.app, user(actor), (tx) => recordStatusEvent(tx, { entityType: "item", entityId: i, from, to }));
      }
      const r = await db.admin.query(`SELECT old_status, new_status FROM status_events WHERE entity_id=$1 ORDER BY id`, [i]);
      expect(r.rows).toEqual([{ old_status: null, new_status: "Arrived at Transit Warehouse" }, { old_status: "Arrived at Transit Warehouse", new_status: "Shipped to Ghana" }]);
      expect(await sqlstate(actorQuery(db.admin, { type: "system" }).query(`INSERT INTO status_events (entity_type, new_status, actor_type) VALUES ('item','x','system')`))).toBe("23514"); // needs a target
    });
    it("audit records have secrets scrubbed by the database, nested too", async () => {
      await withActorTransaction(db.app, user(actor), (tx) => recordAudit(tx, {
        action: "user.create", entityType: "user", entityId: "u1",
        before: { email: "a@example.invalid", password: "hunter2" },
        after: { role: "customer", nested: { apiKey: "k-123", ok: 1 }, list: [{ Authorization: "Bearer abc" }], token: "t" },
        request: { ip: "203.0.113.9", userAgent: "jest" },
      }));
      const r = (await db.admin.query(`SELECT before_data, after_data, host(ip_address) AS ip FROM audit_logs WHERE entity_id='u1'`)).rows[0];
      expect(r.before_data).toEqual({ email: "a@example.invalid", password: "[REDACTED]" });
      expect(r.after_data).toEqual({ role: "customer", nested: { apiKey: "[REDACTED]", ok: 1 }, list: [{ Authorization: "[REDACTED]" }], token: "[REDACTED]" });
      expect(r.ip).toBe("203.0.113.9");
      expect(JSON.stringify(r)).not.toMatch(/hunter2|k-123|Bearer abc/);
    });
  });

  describe("idempotency keys", () => {
    it("are scoped per operation AND per actor: another user cannot replay or collide with a key", async () => {
      const other = await staffUser(db.admin);
      const k = key();
      const hash = fingerprint({ a: 1 });
      const begin = (who: string, scope: string) => withActorTransaction(db.admin, user(who), async (tx) => beginIdempotent(tx, { scope, actorUserId: who, key: k, requestHash: hash }));
      const mine = await begin(actor, "invoice.create");
      expect(mine.state).toBe("new");
      const theirs = await begin(other, "invoice.create");
      expect(theirs.state).toBe("new");
      const otherScope = await begin(actor, "payment.create");
      expect(otherScope.state).toBe("new");
    });
    it("an unfinished key cannot be replayed as if it had succeeded", async () => {
      const k = key();
      const begin = () => withActorTransaction(db.admin, user(actor), (tx) => beginIdempotent(tx, { scope: "x.op", actorUserId: actor, key: k, requestHash: "h" }));
      await begin();
      await expect(begin()).rejects.toBeInstanceOf(DomainError);
    });
    it("completed results are stored and replayed; keys have a minimum length and an expiry", async () => {
      const k = key();
      const sys = { type: "system" } as const;   // a service actor: no user id
      const s = await withActorTransaction(db.admin, sys, async (tx) => {
        const st = await beginIdempotent(tx, { scope: "x.done", actorUserId: null, key: k, requestHash: "h" });
        if (st.state !== "new") throw new Error("expected new");
        await completeIdempotent(tx, st.id, { entityType: "invoice", entityId: "11111111-1111-1111-1111-111111111111", response: { ok: true } });
        return st;
      });
      expect(s.state).toBe("new");
      const again = await withActorTransaction(db.admin, sys, (tx) => beginIdempotent(tx, { scope: "x.done", actorUserId: null, key: k, requestHash: "h" }));
      expect(again).toMatchObject({ state: "replay", resultEntityType: "invoice", response: { ok: true } });
      expect(await sqlstate(actorQuery(db.admin, { type: "system" }).query(`INSERT INTO idempotency_keys (scope, key) VALUES ('s','short')`))).toBe("23514");
      expect((await db.admin.query(`SELECT expires_at > now() AS future FROM idempotency_keys WHERE key=$1`, [k])).rows[0].future).toBe(true);
    });
  });

  describe("ownership can be enforced by repositories", () => {
    it("every customer-facing table carries customer_id (directly or through its parent) so a scoped query returns only the owner's rows", async () => {
      const a = await newInvoice(); const b = await newInvoice();
      const scoped = async (table: string, cid: string) => (await db.app.query(`SELECT count(*)::int AS n FROM ${table} WHERE customer_id = $1`, [cid])).rows[0].n;
      for (const t of ["items", "invoices"]) { expect(await scoped(t, a.c), t).toBe(1); expect(await scoped(t, b.c), t).toBe(1); }
      const lines = await db.app.query(`SELECT l.id FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.customer_id = $1`, [a.c]);
      expect(lines.rowCount).toBe(1);
      const pays = await db.app.query(`SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.customer_id = $1`, [a.c]);
      expect(pays.rowCount).toBe(0);
      const cols = await db.admin.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='customer_id' ORDER BY 1`);
      expect(cols.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(["items", "cartons", "invoices", "users", "special_rates"]));
    });
    it("staff and admin roles are representable and the least-privilege boundary is in the data, not the browser", async () => {
      const staff = await staffUser(db.admin, "warehouse_staff"); const admin = await staffUser(db.admin, "super_admin");
      const r = await db.admin.query(`SELECT role, customer_id FROM users WHERE id = ANY($1) ORDER BY role`, [[staff, admin]]);
      expect(r.rows).toEqual([{ role: "super_admin", customer_id: null }, { role: "warehouse_staff", customer_id: null }]);
    });
  });

  describe("legacy migration support", () => {
    it("Airtable identity and the original record survive; re-importing the same record is rejected, not duplicated", async () => {
      const raw = { id: "recCUST001", fields: { Name: "Ada", Phone: "0244001111", Status: "active", CustomOddField: [1, 2, 3] } };
      await db.admin.query(`INSERT INTO customers (name, phone, shipping_mark, legacy_airtable_id, legacy_data) VALUES ('Ada','0244001111','MOVEZZ-AM1111',$1,$2)`, [raw.id, JSON.stringify(raw.fields)]);
      const r = (await db.admin.query(`SELECT legacy_airtable_id, legacy_data FROM customers WHERE legacy_airtable_id = $1`, [raw.id])).rows[0];
      expect(r.legacy_data).toEqual(raw.fields);
      expect(await sqlstate(db.admin.query(`INSERT INTO customers (name, shipping_mark, legacy_airtable_id) VALUES ('Ada again','MOVEZZ-ZZ0000',$1)`, [raw.id]))).toBe("23505");
    });
    it("a legacy item can keep its original name-only special-rate snapshot without a live card, and counters can be seeded above imported references", async () => {
      const c = await customer(db.admin);
      await item(db.admin, c, { billing_basis: "special", special_rate_name: "Old Card", special_price_usd: 80, special_rate_id: null, legacy_airtable_id: "recITEM001", item_ref: "ITM-0420" });
      await db.admin.query(`SELECT seed_reference_counter('item','',420)`);
      const next = (await db.admin.query(`SELECT allocate_reference('item') AS r`)).rows[0].r;
      expect(next).toBe("ITM-0421");
      await db.admin.query(`SELECT seed_reference_counter('item','',10)`); // never moves backwards
      expect((await db.admin.query(`SELECT allocate_reference('item') AS r`)).rows[0].r).toBe("ITM-0422");
    });
    it("legacy status history keeps the Airtable record reference when no row exists yet", async () => {
      await db.admin.query(`INSERT INTO status_events (entity_type, new_status, actor_type, legacy_record_ref, legacy_airtable_id, occurred_at) VALUES ('item','Sorting','import','recITEMX','recHIST1','2025-05-05T10:00:00Z')`);
      expect(await sqlstate(db.admin.query(`INSERT INTO status_events (entity_type, new_status, actor_type, legacy_record_ref, legacy_airtable_id) VALUES ('item','Sorting','import','recITEMX','recHIST1')`))).toBe("23505");
    });
  });
});
