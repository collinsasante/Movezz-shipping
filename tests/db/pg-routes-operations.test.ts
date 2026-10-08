// Phase 7L Group B through the REAL route handlers (MOVEZZ_DATA_BACKEND=postgres): items, cartons, containers, sorting.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dbDescribe, createTestDb, customer, packageRates, fxRate, specialRate, type TestDb } from "./helpers";
import { setPoolForTests } from "../../src/lib/db/client";
import { createInvoice } from "../../src/lib/db/invoices";
import { user } from "../../src/lib/db/actor";

const tokens = new Map<string, { uid: string; emailVerified: boolean }>();
vi.mock("@/lib/firebase-admin", () => ({ verifyIdToken: async (t: string) => { const v = tokens.get(t); if (!v) throw new Error("bad token"); return { sub: v.uid, ...v }; } }));
vi.mock("@/lib/email", () => ({ sendItemStatusEmail: vi.fn(async () => {}) }));

import { GET as itemsGet, POST as itemsPost } from "../../src/app/api/items/route";
import { GET as itemGet, PATCH as itemPatch, DELETE as itemDelete } from "../../src/app/api/items/[id]/route";
import { PATCH as itemStatus } from "../../src/app/api/items/[id]/status/route";
import { GET as itemHistory } from "../../src/app/api/items/[id]/history/route";
import { GET as sortingGet, POST as sortingPost } from "../../src/app/api/sorting/route";
import { GET as cartonsGet, POST as cartonsPost } from "../../src/app/api/cartons/route";
import { PATCH as cartonPatch, DELETE as cartonDelete } from "../../src/app/api/cartons/[cartonNumber]/route";
import { GET as containersGet, POST as containersPost } from "../../src/app/api/containers/route";
import { GET as containerGet, PATCH as containerPatch, DELETE as containerDelete } from "../../src/app/api/containers/[id]/route";
import { POST as cItemsPost, DELETE as cItemsDelete } from "../../src/app/api/containers/[id]/items/route";
import { PATCH as cStatus } from "../../src/app/api/containers/[id]/status/route";
import { POST as cSync } from "../../src/app/api/containers/[id]/sync-items/route";

