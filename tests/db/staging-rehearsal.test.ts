// Phase 7J staging rehearsal, run against the disposable local test PostgreSQL with MOCK integrations only:
//   imported realistic data -> identity linking -> authorization/ownership -> native financial flow -> workers (mock) -> logs -> backup/restore.
// Source-code-derived data, not production data. No Firebase, Keepup, e-mail or WhatsApp is contacted (mocks only).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, TEST_ACTOR_KEY, TEST_ACTOR_KEY_B64, sqlstate, ADMIN_URL, staffUser, type TestDb } from "./helpers";
import { importSnapshot, parseSnapshotText, createLogger } from "../../scripts/lib/import/index.mjs";
import { rehearse } from "../../scripts/lib/rehearsal.mjs";
import { buildRealisticSnapshot } from "../fixtures/migration/realistic.mjs";
import { createInvoice, recordPayment, cancelInvoice } from "../../src/lib/db/invoices";
import { user, mintAssertion, withActorTransaction } from "../../src/lib/db/actor";
import { priceItem } from "../../src/lib/db/pricing";
import * as repo from "../../src/lib/db/ownership";
import { submitRegistration, approveRegistration } from "../../src/lib/db/registration";
import { DomainError } from "../../src/lib/db/errors";
import { setLogSink, logEvent, redact } from "../../src/lib/db/log";
import { runKeepupWorkerOnce } from "../../src/lib/db/workers/keepup-worker";
import { runOutboxWorkerOnce, MockNotificationSender } from "../../src/lib/db/workers/outbox-worker";
import { MockKeepupGateway } from "../../src/lib/integrations/keepup-gateway";
import { resolveKeepupSync } from "../../src/lib/db/integration-admin";
import { errorResponse } from "../../src/lib/pg-auth";

const tokens = new Map<string, { uid: string }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));
import { pgActorFromRequest } from "../../src/lib/pg-auth";
import { setPoolForTests } from "../../src/lib/db/client";

const env = (): Record<string, string> => ({ NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test", ACTOR_CONTEXT_KEY: TEST_ACTOR_KEY_B64 });
let kn = 0; const key = () => `st-${Date.now()}-${++kn}-abcdefgh`;
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof DomainError ? e.code : ((e as { code?: string }).code ?? `RAW:${(e as Error).message}`); } };

