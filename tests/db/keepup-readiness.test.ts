// Keepup mode resolution (mock vs sandbox vs live), the worker CLI end to end against a LOCAL stub Keepup, and the readiness endpoint.
// Nothing here contacts a real provider; the stub is a loopback HTTP server.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, staffUser, fxRate, packageRates, pricedItem, type TestDb } from "./helpers";
import { createInvoice } from "../../src/lib/db/invoices";
import { user } from "../../src/lib/db/actor";
import { setPoolForTests } from "../../src/lib/db/client";
import { describeKeepup, createKeepupGateway, KEEPUP_PRODUCTION_BASE } from "../../src/lib/integrations/keepup-runtime";
import { MockKeepupGateway, HttpKeepupGateway } from "../../src/lib/integrations/keepup-gateway";
import { evaluateReadiness, resetReadinessCache } from "../../src/lib/readiness";
import { GET as readyGet } from "../../src/app/api/ready/route";

describe("Keepup mode resolution never mistakes a mock or sandbox for live", () => {
  const K = "keepup-test-key-123";
  it("defaults to disabled; unknown values are disabled with a problem; mock and sandbox are never liveCapable", () => {
    expect(describeKeepup({})).toMatchObject({ mode: "disabled", configured: false, liveCapable: false });
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "banana" })).toMatchObject({ mode: "disabled", liveCapable: false, problems: [expect.stringMatching(/not one of/)] });
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "mock" })).toMatchObject({ mode: "mock", configured: true, liveCapable: false });
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "sandbox", KEEPUP_API_KEY: K, KEEPUP_BASE_URL: "http://127.0.0.1:9/v2.0" })).toMatchObject({ mode: "sandbox", configured: true, liveCapable: false });
  });
  it("sandbox needs a key and a sandbox-looking base; live needs a key AND the explicit production switch, and ignores KEEPUP_BASE_URL", () => {
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "sandbox", KEEPUP_BASE_URL: "http://127.0.0.1:9" }).problems.join()).toMatch(/KEEPUP_API_KEY/);
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "sandbox", KEEPUP_API_KEY: K, KEEPUP_BASE_URL: "https://api.keepup.store/v2.0" }).configured).toBe(false);   // production host is not a sandbox
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "sandbox", KEEPUP_API_KEY: K, KEEPUP_BASE_URL: "https://random.example.com" }).configured).toBe(false);
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "live", KEEPUP_API_KEY: K })).toMatchObject({ liveCapable: false, problems: [expect.stringMatching(/ALLOW_PRODUCTION/)] });
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "live", KEEPUP_API_KEY: "short", MOVEZZ_KEEPUP_ALLOW_PRODUCTION: "true" }).liveCapable).toBe(false);
    expect(describeKeepup({ MOVEZZ_KEEPUP_MODE: "live", KEEPUP_API_KEY: K, MOVEZZ_KEEPUP_ALLOW_PRODUCTION: "true", KEEPUP_BASE_URL: "http://evil.invalid" })).toMatchObject({ mode: "live", configured: true, liveCapable: true });
  });
  it("the factory has no silent fallback: disabled/misconfigured throw; each mode yields the matching gateway kind; live uses only the fixed production base", () => {
    expect(() => createKeepupGateway({})).toThrow(/not usable/);
    expect(() => createKeepupGateway({ MOVEZZ_KEEPUP_MODE: "live", KEEPUP_API_KEY: K })).toThrow(/not usable/);
    const m = createKeepupGateway({ MOVEZZ_KEEPUP_MODE: "mock" }); expect(m).toBeInstanceOf(MockKeepupGateway); expect(m.kind).toBe("mock");
    const s = createKeepupGateway({ MOVEZZ_KEEPUP_MODE: "sandbox", KEEPUP_API_KEY: K, KEEPUP_BASE_URL: "http://127.0.0.1:9/v2.0" }); expect(s).toBeInstanceOf(HttpKeepupGateway); expect(s.kind).toBe("http-sandbox");
    const calls: string[] = []; const f = (async (u: unknown) => { calls.push(String(u)); return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    const l = createKeepupGateway({ MOVEZZ_KEEPUP_MODE: "live", KEEPUP_API_KEY: K, MOVEZZ_KEEPUP_ALLOW_PRODUCTION: "true", KEEPUP_BASE_URL: "http://evil.invalid" }, f);
    expect(l.kind).toBe("http-production"); expect(KEEPUP_PRODUCTION_BASE).toBe("https://api.keepup.store/v2.0");
    return l.createSale({ reference: "ORD-1", idempotencyKey: "invoice:x", items: [{ item_name: "a", quantity: 1, price: 1 }] }, {}).then((o) => { expect(o.kind).toBe("ambiguous"); expect(calls).toEqual([`${KEEPUP_PRODUCTION_BASE}/sales/add`]); });   // stub fetch only: nothing real is contacted
  });
});