function req(url: string, method: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": "198.51.100.9" };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = <T extends Record<string, string>>(o: T) => ({ params: Promise.resolve(o) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

dbDescribe("Group B on PostgreSQL: items, cartons, containers, sorting (real routes)", () => {
  let db: TestDb; let n = 0; let custA: string, custB: string, adminId: string, cardId: string;
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const tok = (uid: string) => { const t = `t-${uid}-${++n}`; tokens.set(t, { uid, emailVerified: true }); return t; };
  let admin: string, staff: string, ca: string, cb: string;
  const item = async (token: string, over: Record<string, unknown> = {}, cust = custA) => json(await itemsPost(req("/api/items", "POST", { token, body: { customerId: cust, dateReceived: "2026-03-01", description: "box", shippingType: "sea", length: 100, width: 100, height: 100, ...over } })));

  beforeAll(async () => {
    process.env.MOVEZZ_DATA_BACKEND = "postgres";
    db = await createTestDb(); setPoolForTests(db.app);
    await packageRates(db.admin, "basic", "350", "8"); await fxRate(db.admin);
    adminId = (await q(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-admin','admin@example.invalid','super_admin') RETURNING id`))[0].id;
    await q(`INSERT INTO users (auth_uid,email,role) VALUES ('fb-staff','staff@example.invalid','warehouse_staff')`);
    custA = await customer(db.admin); custB = await customer(db.admin);
    await q(`INSERT INTO users (auth_uid,email,role,customer_id) VALUES ('fb-ca','ca@example.invalid','customer',$1),('fb-cb','cb@example.invalid','customer',$2)`, [custA, custB]);
    cardId = await specialRate(db.admin, { name: "VIP sea", customer_id: custA, sea_rate_usd: 300 });
    admin = tok("fb-admin"); staff = tok("fb-staff"); ca = tok("fb-ca"); cb = tok("fb-cb");
  });
  afterAll(async () => { delete process.env.MOVEZZ_DATA_BACKEND; setPoolForTests(undefined); await db?.close(); });

  describe("items", () => {
    it("staff receive items; the server prices them and ignores client prices; customers cannot create", async () => {
      const r = await item(staff, { estPrice: 1, pkgEstShipping: 1, estShippingPrice: 1, specialShippingRate: 1 });
      expect(r.status).toBe(201); expect(r.body.data).toMatchObject({ itemRef: expect.stringMatching(/^ITM-/), customerId: custA, status: "Arrived at Transit Warehouse", pkgEstShipping: 350, pkgShippingRate: 350 });
      expect((await item(ca)).status).toBe(403);
      expect((await itemsPost(req("/api/items", "POST", { body: {} }))).status).toBe(401);
      expect((await item(staff, { customerId: "nope" })).status).toBe(400);
      expect((await item(staff, { dateReceived: "yesterday" })).status).toBe(400);
      expect((await item(staff, { weight: -1 })).status).toBe(400);
      const unpriced = await item(staff, { length: undefined, width: undefined, height: undefined, shippingType: undefined });      // no measurements yet: stored, not priced
      expect(unpriced.status).toBe(201); expect(unpriced.body.data.pkgEstShipping).toBeUndefined();
    });
    it("special items use an explicitly chosen, server-validated rate card; an invalid explicit choice never falls back to the tier price", async () => {
      const ok = await item(staff, { isSpecialItem: true, specialRateName: "VIP sea" });
      expect(ok.status).toBe(201); expect(ok.body.data).toMatchObject({ isSpecialItem: true, specialRateName: "VIP sea", specialShippingRate: 300 });
      expect((await item(staff, { isSpecialItem: true, specialRateName: "No such card" })).status).toBe(404);
      expect((await item(staff, { isSpecialItem: true, specialRateName: "VIP sea" }, custB)).status).toBe(404);     // another customer's card
      expect((await item(staff, { isSpecialItem: true })).status).toBe(400);
      expect((await q("SELECT count(*)::int AS n FROM items WHERE customer_id = $1", [custB]))[0].n).toBe(0);
    });
    it("ownership: a customer lists and reads only their own items (IDOR/BOLA -> 404), whatever the query says", async () => {
      const mine = (await item(staff, {}, custA)).body.data.id; const theirs = (await item(staff, {}, custB)).body.data.id;
      const list = await json(await itemsGet(req(`/api/items?customerId=${custB}`, "GET", { token: ca })));
      expect(list.status).toBe(200); expect(list.body.data.length).toBeGreaterThan(0); expect(list.body.data.every((i: { customerId: string }) => i.customerId === custA)).toBe(true);
      expect((await itemGet(req(`/api/items/${mine}`, "GET", { token: ca }), ctx({ id: mine }))).status).toBe(200);
      expect((await itemGet(req(`/api/items/${theirs}`, "GET", { token: ca }), ctx({ id: theirs }))).status).toBe(404);
      expect((await itemGet(req("/api/items/zz", "GET", { token: ca }), ctx({ id: "zz" }))).status).toBe(404);
      expect((await itemHistory(req(`/api/items/${theirs}/history`, "GET", { token: ca }), ctx({ id: theirs }))).status).toBe(404);
      const staffList = await json(await itemsGet(req(`/api/items?customerId=${custB}&search=box`, "GET", { token: staff })));
      expect(staffList.body.data.every((i: { customerId: string }) => i.customerId === custB)).toBe(true);
    });
    it("updates: staff edit measurements and the price follows the database rate; customers and prices cannot be forged; only admin reassigns or deletes", async () => {
      const id = (await item(staff)).body.data.id;
      const p = await json(await itemPatch(req(`/api/items/${id}`, "PATCH", { token: staff, body: { length: 50, width: 100, height: 100, notes: "dented" } }), ctx({ id })));
      expect(p.status).toBe(200); expect(p.body.data).toMatchObject({ notes: "dented", pkgEstShipping: 175 });
      expect((await itemPatch(req(`/api/items/${id}`, "PATCH", { token: staff, body: { customerId: custB } }), ctx({ id }))).status).toBe(403);
      expect((await itemPatch(req(`/api/items/${id}`, "PATCH", { token: ca, body: { notes: "x" } }), ctx({ id }))).status).toBe(403);
      expect((await itemPatch(req(`/api/items/${id}`, "PATCH", { token: staff, body: { orderId: "something" } }), ctx({ id }))).status).toBe(400);
      expect((await itemPatch(req(`/api/items/${id}`, "PATCH", { token: admin, body: { customerId: custB } }), ctx({ id }))).status).toBe(200);
      expect((await itemDelete(req(`/api/items/${id}`, "DELETE", { token: staff }), ctx({ id }))).status).toBe(403);
      expect((await itemDelete(req(`/api/items/${id}`, "DELETE", { token: admin }), ctx({ id }))).status).toBe(200);
      expect((await itemGet(req(`/api/items/${id}`, "GET", { token: admin }), ctx({ id }))).status).toBe(404);
      expect((await q("SELECT archived_at FROM items WHERE id = $1", [id]))[0].archived_at).not.toBeNull();   // never physically deleted
    });
    it("status: staff move forward only, 'Shipped' needs a container, history records the verified actor; customers see history without staff e-mails", async () => {
      const id = (await item(staff)).body.data.id;
      const st = (token: string, status: string) => itemStatus(req(`/api/items/${id}/status`, "PATCH", { token, body: { status } }), ctx({ id }));
      expect((await st(staff, "Shipped to Ghana")).status).toBe(400);
      expect((await st(ca, "Sorting")).status).toBe(403);
      expect((await st(staff, "Sorting")).status).toBe(200);
      expect((await st(staff, "Arrived in Ghana")).status).toBe(400);                 // backwards
      expect((await st(admin, "Arrived in Ghana")).status).toBe(200);                 // admin may correct
      expect((await st(staff, "Bogus")).status).toBe(400);
      const h = await json(await itemHistory(req(`/api/items/${id}/history`, "GET", { token: staff }), ctx({ id })));
      expect(h.body.data.map((e: { newStatus: string }) => e.newStatus)).toEqual(["Arrived at Transit Warehouse", "Sorting", "Arrived in Ghana"]);
      expect(h.body.data[1].changedBy).toBe("staff@example.invalid");
      const hc = await json(await itemHistory(req(`/api/items/${id}/history`, "GET", { token: ca }), ctx({ id })));
      expect(JSON.stringify(hc.body)).not.toMatch(/example\.invalid/);
    });
    it("sorting: found moves to Ready for Pickup and clears the flag; missing flags the item; customers are refused", async () => {
      const id = (await item(staff)).body.data.id;
      await itemStatus(req(`/api/items/${id}/status`, "PATCH", { token: staff, body: { status: "Sorting" } }), ctx({ id }));
      const list = await json(await sortingGet(req("/api/sorting?missing=true", "GET", { token: staff })));
      expect(list.body.data.sorting.some((i: { id: string }) => i.id === id)).toBe(true);
      expect((await sortingPost(req("/api/sorting", "POST", { token: staff, body: { itemId: id, action: "missing" } }))).status).toBe(200);
      const found = await json(await sortingPost(req("/api/sorting", "POST", { token: staff, body: { itemId: id, action: "found" } })));
      expect(found.body.data).toMatchObject({ status: "Ready for Pickup", isMissing: false });
      expect((await sortingGet(req("/api/sorting", "GET", { token: ca }))).status).toBe(403);
    });
  });

  describe("containers", () => {
    it("only a super_admin creates containers; the reference sequence is global and unique under concurrency", async () => {
      const mk = (token: string, no: string) => containersPost(req("/api/containers", "POST", { token, body: { trackingNumber: no, name: "MSC" } }));
      expect((await mk(staff, "X1")).status).toBe(403);
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => mk(admin, `CN${i}`)));
      expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
      const refs = (await Promise.all(rs.map((r) => json(r)))).map((x) => x.body.data.containerId as string);
      expect(new Set(refs).size).toBe(6); for (const r of refs) expect(r).toMatch(/^PMX-CON-\d{4}-\d{3}$/);
      const nums = refs.map((r) => Number(r.slice(-3))).sort((a, b) => a - b);
      expect(nums[5] - nums[0]).toBe(5);                                              // consecutive: nothing skipped, nothing repeated
      expect((await containersPost(req("/api/containers", "POST", { token: admin, body: {} }))).status).toBe(400);
      expect((await containersGet(req("/api/containers", "GET", { token: ca }))).status).toBe(403);
      expect((await containersGet(req("/api/containers?search=CN1", "GET", { token: staff }))).status).toBe(200);
    });
    it("loading, shipping and arrival: items join one container only; status cascades advance-only and never touches missing items", async () => {
      const cid = (await json(await containersPost(req("/api/containers", "POST", { token: admin, body: { trackingNumber: "CASC1" } })))).body.data.id;
      const other = (await json(await containersPost(req("/api/containers", "POST", { token: admin, body: { trackingNumber: "CASC2" } })))).body.data.id;
      const a = (await item(staff)).body.data.id, b = (await item(staff)).body.data.id, m = (await item(staff)).body.data.id, done = (await item(staff)).body.data.id;
      for (const i of [a, b, m, done]) expect((await cItemsPost(req("", "POST", { token: staff, body: { itemId: i } }), ctx({ id: cid }))).status).toBe(200);
      expect((await cItemsPost(req("", "POST", { token: staff, body: { itemId: a } }), ctx({ id: other }))).status).toBe(400);   // already in another container
      await itemPatch(req(`/api/items/${m}`, "PATCH", { token: staff, body: { isMissing: true } }), ctx({ id: m }));
      await itemStatus(req("", "PATCH", { token: admin, body: { status: "Completed" } }), ctx({ id: done }));
      expect((await cStatus(req("", "PATCH", { token: staff, body: { status: "Shipped to Ghana" } }), ctx({ id: cid }))).status).toBe(403);
      const sh = await json(await cStatus(req("", "PATCH", { token: admin, body: { status: "Shipped to Ghana" } }), ctx({ id: cid })));
      expect(sh.status).toBe(200);
      const arr = await json(await cStatus(req("", "PATCH", { token: admin, body: { status: "Arrived in Ghana", arrivalDate: "2026-04-02" } }), ctx({ id: cid })));
      expect(arr.body.data).toMatchObject({ status: "Arrived in Ghana", arrivalDate: "2026-04-02" });
      const st = async (i: string) => (await q("SELECT status FROM items WHERE id = $1", [i]))[0].status;
      expect(await st(a)).toBe("Awaiting Customs Clearance & Duty Process"); expect(await st(b)).toBe("Awaiting Customs Clearance & Duty Process");
      expect(await st(m)).toBe("Arrived at Transit Warehouse"); expect(await st(done)).toBe("Completed");                    // missing and completed untouched
      const sync = await json(await cSync(req("", "POST", { token: admin }), ctx({ id: cid })));
      expect(sync.body.updated).toBe(0);
      const detail = await json(await containerGet(req("", "GET", { token: staff }), ctx({ id: cid })));
      expect(detail.body.data.items.length).toBe(4); expect(detail.body.data.items[0].customerName).toBeTruthy();
      expect((await containerDelete(req("", "DELETE", { token: admin }), ctx({ id: cid }))).status).toBe(409);               // not while it holds items
      expect((await cItemsDelete(req("", "DELETE", { token: staff, body: { itemId: a } }), ctx({ id: cid }))).status).toBe(200);
      expect((await json(await containerPatch(req("", "PATCH", { token: admin, body: { notes: "sealed" } }), ctx({ id: cid })))).body.data.notes).toBe("sealed");
      expect((await containerPatch(req("", "PATCH", { token: staff, body: { notes: "x" } }), ctx({ id: cid }))).status).toBe(403);
    });
  });

  describe("cartons", () => {
    it("a carton is priced from the database tier rate; membership rules hold; invoiced cartons are immutable and released on cancellation", async () => {
      const i1 = (await item(staff)).body.data.id, i2 = (await item(staff)).body.data.id, other = (await item(staff, {}, custB)).body.data.id, special = (await item(staff, { isSpecialItem: true, specialRateName: "VIP sea" })).body.data.id;
      const mk = async (body: unknown, token = staff) => json(await cartonsPost(req("/api/cartons", "POST", { token, body })));
      const dims = { length: 100, width: 100, height: 50 };
      expect((await mk({ customerId: custA, itemIds: [i1, other], ...dims })).status).toBe(400);               // someone else's item
      expect((await mk({ customerId: custA, itemIds: [special], ...dims })).status).toBe(400);                 // special-rate items cannot be repacked
      expect((await mk({ customerId: custA, itemIds: [i1], ...dims }, ca)).status).toBe(403);
      const c = await mk({ customerId: custA, itemIds: [i1, i2], ...dims });
      expect(c.status).toBe(201); expect(c.body.data).toMatchObject({ cartonNumber: expect.stringMatching(/^CTN-/), cbm: 0.5, totalPrice: 175 });
      const ref = c.body.data.cartonNumber as string;
      expect((await mk({ customerId: custA, itemIds: [i1], ...dims })).status).toBe(400);                      // already in a carton
      const bigger = await json(await cartonPatch(req("", "PATCH", { token: staff, body: { height: 100 } }), ctx({ cartonNumber: ref })));
      expect(bigger.body.data.totalPrice).toBe(350);
      const rm = await json(await cartonPatch(req("", "PATCH", { token: staff, body: { removeItemIds: [i2] } }), ctx({ cartonNumber: ref })));
      expect(rm.body.data.items.length).toBe(1);
      const list = await json(await cartonsGet(req("/api/cartons", "GET", { token: staff })));
      expect(list.body.data.some((x: { cartonNumber: string }) => x.cartonNumber === ref)).toBe(true);
      expect((await cartonsGet(req("/api/cartons", "GET", { token: ca }))).status).toBe(403);

      const cartonId = (await q("SELECT id FROM cartons WHERE carton_ref = $1", [ref]))[0].id;
      const { invoice } = await createInvoice(db.app, { customerId: custA, cartonIds: [cartonId], actor: user(adminId), idempotencyKey: `k-${Date.now()}-abcdefgh` });
      expect((await cartonPatch(req("", "PATCH", { token: staff, body: { height: 10 } }), ctx({ cartonNumber: ref }))).status).toBe(409);
      expect((await cartonDelete(req("", "DELETE", { token: staff }), ctx({ cartonNumber: ref }))).status).toBe(409);
      expect((await itemPatch(req(`/api/items/${i1}`, "PATCH", { token: staff, body: { length: 5 } }), ctx({ id: i1 }))).status).toBe(409);   // invoiced items are frozen
      await db.admin.query("SELECT 1");
      const { cancelInvoice } = await import("../../src/lib/db/invoices");
      await cancelInvoice(db.app, { invoiceId: invoice.id, reason: "test cancel", actor: user(adminId), idempotencyKey: `c-${Date.now()}-abcdefgh` } as never);
      expect((await cartonDelete(req("", "DELETE", { token: staff }), ctx({ cartonNumber: ref }))).status).toBe(200);                          // released, so it can now be dissolved
      expect((await q("SELECT carton_id FROM items WHERE id = $1", [i1]))[0].carton_id).toBeNull();
    });
  });
  void cb; void cardId;
});