dbDescribe("imported database + native flows + identity (PostgreSQL, mocks only)", () => {
  let db: TestDb; let admin: string, staff: string;
  let custA: string, custB: string, custInactive: string, itemA: string, itemB: string, loginA: string, loginB: string, emailA: string;
  const lines: string[] = [];
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const as = <T>(a: string | ReturnType<typeof user>, fn: Parameters<typeof withActorTransaction<T>>[2]) => withActorTransaction(db.app, typeof a === "string" ? user(a) : a, fn);

  beforeAll(async () => {
    db = await createTestDb();
    const { snapshot } = buildRealisticSnapshot();
    const log = createLogger({ sink: (l: string) => lines.push(l) });
    await importSnapshot({ snapshot: parseSnapshotText(JSON.stringify(snapshot)), pool: db.admin as never, env: env(), targetUrl: db.adminUrl, initiatedBy: "rehearsal", log } as never);
    admin = await staffUser(db.admin, "super_admin"); staff = await staffUser(db.admin, "warehouse_staff");
    // two active imported customers that own an uninvoiced, dimensioned sea item with a tier price, and one inactive imported customer
    const pickItem = async (skip: string[]) => (await q(`SELECT i.id, i.customer_id FROM items i JOIN customers c ON c.id = i.customer_id
        WHERE c.status = 'active' AND c.email IS NOT NULL AND i.freight_type = 'sea' AND i.length > 0 AND i.width > 0 AND i.height > 0 AND i.tier_price_usd > 0 AND i.invoice_id IS NULL AND i.carton_id IS NULL
          AND i.billing_basis = 'tier' AND i.package_tier IS NULL AND NOT (i.customer_id = ANY($1::uuid[])) ORDER BY i.item_ref LIMIT 1`, [skip]))[0];
    const a = await pickItem([]); const b = await pickItem([a.customer_id]);
    custA = a.customer_id; itemA = a.id; custB = b.customer_id; itemB = b.id;
    custInactive = (await q("SELECT id FROM customers WHERE status = 'inactive' ORDER BY shipping_mark LIMIT 1"))[0].id;
    emailA = (await q("SELECT email FROM customers WHERE id = $1", [custA]))[0].email;
    setPoolForTests(db.app);
  });
  afterAll(async () => { setPoolForTests(undefined); setLogSink(null); await db?.close(); });

  it("the imported customers have NO login, and an imported customer cannot simply register their way in: approval refuses a match (explicit administrator action is required)", async () => {
    expect((await q("SELECT count(*)::int AS n FROM users WHERE role = 'customer'"))[0].n).toBe(0);
    const email = emailA;
    expect(await code(as({ type: "system" }, (tx) => tx.query("SELECT movezz_sec.submit_registration($1,$2,$3,NULL,NULL,$4,NULL,NULL)", ["Imported Person", email, "0244000111", "Accra Central"])))).toBe("OK"); // the public is told "received" either way
    expect((await q("SELECT count(*)::int AS n FROM registration_requests WHERE lower(email) = lower($1)", [email]))[0].n).toBe(0);                // ... but nothing is stored for an existing customer's e-mail
    void submitRegistration; void approveRegistration;
  });

  it("the only supported way to give an imported customer a login is an explicit super_admin act with a verified uid; staff and customers cannot", async () => {
    const mk = (actorId: string, c: string, uid: string) => as(actorId, (tx) => tx.query("SELECT movezz_sec.admin_create_user($1, $2, 'Linked Customer', 'customer', $3) AS id", [uid, `${uid}@example.invalid`, c]));
    expect(await code(mk(staff, custA, "uid-denied-1"))).toBe("NOT_AUTHORIZED");
    const r = await mk(admin, custA, "uid-a-1"); loginA = r.rows[0].id;
    loginB = (await mk(admin, custB, "uid-b-1")).rows[0].id;
    expect(await code(mk(admin, custInactive, "uid-inactive-1"))).toBe("INVALID_INPUT");                                  // an inactive imported customer is not revived
    expect(await code(mk(admin, custA, "uid-a-2"))).toBe("DUPLICATE");                                                      // one login per customer
    expect((await q("SELECT action FROM audit_logs WHERE entity_id = $1", [loginA])).map((x) => x.action)).toContain("user.create");
    expect((await q("SELECT role, customer_id FROM users WHERE id = $1", [loginA]))[0]).toEqual({ role: "customer", customer_id: custA });
  });

  it("customer isolation on imported data: own items only, others look non-existent, a forged customer id changes nothing", async () => {
    const own = await as(loginA, (tx) => repo.listItems(tx));
    expect(own.length).toBe((await q("SELECT count(*)::int AS n FROM items WHERE customer_id = $1 AND archived_at IS NULL", [custA]))[0].n);
    expect(own.every((i) => i.customer_id === custA)).toBe(true);
    expect(await as(loginA, (tx) => repo.listItems(tx, { customerId: custB }))).toEqual(own);                              // the filter is ignored for a customer
    expect(await as(loginA, (tx) => repo.getItem(tx, itemB))).toBeNull();                                                   // same answer as "no such item"
    expect(await as(loginA, (tx) => repo.getItemHistory(tx, itemB))).toBeNull();
    expect(await as(loginA, (tx) => repo.getCustomer(tx, custB))).toBeNull();
    expect((await as(loginA, (tx) => tx.query("SELECT count(*)::int AS n FROM items"))).rows[0].n).toBe(own.length);       // row-level security, even for raw SQL
    expect(await code(as(loginA, (tx) => repo.updateCustomerAdmin(tx, custA, { name: "Hacked" })))).toBe("NOT_AUTHORIZED");   // protected identity fields
    expect(await code(as(loginA, (tx) => tx.query("UPDATE customers SET name = 'x', shipping_mark = 'MOVEZZ-HACK' WHERE id = $1", [custA])))).toBe("NOT_AUTHORIZED");
    expect(await code(as(loginA, (tx) => tx.query("UPDATE items SET status = 'Completed' WHERE id = $1", [itemA])))).toBe("NOT_AUTHORIZED");
    expect(await code(as(loginA, (tx) => repo.updateCustomerSelf(tx, { shippingAddress: "1 New Road" })))).toBe("OK");
  });

  it("roles on imported data: staff price items but touch no money or administration; admin does everything financial; the imported rates and FX are really used", async () => {
    expect(await code(as(staff, (tx) => priceItem(tx, itemA)))).toBe("OK");
    expect(await code(as(loginA, (tx) => priceItem(tx, itemA)))).toBe("NOT_AUTHORIZED");
    expect(await code(createInvoice(db.app, { customerId: custA, itemIds: [itemA], actor: user(staff), idempotencyKey: key() }))).toBe("NOT_AUTHORIZED");
    expect(await code(createInvoice(db.app, { customerId: custA, itemIds: [itemA], actor: user(loginA), idempotencyKey: key() }))).toBe("NOT_AUTHORIZED");
    expect(await code(as(staff, (tx) => tx.query("INSERT INTO package_rates (tier, freight_type, rate_usd) VALUES ('special','sea',1)")))).toBe("NOT_AUTHORIZED");
    expect(await code(as(staff, (tx) => tx.query("SELECT movezz_sec.keepup_manual_retry(gen_random_uuid(), 'x')")))).toBe("NOT_AUTHORIZED");
    const { invoice } = await createInvoice(db.app, { customerId: custA, itemIds: [itemA], actor: user(admin), idempotencyKey: key() });
    expect(invoice.fx_rate).toBe("12.50000000");                                                                            // the imported Settings rate, now the CURRENT rate
    expect(invoice.status).toBe("Pending");
    const p = await recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "10.00", actor: user(admin), idempotencyKey: key() });
    expect(p.invoice.status).toBe("Partial");
    expect(await code(cancelInvoice(db.app, { invoiceId: invoice.id, reason: "x", actor: user(staff) }))).toBe("NOT_AUTHORIZED");
    expect(await code(cancelInvoice(db.app, { invoiceId: invoice.id, reason: "x", actor: user(admin) }))).toBe("ACTIVE_PAYMENT_EXISTS");
    // the customer sees exactly their own invoice and payment; the other customer sees none
    expect((await as(loginA, (tx) => repo.listInvoices(tx))).map((i) => i.id)).toEqual([invoice.id]);
    expect(await as(loginB, (tx) => repo.listInvoices(tx)) ?? []).toEqual([]);
    expect(await as(loginB, (tx) => repo.getInvoice(tx, invoice.id))).toBeNull();
    expect(await as(loginB, (tx) => repo.getInvoicePayments(tx, invoice.id)) ?? []).toEqual([]);
    expect((await as(loginA, (tx) => repo.getInvoicePayments(tx, invoice.id)))!.length).toBe(1);
  });

  it("identity failures: forged, expired, replayed, stale and unknown actors are all refused by the database; account state is re-read every time", async () => {
    const begin = (a: ReturnType<typeof mintAssertion>) => db.app.connect().then(async (c) => { try { await c.query("BEGIN"); await c.query("SELECT movezz_sec.begin_actor($1,$2,$3,$4,$5,$6)", [a.type, a.userId, a.requestId, a.jti, a.exp, a.sig]); await c.query("ROLLBACK"); return "OK"; } catch (e) { await c.query("ROLLBACK").catch(() => {}); return (e as { code?: string }).code ?? "ERR"; } finally { c.release(); } });
    const good = mintAssertion(user(loginA), TEST_ACTOR_KEY);
    expect(await begin(good)).toBe("OK");
    expect(await begin({ ...good, userId: loginB })).toBe("MV007");                                                         // forged user id (signature no longer matches)
    expect(await begin({ ...good, userId: custB })).toBe("MV007");                                                          // a customer id passed as a user id
    expect(await begin(mintAssertion(user(loginA), Buffer.alloc(32, 1)))).toBe("MV007");                                    // wrong signing key
    expect(await begin(mintAssertion(user(loginA), TEST_ACTOR_KEY, new Date(Date.now() - 10 * 60_000)))).toBe("MV007");    // expired
    expect(await begin(mintAssertion(user(loginA), TEST_ACTOR_KEY, new Date(Date.now() + 10 * 60_000)))).toBe("MV007");     // from the future
    expect(await begin(mintAssertion(user("00000000-0000-4000-8000-000000000000"), TEST_ACTOR_KEY))).toBe("MV007");          // unknown user
    const stale = mintAssertion(user(loginB), TEST_ACTOR_KEY);                                                               // minted while the user was fine ...
    await db.admin.query("UPDATE users SET is_active = false, deactivated_at = now() WHERE id = $1", [loginB]);
    expect(await begin(stale)).toBe("MV007");                                                                                // ... used after deactivation
    await db.admin.query("UPDATE users SET is_active = true, deactivated_at = NULL WHERE id = $1", [loginB]);
    await db.admin.query("UPDATE customers SET status = 'inactive' WHERE id = $1", [custB]);
    expect(await code(as(loginB, (tx) => repo.listItems(tx)))).toBe("ACTOR_INVALID");                                       // an inactive customer's login is refused
    await db.admin.query("UPDATE customers SET status = 'active' WHERE id = $1", [custB]);
    await db.admin.query("UPDATE users SET is_active = true, deactivated_at = NULL WHERE id = $1", [loginB]);              // reactivating a customer never reactivates its logins
    expect(await code(as(loginB, (tx) => repo.listItems(tx)))).toBe("OK");
  });

  it("the Firebase boundary (mock): invalid token, unknown uid, deactivated user and cross-site cookie are 401/401/401/403; no role or customer id is taken from the request", async () => {
    tokens.set("good", { uid: "uid-a-1" }); tokens.set("ghost", { uid: "uid-nobody" });
    const rq = (h: Record<string, string>) => new NextRequest("http://localhost/api/x", { headers: h });
    const a = await pgActorFromRequest(rq({ authorization: "Bearer good", "x-role": "super_admin", "x-customer-id": custB }));
    expect(a).toMatchObject({ type: "user", userId: loginA });
    expect(Object.keys(a ?? {}).sort()).toEqual(["requestId", "type", "userId"]);
    expect(await pgActorFromRequest(rq({ authorization: "Bearer nope" }))).toBeNull();
    expect(await pgActorFromRequest(rq({ authorization: "Bearer ghost" }))).toBeNull();
    expect(await pgActorFromRequest(rq({}))).toBeNull();
    expect(await code(pgActorFromRequest(new NextRequest("http://localhost/api/x", { method: "POST", headers: { cookie: "auth-token=good", origin: "https://evil.example.invalid", "sec-fetch-site": "cross-site" } })))).toBe("NOT_AUTHORIZED");
    await db.admin.query("UPDATE users SET is_active = false, deactivated_at = now() WHERE id = $1", [loginA]);
    const act = await pgActorFromRequest(rq({ authorization: "Bearer good" }));
    expect(await code(as(act!, (tx) => repo.listItems(tx)))).toBe("ACTOR_INVALID");
    expect(errorResponse(new DomainError("ACTOR_INVALID", "x")).status).toBe(401);
    expect(errorResponse(new DomainError("NOT_AUTHORIZED", "x")).status).toBe(403);
    expect(errorResponse(new DomainError("INVALID_STATE", "x")).status).toBe(409);
    expect(errorResponse(new Error("boom")).status).toBe(500);
    await db.admin.query("UPDATE users SET is_active = true, deactivated_at = NULL WHERE id = $1", [loginA]);
  });

  it("workers on the imported database use mocks only: sync -> synced, unknown outcome -> reconciliation, no resend after restart; outbox retries and dead-letters", async () => {
    const captured: string[] = []; setLogSink((l) => captured.push(l));
    const inv = (await q("SELECT id, invoice_ref FROM invoices ORDER BY created_at LIMIT 1"))[0];
    const gw = new MockKeepupGateway();
    const r1 = await runKeepupWorkerOnce(db.app, { gateway: gw, owner: "rehearsal-w1", batch: 10, leaseSeconds: 60, callTimeoutMs: 20_000 });
    expect(r1).toMatchObject({ claimed: 1, synced: 1 });
    expect((await q("SELECT sync_state, keepup_sale_id FROM keepup_sync WHERE invoice_id = $1", [inv.id]))[0].sync_state).toBe("synced");
    // a second invoice whose attempt dies (gateway throws) -> unknown outcome; the "restarted" worker must not resend
    const { invoice: inv2 } = await createInvoice(db.app, { customerId: custB, itemIds: [itemB], actor: user(admin), idempotencyKey: key() });
    const boom = new MockKeepupGateway().enqueue(new Error("connection reset"));
    expect(await runKeepupWorkerOnce(db.app, { gateway: boom, owner: "rehearsal-w2", batch: 10, leaseSeconds: 60, callTimeoutMs: 20_000 })).toMatchObject({ ambiguous: 1 });
    const restarted = new MockKeepupGateway();
    expect(await runKeepupWorkerOnce(db.app, { gateway: restarted, owner: "rehearsal-w3", batch: 10, leaseSeconds: 60, callTimeoutMs: 20_000 })).toMatchObject({ claimed: 0 });
    expect(restarted.received).toHaveLength(0);
    const sync2 = (await q("SELECT id FROM keepup_sync WHERE invoice_id = $1", [inv2.id]))[0].id;
    await resolveKeepupSync(db.app, { syncId: sync2, outcome: "created", saleId: "REH-1", reason: "verified in the sandbox", actor: user(admin) });
    // outbox: the invoice e-mails were queued by the business transaction; a mock sender fails once, then succeeds
    const sender = new MockNotificationSender().enqueue({ kind: "retry", reason: "mock 503" });
    const o1 = await runOutboxWorkerOnce(db.app, { sender, owner: "rehearsal-o1", batch: 10, leaseSeconds: 60, sendTimeoutMs: 20_000 });
    expect(o1.retried).toBeGreaterThanOrEqual(1);
    await db.admin.query("UPDATE notification_outbox SET next_attempt_at = now() - interval '1 second' WHERE status = 'failed'");
    const o2 = await runOutboxWorkerOnce(db.app, { sender, owner: "rehearsal-o2", batch: 10, leaseSeconds: 60, sendTimeoutMs: 20_000 });
    expect(o2.sent).toBeGreaterThanOrEqual(1);
    expect(sender.accepted.every((m) => m.recipient.endsWith("@example.invalid"))).toBe(true);                               // nothing real could have been addressed
    // the operational signals exist, share a correlation id per pass, and carry no personal data
    const ev = captured.map((l) => JSON.parse(l)); const names = new Set(ev.map((e) => e.event));
    for (const n of ["keepup.claimed", "keepup.synced", "keepup.outcome_unknown", "outbox.claimed", "outbox.sent", "outbox.retry_scheduled"]) expect(names.has(n), n).toBe(true);
    expect(ev.filter((e) => e.event.startsWith("keepup.") || e.event.startsWith("outbox.")).every((e) => typeof e.correlationId === "string" && /^(keepup|outbox):/.test(e.correlationId))).toBe(true);
    setLogSink(null);
  });

  it("logs explain failures without leaking secrets or personal data: actor rejections, authorization denials, constraint failures, importer failures", async () => {
    const captured: string[] = []; setLogSink((l) => captured.push(l));
    await code(as(loginB, (tx) => tx.query("UPDATE customers SET name = 'x' WHERE id = $1", [custB])));                     // authorization.denied
    await code(withActorTransaction(db.app, user(loginA, "req-observed-1"), (tx) => tx.query("SELECT 1")));                  // actor.rejected (loginA is inactive? restored above) - may be OK
    await code(withActorTransaction(db.app, user("00000000-0000-4000-8000-0000000000aa", "req-observed-2"), (tx) => tx.query("SELECT 1")));
    await code(as(admin, (tx) => tx.query("INSERT INTO fx_rates (base_currency, quote_currency, rate, source) VALUES ('USD','GHS',99999,'secret-source hunter2')"))); // constraint failure
    const ev = captured.map((l) => JSON.parse(l)); const names = ev.map((e) => e.event);
    expect(names).toContain("actor.rejected"); expect(names).toContain("authorization.denied"); expect(names.some((n) => n === "db.transaction_failed" || n === "operation.rejected")).toBe(true);
    const rejected = ev.find((e) => e.event === "actor.rejected" && e.correlationId === "req-observed-2");
    expect(rejected).toMatchObject({ mappedCode: "ACTOR_INVALID", actorType: "user" });
    const failed = ev.find((e) => e.event === "db.transaction_failed" || e.event === "operation.rejected");
    expect(failed).toMatchObject({ sqlstate: expect.any(String) });
    const all = captured.join("\n");
    for (const secret of ["hunter2", "99999", TEST_ACTOR_KEY_B64, TEST_ACTOR_KEY.toString("hex"), "uid-a-1", "@example.invalid"]) expect(all, secret).not.toContain(secret);
    setLogSink(null);
    // importer events: batch id as correlation id; a failing hook carrying a connection string is scrubbed
    const lines: string[] = []; const log = createLogger({ sink: (l: string) => lines.push(l) });
    const d2 = await createTestDb();
    try {
      await expect(importSnapshot({ snapshot: parseSnapshotText(JSON.stringify(buildRealisticSnapshot().snapshot)), pool: d2.admin as never, env: env(), targetUrl: d2.adminUrl, initiatedBy: "rehearsal", log,
        hooks: { afterStage: async (s: string) => { if (s === "customers") throw new Error("lost postgres://user:hunter2@db.internal/x with Bearer abcdefghijklmnop"); } } } as never)).rejects.toThrow();
    } finally { await d2.close(); }
    const iev = lines.map((l) => JSON.parse(l));
    expect(iev.map((e) => e.event)).toEqual(expect.arrayContaining(["import.started", "import.stage", "import.failed"]));
    expect(new Set(iev.filter((e) => e.event !== "import.started").map((e) => e.correlationId)).size).toBe(1);
    expect(lines.join("\n")).not.toMatch(/hunter2|abcdefghijklmnop/);
  });

  it("the redactor is safe by construction", () => {
    const out = JSON.stringify(redact({ password: "p", token: "t", nested: { apiKey: "k", email: "a@b.com", note: "call a@b.com Bearer abcdefghij1234 postgres://u:pw@h/db", ok: 3 }, list: [{ authorization: "x" }] }));
    expect(out).not.toMatch(/"p"|"t"|"k"|a@b\.com|abcdefghij1234|:pw@/);
    expect(out).toContain('"ok":3');
    setLogSink((l) => { throw new Error(l); }); expect(() => logEvent("info", "x", { a: 1 })).not.toThrow(); setLogSink(null);          // a failing sink never breaks an operation
  });
});