dbDescribe("Keepup worker CLI against a local stub (sandbox mode)", () => {
  let db: TestDb; let server: http.Server; let base: string; let admin: string;
  const seen: string[] = []; let mode: "ok" | "500" | "422" = "ok"; let n = 0;
  const SCRIPT = path.join(__dirname, "..", "..", "scripts", "keepup-worker.mjs");
  const cli = (args: string[], env: Record<string, string | undefined>) => new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ACTOR_CONTEXT_KEY: process.env.ACTOR_CONTEXT_KEY, ...env } as unknown as NodeJS.ProcessEnv });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d)); c.on("close", (status) => resolve({ status, out, err }));
  });
  const sandboxEnv = () => ({ DATABASE_URL: db.appUrl, MOVEZZ_KEEPUP_MODE: "sandbox", KEEPUP_API_KEY: "sandbox-test-key", KEEPUP_BASE_URL: base });
  const mkInvoice = async () => { const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "100.00"); return (await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(admin), idempotencyKey: `kr-${Date.now()}-${++n}-abcdefgh` })).invoice; };
  const sync = async (id: string) => (await db.admin.query("SELECT sync_state, keepup_sale_id, attempt_count FROM keepup_sync WHERE invoice_id = $1", [id])).rows[0];
  beforeAll(async () => {
    db = await createTestDb(); admin = await staffUser(db.admin, "super_admin"); await packageRates(db.admin); await fxRate(db.admin);
    server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push(`${req.method} ${req.url} ${b}`);
      res.setHeader("content-type", "application/json"); if (mode === "500") { res.statusCode = 500; res.end("{}"); } else if (mode === "422") { res.statusCode = 422; res.end('{"error":"bad"}'); } else res.end(JSON.stringify({ data: { sale_id: `STUB-${seen.length}`, share_link: `https://sandbox.keepup.invalid/s/${seen.length}` } })); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2.0`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); await db?.close(); });
  beforeEach(() => { seen.length = 0; mode = "ok"; });

  it("refuses: no --once, disabled, live, mock without --allow-mock, unconfirmed remote database, no DATABASE_URL", async () => {
    const base0 = sandboxEnv();
    for (const [name, args, env, re] of [
      ["no --once", [], base0, /only --once/], ["disabled", ["--once"], { ...base0, MOVEZZ_KEEPUP_MODE: undefined }, /disabled or misconfigured/],
      ["live", ["--once"], { ...base0, MOVEZZ_KEEPUP_MODE: "live", MOVEZZ_KEEPUP_ALLOW_PRODUCTION: "true" }, /live Keepup mode is refused/], ["mock", ["--once"], { ...base0, MOVEZZ_KEEPUP_MODE: "mock" }, /needs --allow-mock/],
      ["remote db", ["--once"], { ...base0, DATABASE_URL: "postgres://u:SECRETPW@stg-db.example.invalid/movezz_staging?sslmode=verify-full", MOVEZZ_IMPORT_ENVIRONMENT: "staging" }, /Refusing remote target/],
      ["no db", ["--once"], { ...base0, DATABASE_URL: undefined }, /DATABASE_URL is not set/],
    ] as [string, string[], Record<string, string | undefined>, RegExp][]) {
      const r = await cli(args, env); expect(r.status, name).toBe(1); expect(r.err, name).toMatch(re); expect(r.err + r.out).not.toMatch(/SECRETPW|sandbox-test-key/);
    }
    expect(seen).toEqual([]);
  });
  it("syncs a queued invoice through the real HTTP adapter exactly once and records the sale; a second pass sends nothing", async () => {
    const inv = await mkInvoice(); expect((await sync(inv.id)).sync_state).toBe("pending");
    const r = await cli(["--once"], sandboxEnv()); expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ mode: "sandbox", gateway: "http-sandbox", result: { synced: 1 } });
    expect(seen).toHaveLength(1); expect(seen[0]).toContain("POST /v2.0/sales/add"); const ref = (await db.admin.query("SELECT invoice_ref FROM invoices WHERE id = $1", [inv.id])).rows[0].invoice_ref; expect(seen[0]).toContain(ref);
    expect(await sync(inv.id)).toMatchObject({ sync_state: "synced", keepup_sale_id: expect.stringMatching(/^STUB-/) });
    expect(r.out + r.err).not.toMatch(/sandbox-test-key|postgres:\/\//);
    const again = await cli(["--once"], sandboxEnv()); expect(JSON.parse(again.out).result).toMatchObject({ claimed: 0, synced: 0 }); expect(seen).toHaveLength(1);
  });
  it("an ambiguous provider answer (HTTP 500) is NOT retried and lands in reconciliation; a definite rejection (422) is failed with back-off", async () => {
    const a = await mkInvoice(); mode = "500";
    const r = await cli(["--once"], sandboxEnv()); expect(JSON.parse(r.out).result).toMatchObject({ ambiguous: 1, synced: 0 });
    expect((await sync(a.id)).sync_state).toBe("needs_reconciliation"); expect((await sync(a.id)).keepup_sale_id).toBeNull();
    mode = "ok"; seen.length = 0; const again = await cli(["--once"], sandboxEnv()); expect(JSON.parse(again.out).result.claimed).toBe(0); expect(seen).toEqual([]);   // never re-sent automatically
    const b = await mkInvoice(); mode = "422";
    const r2 = await cli(["--once"], sandboxEnv()); expect(JSON.parse(r2.out).result).toMatchObject({ failed: 1 });
    expect(await sync(b.id)).toMatchObject({ sync_state: "failed", attempt_count: 1 });
    const due = (await db.admin.query("SELECT next_retry_at > now() AS later FROM keepup_sync WHERE invoice_id = $1", [b.id])).rows[0]; expect(due.later).toBe(true);
  });
});

dbDescribe("readiness endpoint (separate from liveness)", () => {
  let db: TestDb;
  const saved: Record<string, string | undefined> = {};
  const set = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const FULL = { MOVEZZ_DATA_BACKEND: "postgres", FIREBASE_PROJECT_ID: "p", FIREBASE_CLIENT_EMAIL: "e@example.invalid", FIREBASE_PRIVATE_KEY: "k", NEXT_PUBLIC_FIREBASE_API_KEY: "a", CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s", RESEND_API_KEY: "r", EMAIL_FROM: "x@example.invalid", READINESS_TOKEN: "readiness-token-0123456789", MOVEZZ_KEEPUP_MODE: "mock", MOVEZZ_KEEPUP_REQUIRED: undefined, AIRTABLE_API_KEY: undefined, AIRTABLE_BASE_ID: undefined, ACTOR_CONTEXT_KEY: process.env.ACTOR_CONTEXT_KEY };
  const get = (token?: string) => readyGet(new NextRequest("http://localhost/api/ready", { headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } }));
  beforeAll(async () => { db = await createTestDb(); setPoolForTests(db.app); });
  afterAll(async () => { setPoolForTests(undefined); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await db?.close(); });
  beforeEach(() => { resetReadinessCache(); set(FULL); });

  it("Airtable mode: 501, nothing evaluated", async () => { set({ MOVEZZ_DATA_BACKEND: undefined }); const r = await get(); expect(r.status).toBe(501); });
  it("a MOCK Keepup is not live: not ready (503) while every database check passes; the report says why", async () => {
    const pub = await get(); expect(pub.status).toBe(503); expect(await pub.json()).toEqual({ ready: false });
    const det = await (await get("readiness-token-0123456789")).json();
    const by = (n: string) => det.checks.find((c: { name: string }) => c.name === n);
    for (const n of ["backend_is_postgres", "database_reachable", "schema_present", "runtime_role_unprivileged", "actor_signing_key_accepted_by_database", "firebase_configured", "cloudinary_configured", "email_configured"]) expect(by(n).ok, n).toBe(true);
    expect(by("keepup_live_configured")).toMatchObject({ ok: false, gating: true }); expect(det.keepup).toMatchObject({ mode: "mock", liveCapable: false, required: true });
    expect(det.notes.join(" ")).toMatch(/not proven/);
  });
  it("sandbox is not live either; only explicitly consented live configuration is 'configured' (no provider is contacted)", async () => {
    set({ MOVEZZ_KEEPUP_MODE: "sandbox", KEEPUP_API_KEY: "sandbox-key-1234", KEEPUP_BASE_URL: "http://127.0.0.1:9/v2.0" }); expect((await get()).status).toBe(503);
    resetReadinessCache(); set({ MOVEZZ_KEEPUP_MODE: "live", KEEPUP_API_KEY: "live-key-12345678", MOVEZZ_KEEPUP_ALLOW_PRODUCTION: undefined }); expect((await get()).status).toBe(503);
    resetReadinessCache(); set({ MOVEZZ_KEEPUP_ALLOW_PRODUCTION: "true" }); const r = await get(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ ready: true });
    const det = await (await get("readiness-token-0123456789")).json(); expect(det.keepup).toMatchObject({ mode: "live", liveCapable: true });
    expect(det.notes.join(" ")).toMatch(/presence only/);
  });
  it("waiving Keepup is explicit (MOVEZZ_KEEPUP_REQUIRED=false) and is reported as such", async () => {
    set({ MOVEZZ_KEEPUP_REQUIRED: "false" }); const det = await (await get("readiness-token-0123456789")).json();
    expect(det.ready).toBe(true); expect(det.keepup.required).toBe(false); expect(det.checks.find((c: { name: string }) => c.name === "keepup_live_configured")).toMatchObject({ ok: false, gating: false });
  });
  it("fails closed: wrong actor key, missing provider settings, unreachable database, privileged role", async () => {
    set({ MOVEZZ_KEEPUP_REQUIRED: "false", ACTOR_CONTEXT_KEY: Buffer.alloc(32, 7).toString("base64") }); let d = await (await get("readiness-token-0123456789")).json();
    expect(d.ready).toBe(false); expect(d.checks.find((c: { name: string }) => c.name === "actor_signing_key_accepted_by_database").ok).toBe(false);
    resetReadinessCache(); set({ ACTOR_CONTEXT_KEY: FULL.ACTOR_CONTEXT_KEY, CLOUDINARY_API_SECRET: undefined }); d = await (await get("readiness-token-0123456789")).json(); expect(d.checks.find((c: { name: string }) => c.name === "cloudinary_configured").ok).toBe(false);
    set({ CLOUDINARY_API_SECRET: "s" }); resetReadinessCache();
    const broken = { query: async () => { throw new Error("connect ECONNREFUSED postgres://u:SECRETPW@h/db"); }, connect: async () => { throw new Error("no"); } };
    const rb = await evaluateReadiness({ pool: broken as never }); expect(rb.ready).toBe(false); expect(JSON.stringify(rb)).not.toMatch(/SECRETPW|postgres:\/\//);
    const rs = await evaluateReadiness({ pool: db.admin as never }); expect(rs.checks.find((c) => c.name === "runtime_role_unprivileged")?.ok).toBe(false);   // the superuser pool is not an acceptable runtime role
  });
  it("anonymous and wrong-token callers get only {ready}; the detailed report never contains secrets, hosts or connection strings", async () => {
    set({ MOVEZZ_KEEPUP_REQUIRED: "false", DATABASE_URL: "postgres://movezz_app:SECRETPW@127.0.0.1/x", KEEPUP_API_KEY: "SECRETKEYVALUE1" });
    expect(Object.keys(await (await get("wrong-token-wrong-token")).json())).toEqual(["ready"]);
    expect(Object.keys(await (await get()).json())).toEqual(["ready"]);
    set({ READINESS_TOKEN: "short" }); expect(Object.keys(await (await get("short")).json())).toEqual(["ready"]);       // a short token is never accepted
    set({ READINESS_TOKEN: "readiness-token-0123456789" });
    const text = JSON.stringify(await (await get("readiness-token-0123456789")).json());
    expect(text).not.toMatch(/SECRETPW|SECRETKEYVALUE|postgres:\/\/|127\.0\.0\.1|readiness-token|FIREBASE_PRIVATE|api_key/i);
  });
});
