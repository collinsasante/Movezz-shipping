// Airtable independence on the PostgreSQL backend: with every AIRTABLE_* variable removed, the `airtable` package replaced by a
// stub that counts (and refuses) any use, and api.airtable.com unreachable, the core workflow must run unchanged and make ZERO
// Airtable calls. This proves the code path; it does NOT replace the cutover criteria in docs/AIRTABLE-EXIT.md (staging, data, approval).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, packageRates, fxRate, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";

const airtableUse = vi.hoisted(() => ({ constructed: 0, calls: [] as string[] }));
vi.mock("airtable", () => {
  class Airtable { constructor() { airtableUse.constructed++; throw new Error("Airtable must not be used on the PostgreSQL backend"); } static configure() { airtableUse.constructed++; } }
  return { default: Airtable, Airtable };
});
const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
const fb = vi.hoisted(() => ({ createFirebaseUser: vi.fn(), deleteFirebaseUser: vi.fn(async () => {}), setCustomClaims: vi.fn(async () => {}), generatePasswordResetLink: vi.fn(async () => "https://example.invalid/r") }));
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; }, ...fb }));
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: vi.fn(async () => {}), sendPasswordResetEmail: vi.fn(async () => {}), sendItemStatusEmail: vi.fn(async () => {}), sendPaymentConfirmedEmail: vi.fn(async () => {}), sendPartialPaymentEmail: vi.fn(async () => {}) }));

import { POST as customersPost } from "../../src/app/api/customers/route";
import { POST as itemsPost } from "../../src/app/api/items/route";
import { PATCH as itemStatus } from "../../src/app/api/items/[id]/status/route";
import { POST as ordersPost } from "../../src/app/api/orders/route";
import { PATCH as orderPatch } from "../../src/app/api/orders/[id]/route";
import { GET as adminDash } from "../../src/app/api/dashboard/admin/route";
import { GET as reportsGet } from "../../src/app/api/reports/route";
import { GET as settingsGet } from "../../src/app/api/settings/route";
import { GET as activityGet } from "../../src/app/api/activity-logs/route";

function req(url: string, method: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = <T extends Record<string, string>>(o: T) => ({ params: Promise.resolve(o) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("PostgreSQL backend runs with Airtable removed", () => {
  let db: TestDb; const saved: Record<string, string | undefined> = {}; const realFetch = globalThis.fetch; const fetched: string[] = [];
  beforeAll(async () => {
    for (const k of ["AIRTABLE_API_KEY", "AIRTABLE_BASE_ID", "AIRTABLE_PERSONAL_ACCESS_TOKEN"]) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-only"; process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    globalThis.fetch = (async (input: unknown) => {
      const u = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input); fetched.push(u);
      if (/airtable/i.test(u)) throw new Error("api.airtable.com unreachable");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    db = await createTestDb(); setPoolForTests(db.app); await packageRates(db.admin, "basic", "350", "8"); await fxRate(db.admin);
    await db.admin.query(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin'),('fb-staff','staff@example.invalid','warehouse_staff')`);
    tokens.set("t-admin", { uid: "fb-admin", emailVerified: true }); tokens.set("t-staff", { uid: "fb-staff", emailVerified: true });
  });
  afterAll(async () => {
    globalThis.fetch = realFetch; delete process.env.MOVEZZ_DATA_BACKEND; delete process.env.WHATSAPP_ACCESS_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    setPoolForTests(undefined); await db?.close();
  });

  it("customer -> item -> invoice -> payment -> status (+WhatsApp) -> dashboards/reports with zero Airtable use", async () => {
    expect(process.env.AIRTABLE_API_KEY).toBeUndefined(); expect(process.env.AIRTABLE_BASE_ID).toBeUndefined();
    fb.createFirebaseUser.mockResolvedValueOnce({ uid: "fb-new-customer" });
    const created = await json(await customersPost(req("/api/customers", "POST", { token: "t-admin", body: { name: "Esi Boateng", phone: "+233201112223", email: "esi@example.invalid" } })));
    expect(created.status).toBe(201); const custId = created.body.data.customer.id;
    const item = (await json(await itemsPost(req("/api/items", "POST", { token: "t-staff", body: { customerId: custId, dateReceived: "2026-05-01", shippingType: "sea", length: 100, width: 100, height: 100, description: "box" } })))).body.data;
    const order = await json(await ordersPost(req("/api/orders", "POST", { token: "t-admin", body: { customerId: custId, itemIds: [item.id] } })));
    expect(order.status).toBe(201); const id = order.body.data.id;
    expect((await orderPatch(req("", "PATCH", { token: "t-admin", body: { paymentAmount: 1000 } }), ctx({ id }))).status).toBe(200);
    expect((await itemStatus(req("", "PATCH", { token: "t-staff", body: { status: "Sorting", sendWhatsApp: true } }), ctx({ id: item.id }))).status).toBe(200);
    for (const [fn, url] of [[adminDash, "/api/dashboard/admin"], [reportsGet, "/api/reports"], [settingsGet, "/api/settings"], [activityGet, "/api/activity-logs"]] as const)
      expect((await (fn as (r: NextRequest) => Promise<Response>)(req(url, "GET", { token: "t-admin" }))).status, url).toBe(200);
    await vi.waitFor(() => expect(fetched.some((u) => u.includes("graph.facebook.com"))).toBe(true));   // WhatsApp goes through its own sender, not Airtable
    expect(airtableUse.constructed).toBe(0);
    expect(fetched.filter((u) => /airtable/i.test(u))).toEqual([]);
  });
});
