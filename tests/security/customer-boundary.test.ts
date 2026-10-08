// Ownership boundary of EVERY route a customer can reach (taken from the authorization matrix):
//   customer A -> customer A data = allowed ; customer A -> customer B data = denied ; customer without customer_id = denied.
import { describe, it, expect } from "vitest";
import { standardWorld, type HttpMethod } from "../helpers/world";
import { MATRIX } from "./authz-matrix";
import { PRESERVE } from "../helpers/known";

const customerRoutes = MATRIX.filter((e) => e.guard !== "public" && e.guard.includes("customer"));

interface Probe {
  route: string;
  method: HttpMethod;
  own: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> };
  /** Another customer's object. Absent for routes that have no object id (lists scope themselves). */
  other?: { params?: Record<string, string>; body?: unknown };
  /** Statuses that mean "denied". */
  denied?: number[];
}

const PROBES: Probe[] = [
  { route: "customers/[id]", method: "GET", own: { params: { id: "recCustA" } }, other: { params: { id: "recCustB" } }, denied: [404] },
  { route: "customers/[id]", method: "PATCH", own: { params: { id: "recCustA" }, body: { notes: "mine" } }, other: { params: { id: "recCustB" }, body: { notes: "pwned" } }, denied: [404] },
  { route: "dashboard/customer", method: "GET", own: {} },
  { route: "items", method: "GET", own: {} },
  { route: "items/[id]", method: "GET", own: { params: { id: "recIA" } }, other: { params: { id: "recIB" } }, denied: [404] },
  { route: "items/[id]/history", method: "GET", own: { params: { id: "recIA" } }, other: { params: { id: "recIB" } }, denied: [404] },
  { route: "orders", method: "GET", own: {} },
  { route: "orders/[id]", method: "GET", own: { params: { id: "recOA" } }, other: { params: { id: "recOB" } }, denied: [404] },
  { route: "package-rates", method: "GET", own: {} },
  { route: "warehouses", method: "GET", own: {} },
];

async function world() {
  const s = await standardWorld();
  s.w.seed.item("recIA", "recCustA");
  s.w.seed.item("recIB", "recCustB");
  s.w.seed.order("recOA", "recCustA", { Items: ["recIA"] });
  s.w.seed.order("recOB", "recCustB", { Items: ["recIB"] });
  s.w.db.insert("Warehouses", { Name: "Open", Address: "1 St", IsActive: true }, "recWhOpen");
  return { ...s, orphan: s.w.asUser("customer"), inactive: s.w.asUser("customer", { customerId: "recCustI" }) };
}

describe(PRESERVE("customer ownership boundary: probe coverage"), () => {
  it("every (route, method) a customer can reach has a probe below", () => {
    const declared = PROBES.map((p) => `${p.method} ${p.route}`).sort();
    const reachable = customerRoutes.map((e) => `${e.method} ${e.route}`).sort();
    expect(declared).toEqual(reachable);
  });
});

for (const probe of PROBES) {
  const label = `${probe.method} /api/${probe.route}`;
  describe(`customer boundary: ${label}`, () => {
    it("customer A -> own data is allowed", async () => {
      const s = await world();
      const res = await s.w.call(probe.route, probe.method, { token: s.custA, ...probe.own });
      expect([401, 403]).not.toContain(res.status);
      expect(res.status).toBeLessThan(500);
    });

    if (probe.other) {
      it("customer A -> customer B's object is denied and leaves it untouched", async () => {
        const s = await world();
        const res = await s.w.call(probe.route, probe.method, { token: s.custA, ...probe.other });
        expect(probe.denied).toContain(res.status);
        expect(s.w.db.get("Customers", "recCustB")?.fields["Notes"]).toBeUndefined();
        expect(JSON.stringify(res.json ?? {})).not.toMatch(/Kofi|MOVEZZ-KB2222|recIB|recOB/);
      });
    }

    it("a customer without a customer_id is denied (403)", async () => {
      const s = await world();
      const res = await s.w.call(probe.route, probe.method, { token: s.orphan, ...(probe.other ?? probe.own) });
      expect(res.status).toBe(403);
    });

    it("a deactivated customer is denied (403)", async () => {
      const s = await world();
      s.w.seed.customer("recCustI", { Name: "Idle Person", Status: "inactive" });
      const res = await s.w.call(probe.route, probe.method, { token: s.inactive, ...probe.own });
      expect(res.status).toBe(403);
    });
  });
}

describe("lists never contain another customer's records, whatever the client sends", () => {
  it("items and orders ignore customerId/search/page parameters that point at customer B", async () => {
    const s = await world();
    for (const route of ["items", "orders"]) {
      const queries: Record<string, string>[] = [{ customerId: "recCustB" }, { search: "Kofi" }, { search: "MOVEZZ-KB2222" }, { customerId: "recCustB", limit: "500", page: "1" }];
      for (const query of queries) {
        const res = await s.w.call(route, "GET", { token: s.custA, query });
        const ids = (res.json?.data as { id: string }[]).map((r) => r.id);
        expect(ids.every((id) => !["recIB", "recOB"].includes(id)), `${route} ${JSON.stringify(query)}`).toBe(true);
      }
    }
  });
  it("the customer dashboard ignores a customerId parameter for customers", async () => {
    const s = await world();
    const res = await s.w.call("dashboard/customer", "GET", { token: s.custA, query: { customerId: "recCustB" } });
    expect(res.json?.data.recentItems.map((i: { id: string }) => i.id)).toEqual(["recIA"]);
  });
});

describe("routes customers must never reach (cartons, containers, payments, reports, activity, uploads, users, sorting)", () => {
  const FORBIDDEN: [string, HttpMethod][] = [
    ["cartons", "GET"], ["cartons", "POST"], ["containers", "GET"], ["containers/[id]", "GET"], ["orders/[id]", "PATCH"], ["orders/[id]/create-invoice", "POST"],
    ["orders/keepup-sync", "POST"], ["reports", "GET"], ["dashboard/admin", "GET"], ["activity-logs", "GET"], ["upload/sign", "POST"], ["users", "GET"],
    ["sorting", "GET"], ["settings", "GET"], ["admin/registrations", "GET"], ["suppliers", "GET"],
    ["special-rates", "GET"], ["customers/me/warehouse", "PATCH"],     // Phase 7F: other customers' special-rate cards are not for customers; warehouse assignment is administrative (D7)
  ];
  it("all answer 403 to a customer", async () => {
    const s = await world();
    for (const [route, method] of FORBIDDEN) {
      const res = await s.w.call(route, method, { token: s.custA, params: { id: "recX", cartonNumber: "CTN-1" }, body: method === "GET" ? undefined : {} });
      expect(res.status, `${method} ${route}`).toBe(403);
    }
  });
});