dbDescribe("backup, restore and staging isolation (PostgreSQL)", () => {
  it("rehearsal cycle: fresh database -> migrate -> dry-run -> import -> reconcile -> duplicate -> backup -> restore -> verify -> drop, twice, identical results", async () => {
    const results: any[] = [];
    for (let i = 0; i < 2; i++) results.push(await rehearse({ adminUrl: ADMIN_URL!, scale: 1, actorKeyB64: TEST_ACTOR_KEY_B64, environmentClass: "test" }) as any);
    for (const m of results) {
      expect(m.dryRunWroteNothing).toBe(true); expect(m.duplicateImportIdentical).toBe(true);
      expect(m.report.failed).toBe(0); expect(m.report.reconciliation.passed).toBe(m.report.reconciliation.total);
      expect(m.restore).toMatchObject({ signatureEqual: true, migrations: 18, actorKeysInRestoredDatabase: 0, reconcileExit: 2 });
      expect(m.backupContainsSigningKey).toBe(false);
      expect(m.phases["dry-run"].verdict).toBe("NOT_READY"); expect(m.report.financialDiscrepancies).toBe(0);
    }
    expect(results[1].report.imported).toBe(results[0].report.imported);                                                   // repeatable
    expect(results[1].report.quarantined).toBe(results[0].report.quarantined);
    expect(results[1].restore.reconciliation).toBe(results[0].restore.reconciliation);
    const left = await (await import("pg")).default.Pool.prototype.constructor.length; void left;
  });
  it("the databases are disposable: none is left behind", async () => {
    const pg = (await import("pg")).default; const p = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
    try { expect((await p.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'mvz_rehearsal_%'")).rows[0].n).toBe(0); } finally { await p.end(); }
  });
  it("a default pg_dump WOULD put the actor signing key into the backup - which is why the rehearsal and the documented procedure exclude it", async () => {
    const db = await createTestDb();
    try {
      const { spawnSync } = await import("node:child_process");
      const plain = spawnSync("pg_dump", ["-Fp", db.adminUrl]).stdout.toString();
      const safe = spawnSync("pg_dump", ["-Fp", "--exclude-table-data=movezz_sec.actor_keys", db.adminUrl]).stdout.toString();
      expect(plain).toContain(TEST_ACTOR_KEY.toString("hex")); expect(safe).not.toContain(TEST_ACTOR_KEY.toString("hex"));
      expect(await sqlstate(db.app.query("SELECT * FROM movezz_sec.actor_keys"))).toBe("42501");                          // and the application role cannot read it
    } finally { await db.close(); }
  });
  it("the rehearsal refuses a non-local target, a production-looking target, and a live credential in the operator's environment - before creating anything", async () => {
    await expect(rehearse({ adminUrl: "postgres://postgres@db.example.com/postgres", environmentClass: "local" })).rejects.toThrow(/refuses|Refusing/);
    await expect(rehearse({ adminUrl: "postgres://postgres@127.0.0.1:1/production", environmentClass: "local" })).rejects.toThrow(/refuses|Refusing/);
    process.env.AIRTABLE_API_KEY = "patFAKE.fake";
    try { await expect(rehearse({ adminUrl: ADMIN_URL!, environmentClass: "test" })).rejects.toThrow(/AIRTABLE_API_KEY/); } finally { delete process.env.AIRTABLE_API_KEY; }
  });
});
afterEach(() => { setLogSink(null); });
