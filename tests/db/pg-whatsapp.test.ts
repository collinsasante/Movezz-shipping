// WhatsApp on the PostgreSQL backend: opt-in, after COMMIT, best effort, never duplicated by a retried identical status, never able to fail the request.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, packageRates, fxRate, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
const fb = vi.hoisted(() => ({ createFirebaseUser: vi.fn(), deleteFirebaseUser: vi.fn(async () => {}), setCustomClaims: vi.fn(async () => {}), generatePasswordResetLink: vi.fn(async () => "https://example.invalid/r") }));
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; }, ...fb }));
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: vi.fn(async () => {}), sendPasswordResetEmail: vi.fn(async () => {}), sendItemStatusEmail: vi.fn(async () => {}), sendPaymentConfirmedEmail: vi.fn(async () => {}), sendPartialPaymentEmail: vi.fn(async () => {}) }));
import { POST as customersPost } from "../../src/app/api/customers/route";
import { POST as itemsPost } from "../../src/app/api/items/route";
import { PATCH as itemStatus } from "../../src/app/api/items/[id]/status/route";
import { POST as ordersPost } from "../../src/app/api/orders/route";

function req(url: string, method: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = <T extends Record<string, string>>(o: T) => ({ params: Promise.resolve(o) });

dbDescribe("WhatsApp notifications (PostgreSQL backend)", () => {
  let db: TestDb; const realFetch = globalThis.fetch; const sent: { to: string; body: string }[] = []; let mode: "ok" | "http500" | "throw" = "ok";
  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres"; process.env.WHATSAPP_ACCESS_TOKEN = "test-only"; process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const u = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
      if (!u.includes("graph.facebook.com")) throw new Error(`unexpected network call ${u}`);
      if (mode === "throw") throw new Error("network down");
      if (mode === "http500") return new Response("{}", { status: 500 });
      const b = JSON.parse(init?.body ?? "{}"); sent.push({ to: b.to, body: b.text.body }); return new Response("{}", { status: 200 });
    }) as typeof fetch;
    db = await createTestDb(); setPoolForTests(db.app); await packageRates(db.admin, "basic", "350", "8"); await fxRate(db.admin);
    await db.admin.query(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin'),('fb-staff','staff@example.invalid','warehouse_staff')`);
    tokens.set("t-admin", { uid: "fb-admin", emailVerified: true }); tokens.set("t-staff", { uid: "fb-staff", emailVerified: true });
  });
  afterAll(async () => { globalThis.fetch = realFetch; delete process.env.MOVEZZ_DATA_BACKEND; delete process.env.WHATSAPP_ACCESS_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID; setPoolForTests(undefined); await db?.close(); });

  it("welcome message after customer creation; a provider failure never fails the request", async () => {
    fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-c1" });
    const r = await customersPost(req("/api/customers", "POST", { token: "t-admin", body: { name: "Esi Boateng", phone: "+233 20 111 2223", email: "esi@example.invalid" } }));
    expect(r.status).toBe(201); const c = (await r.json()).data.customer;
    expect(sent).toHaveLength(1); expect(sent[0].to).toBe("233201112223"); expect(sent[0].body).toContain(c.shippingMark); expect(sent[0].body).toContain("https://example.invalid/r");
    mode = "http500"; fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-c2" });
    expect((await customersPost(req("/api/customers", "POST", { token: "t-admin", body: { name: "Kojo Mensah", phone: "0244555666", email: "kojo@example.invalid" } }))).status).toBe(201);
    mode = "throw"; fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-c3" });
    expect((await customersPost(req("/api/customers", "POST", { token: "t-admin", body: { name: "Yaw Owusu", phone: "0244777888", email: "yaw@example.invalid" } }))).status).toBe(201);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM customers")).rows[0].n).toBe(3);   // all committed regardless of delivery
    mode = "ok";
  });

  it("item status: opt-in, needs an invoice, sent once per real change, never on a retry, failures do not roll back", async () => {
    const cust = (await db.admin.query("SELECT id FROM customers WHERE email = 'esi@example.invalid'")).rows[0].id;
    const mk = async () => (await (await itemsPost(req("/api/items", "POST", { token: "t-staff", body: { customerId: cust, dateReceived: "2026-05-01", shippingType: "sea", length: 100, width: 100, height: 100, description: "box" } }))).json()).data;
    const [a, b] = [await mk(), await mk()];
    const st = (id: string, status: string, sendWhatsApp?: boolean) => itemStatus(req("", "PATCH", { token: "t-staff", body: { status, ...(sendWhatsApp === undefined ? {} : { sendWhatsApp }) } }), ctx({ id }));
    sent.length = 0;
    expect((await st(a.id, "Sorting", true)).status).toBe(200); expect(sent).toHaveLength(0);               // not invoiced yet -> nothing to say
    expect((await ordersPost(req("/api/orders", "POST", { token: "t-admin", body: { customerId: cust, itemIds: [a.id] } }))).status).toBe(201);
    expect((await st(a.id, "Ready for Pickup", true)).status).toBe(200); expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("Ready for Pickup");
    expect((await st(a.id, "Ready for Pickup", true)).status).toBe(200); expect(sent).toHaveLength(1);       // retried/duplicate request: no second message
    expect((await st(a.id, "Completed")).status).toBe(200); expect(sent).toHaveLength(1);                    // flag omitted -> default off
    expect((await st(b.id, "Sorting", true)).status).toBe(200); expect(sent).toHaveLength(1);                // b is not invoiced
    // a failing provider after COMMIT must not undo the status change
    const c2 = await mk(); expect((await ordersPost(req("/api/orders", "POST", { token: "t-admin", body: { customerId: cust, itemIds: [c2.id] } }))).status).toBe(201);
    mode = "throw"; expect((await st(c2.id, "Sorting", true)).status).toBe(200); mode = "http500"; expect((await st(c2.id, "Ready for Pickup", true)).status).toBe(200); mode = "ok";
    expect((await db.admin.query("SELECT status FROM items WHERE id = $1", [c2.id])).rows[0].status).toBe("Ready for Pickup");
    expect(sent).toHaveLength(1);
  });
});
