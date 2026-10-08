// Table-driven authorization characterization: every route handler x every role, against the CURRENT guards.
// Allowed means "got past authentication/authorization" (status is neither 401 nor 403); the handler may still
// legitimately answer 400/404/500 because the request body is intentionally minimal.
import { describe, it, expect } from "vitest";
import { standardWorld, listRouteMethods, type Role } from "../helpers/world";
import { MATRIX } from "./authz-matrix";
import { FIXED } from "../helpers/known";

const ROLES: Role[] = ["super_admin", "warehouse_staff", "customer"];

describe("authorization matrix: completeness", () => {
  it("covers every exported route handler, and nothing that no longer exists", async () => {
    await standardWorld(); // module registry with mocks in place
    const actual = (await listRouteMethods()).map((e) => `${e.method} ${e.route}`);
    const declared = MATRIX.map((e) => `${e.method} ${e.route}`).sort();
    expect(actual.sort()).toEqual(declared);
  });
});

describe("authorization matrix: current behavior", () => {
  const PARAMS = { id: "recMissing", cartonNumber: "CTN-9999" };
  // GET/PATCH /api/customers/[id] check ownership before looking anything up, so the customer role
  // must be given its OWN id to reach the handler. DELETE keeps the missing id so nothing real is deleted.
  const paramsFor = (route: string, method: string) =>
    route === "customers/[id]" && (method === "GET" || method === "PATCH") ? { ...PARAMS, id: "recCustA" } : PARAMS;

  for (const entry of MATRIX) {
    const label = `${entry.method} /api/${entry.route}`;

    if (entry.guard === "public") {
      it(`${label} is public (no 401/403 for an anonymous caller${entry.route === "auth/verify-cookie" ? ", except its own 401 for a missing cookie" : ""})`, async () => {
        const { w } = await standardWorld();
        const res = await w.call(entry.route, entry.method, { params: PARAMS, body: entry.method === "GET" ? undefined : {} });
        if (entry.route === "auth/verify-cookie") expect(res.status).toBe(401);
        else expect([401, 403]).not.toContain(res.status);
      });
      continue;
    }

    it(`${label} -> anonymous 401; allowed: ${entry.guard.join(", ")}`, async () => {
      const s = await standardWorld();
      const tokens: Record<Role, string> = { super_admin: s.admin, warehouse_staff: s.staff, customer: s.custA };
      const anon = await s.w.call(entry.route, entry.method, { params: PARAMS, body: entry.method === "GET" ? undefined : {} });
      expect(anon.status, "anonymous").toBe(401);
      for (const role of ROLES) {
        const res = await s.w.call(entry.route, entry.method, { token: tokens[role], params: paramsFor(entry.route, entry.method), body: entry.method === "GET" ? undefined : {} });
        if (entry.guard.includes(role)) expect([401, 403], `${role} should be allowed`).not.toContain(res.status);
        else expect(res.status, `${role} should be denied`).toBe(403);
      }
    });
  }
});

describe(FIXED("permissions aligned with the approved role matrix (Phase 7F: D6, D7, D10)"), () => {
  // These were recorded as "documents what is allowed today" while decisions Q9/Q10 were open. They are now decided
  // (docs/DECISIONS.md D6/D7) and the tests assert the approved behavior.
  it(FIXED("warehouse staff can NOT write package rates or special rates (they decide every price)"), async () => {
    const { w, staff, admin } = await standardWorld();
    const rates = { basic: { sea: 1, air: 1 }, business: { sea: 1, air: 1 }, enterprise: { sea: 1, air: 1 }, special: { sea: 1, air: 1 } };
    expect((await w.call("package-rates", "PUT", { token: staff, body: rates })).status).toBe(403);
    expect((await w.call("special-rates", "POST", { token: staff, body: { name: "Bulk", sea: 100, air: 5 } })).status).toBe(403);
    const created = await w.call("special-rates", "POST", { token: admin, body: { name: "Bulk", sea: 100, air: 5 } });
    const id = created.json?.data.id as string;
    expect((await w.call("special-rates/[id]", "PATCH", { token: staff, params: { id }, body: { name: "Bulk", sea: 1, air: 1 } })).status).toBe(403);
    expect((await w.call("special-rates/[id]", "DELETE", { token: staff, params: { id } })).status).toBe(403);
    expect(w.db.get("SpecialRates", id)?.fields).toMatchObject({ Sea: 100, Air: 5 });
    expect(w.db.all("PackageRates")).toHaveLength(0);
  });
  it(FIXED("warehouse staff can NOT create or edit warehouses (warehouse configuration is super_admin only, D6)"), async () => {
    const { w, staff, admin } = await standardWorld();
    expect((await w.call("warehouses", "POST", { token: staff, body: { name: "Depot", address: "1 Main St" } })).status).toBe(403);
    const created = await w.call("warehouses", "POST", { token: admin, body: { name: "Depot", address: "1 Main St" } });
    expect(created.status).toBe(201);
    expect((await w.call("warehouses/[id]", "PATCH", { token: staff, params: { id: created.json?.data.id }, body: { address: "2 Main St" } })).status).toBe(403);
    expect(w.db.get("Warehouses", created.json?.data.id)?.fields["Address"]).toBe("1 Main St");
  });
  it(FIXED("warehouse staff can NOT read revenue reports (D6); the exchange-rate setting remains readable for operational display"), async () => {
    const { w, staff, admin } = await standardWorld();
    expect((await w.call("reports", "GET", { token: staff })).status).toBe(403);
    expect((await w.call("reports", "GET", { token: admin })).status).toBe(200);
    expect((await w.call("settings", "GET", { token: staff })).status).toBe(200);
  });
  it(FIXED("customers can NOT read special-rate cards (other customers' names and prices); package tiers stay readable"), async () => {
    const { w, custA } = await standardWorld();
    w.seed.specialRate("recSR1", "VIP Confidential", 1, 1);
    expect((await w.call("special-rates", "GET", { token: custA })).status).toBe(403);
    const pr = await w.call("package-rates", "GET", { token: custA });
    expect(Object.keys(pr.json?.data).sort()).toEqual(["basic", "business", "enterprise", "special"]);
  });
  it(FIXED("a customer can NOT change their own name or phone (D7: address and notes only); the shipping mark is untouched"), async () => {
    const { w, custA } = await standardWorld();
    const res = await w.call("customers/[id]", "PATCH", { token: custA, params: { id: "recCustA" }, body: { name: "Zed Zulu", phone: "0200009876" } });
    expect(res.status).toBe(400);
    expect(w.db.get("Customers", "recCustA")?.fields["Name"]).not.toBe("Zed Zulu");
    expect(w.db.get("Customers", "recCustA")?.fields["ShippingMark"]).toBe("MOVEZZ-AM1111");
  });
});
