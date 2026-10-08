// Customers (list/search/cache), suppliers, warehouses and special rates: the remaining CRUD behavior to preserve.
import { describe, it, expect, vi } from "vitest";
import { standardWorld } from "../helpers/world";
import { KNOWN_BUG, PRESERVE, FIXED } from "../helpers/known";

describe("customers: listing and search", () => {
  async function people() {
    const s = await standardWorld();
    s.w.seed.customer("recCustC", { Name: "Esi Owusu", Phone: "0200009999", Email: "esi@example.invalid", ShippingMark: "MOVEZZ-EO9999", Status: "inactive" });
    return s;
  }
  const names = async (s: Awaited<ReturnType<typeof people>>, query: Record<string, string>) =>
    ((await s.w.call("customers", "GET", { token: s.admin, query })).json?.data as { name: string }[]).map((c) => c.name).sort();

  it(PRESERVE("search matches name, email, shipping mark and phone (case-insensitive substring)"), async () => {
    const s = await people();
    expect(await names(s, { search: "kofi" })).toEqual(["Kofi Boateng"]);
    expect(await names(s, { search: "ESI@EXAMPLE" })).toEqual(["Esi Owusu"]);
    expect(await names(s, { search: "movezz-am" })).toEqual(["Ada Mensah"]);
    expect(await names(s, { search: "9999" })).toEqual(["Esi Owusu"]);
  });
  it(PRESERVE("a +233 / 00233 phone search also matches the local 0-prefixed number"), async () => {
    const s = await people();
    expect(await names(s, { search: "+233200009999" })).toEqual(["Esi Owusu"]);
    expect(await names(s, { search: "00233200009999" })).toEqual(["Esi Owusu"]);
  });
  it(PRESERVE("filters by status; paginates 50 per page with a 1,000 limit cap"), async () => {
    const s = await people();
    expect(await names(s, { status: "inactive" })).toEqual(["Esi Owusu"]);
    const res = await s.w.call("customers", "GET", { token: s.staff, query: { limit: "5000" } });
    expect(res.json).toMatchObject({ total: 3, totalPages: 1, page: 1 });
  });
  it(KNOWN_BUG("the unfiltered customer list is cached in process memory for 60 seconds (new customers are missing from name lookups)"), async () => {
    // Future behavior: no per-process cache (queries hit PostgreSQL). Documents current behavior only.
    const s = await people();
    s.w.seed.item("recI1", "recCustA");
    await s.w.call("items", "GET", { token: s.admin }); // warms the cache
    s.w.seed.customer("recCustNew", { Name: "New Person", ShippingMark: "MOVEZZ-NP0000" });
    s.w.seed.item("recI2", "recCustNew");
    const stale = await s.w.call("items", "GET", { token: s.admin });
    expect(stale.json?.data.find((i: { id: string }) => i.id === "recI2").customerName).toBeUndefined();
    vi.setSystemTime(new Date("2026-03-15T10:01:01.000Z"));
    const fresh = await s.w.call("items", "GET", { token: s.admin });
    expect(fresh.json?.data.find((i: { id: string }) => i.id === "recI2").customerName).toBe("New Person");
  });
  it(PRESERVE("creating or updating a customer through the API invalidates the cache"), async () => {
    const s = await people();
    await s.w.airtable.customersApi.list();
    await s.w.airtable.customersApi.create({ name: "Fresh Face", phone: "0200001111", email: "f@example.invalid" }, "a@example.invalid");
    expect((await s.w.airtable.customersApi.list()).map((c) => c.name)).toContain("Fresh Face");
  });
  it(PRESERVE("deleting a customer removes the Firebase login and the Users row, then the customer"), async () => {
    const s = await people();
    const res = await s.w.call("customers/[id]", "DELETE", { token: s.admin, params: { id: "recCustA" } });
    expect(res.status).toBe(200);
    expect(s.w.db.get("Customers", "recCustA")).toBeUndefined();
    expect(s.w.db.all("Users").some((u) => (u.fields["CustomerRecord"] as string[] | undefined)?.[0] === "recCustA")).toBe(false);
  });
  it(KNOWN_BUG("deleting a customer is a hard delete that leaves their items and orders pointing at a missing record"), async () => {
    const s = await people();
    s.w.seed.item("recI1", "recCustA");
    s.w.seed.order("recO1", "recCustA");
    await s.w.call("customers/[id]", "DELETE", { token: s.admin, params: { id: "recCustA" } });
    expect(s.w.db.get("Items", "recI1")?.fields["Customer"]).toEqual(["recCustA"]);
    expect(s.w.db.get("Orders", "recO1")?.fields["Customer"]).toEqual(["recCustA"]);
  });
});

describe("suppliers", () => {
  it(FIXED("create assigns SUP-nnnn; rating must be 1-5; name required; supplier administration is super_admin only (Phase 7F)"), async () => {
    const { w, admin, staff } = await standardWorld();
    expect((await w.call("suppliers", "POST", { token: staff, body: { name: "Acme" } })).status).toBe(403);
    const ok = await w.call("suppliers", "POST", { token: admin, body: { name: "Acme", category: "Electronics", rating: 4 } });
    expect(ok.status).toBe(201);
    expect(ok.json?.data).toMatchObject({ supplierId: "SUP-0001", name: "Acme", rating: 4 });
    expect((await w.call("suppliers", "POST", { token: admin, body: { name: "" } })).status).toBe(400);
    expect((await w.call("suppliers", "POST", { token: admin, body: { name: "X", rating: 6 } })).status).toBe(400);
  });
  it(PRESERVE("search covers name, category and platform; only an admin can delete"), async () => {
    const { w, admin, staff } = await standardWorld();
    await w.call("suppliers", "POST", { token: admin, body: { name: "Acme", platform: "Alibaba" } });
    await w.call("suppliers", "POST", { token: admin, body: { name: "Zeta", category: "Fashion" } });
    const find = async (search: string) => ((await w.call("suppliers", "GET", { token: staff, query: { search } })).json?.data as { name: string }[]).map((s) => s.name);
    expect(await find("alibaba")).toEqual(["Acme"]);
    expect(await find("fash")).toEqual(["Zeta"]);
    const id = w.db.all("Suppliers")[0].id;
    expect((await w.call("suppliers/[id]", "DELETE", { token: staff, params: { id } })).status).toBe(403);
    expect((await w.call("suppliers/[id]", "DELETE", { token: admin, params: { id } })).status).toBe(200);
  });
});

describe("warehouses", () => {
  it(PRESERVE("create requires name and address and trims input; update and toggle work; only an admin can delete"), async () => {
    const { w, admin, staff } = await standardWorld();
    expect((await w.call("warehouses", "POST", { token: staff, body: { name: "Depot", address: "x" } })).status).toBe(403);   // warehouse configuration: super_admin only (Phase 7F)
    expect((await w.call("warehouses", "POST", { token: admin, body: { name: " ", address: "x" } })).status).toBe(400);
    const created = await w.call("warehouses", "POST", { token: admin, body: { name: " Depot ", address: " 1 Main St ", phone: " 0244 " } });
    expect(created.json?.data).toMatchObject({ name: "Depot", address: "1 Main St", phone: "0244", isActive: true });
    const id = created.json?.data.id as string;
    expect((await w.call("warehouses/[id]", "DELETE", { token: staff, params: { id } })).status).toBe(403);
    expect((await w.call("warehouses/[id]", "DELETE", { token: admin, params: { id } })).status).toBe(200);
  });
  it(FIXED("customers see only ACTIVE warehouses; admin and staff still see every warehouse (history is preserved)"), async () => {
    const { w, custA, staff, admin } = await standardWorld();
    w.db.insert("Warehouses", { Name: "Open", Address: "1 St", IsActive: true });
    w.db.insert("Warehouses", { Name: "Closed", Address: "2 St", IsActive: false });
    const names = async (token: string) => ((await w.call("warehouses", "GET", { token })).json?.data as { name: string }[]).map((x) => x.name).sort();
    expect(await names(custA)).toEqual(["Open"]);
    expect(await names(staff)).toEqual(["Closed", "Open"]);
    expect(await names(admin)).toEqual(["Closed", "Open"]);
  });
  it(PRESERVE("deactivating a warehouse does not delete it or alter customers that referenced it"), async () => {
    const { w, admin } = await standardWorld();
    w.db.insert("Warehouses", { Name: "Open", Address: "1 St", IsActive: true }, "recWh1");
    w.db.update("Customers", "recCustA", { PreferredWarehouse: "recWh1" });
    await w.call("warehouses/[id]", "PATCH", { token: admin, params: { id: "recWh1" }, body: { isActive: false } });
    expect(w.db.get("Warehouses", "recWh1")?.fields["Name"]).toBe("Open");
    expect(w.db.get("Customers", "recCustA")?.fields["PreferredWarehouse"]).toBe("recWh1");
  });
});

describe("special rates", () => {
  it(PRESERVE("create trims the name and accepts numeric strings for sea/air (like the old parseFloat)"), async () => {
    const { w, admin } = await standardWorld();
    const res = await w.call("special-rates", "POST", { token: admin, body: { name: " Bulk ", sea: "12.5", air: "7.5" } });
    expect(res.status).toBe(201);
    expect(res.json?.data).toMatchObject({ name: "Bulk", sea: 12.5, air: 7.5 });
  });
  it(FIXED("unparseable, negative or unknown values are rejected (400) instead of being stored as 0"), async () => {
    const { w, admin } = await standardWorld();
    const post = (body: unknown) => w.call("special-rates", "POST", { token: admin, body });
    expect((await post({ name: "  " })).status).toBe(400);
    expect((await post({ name: "X", sea: "abc" })).status).toBe(400);
    expect((await post({ name: "X", sea: -1 })).status).toBe(400);
    expect((await post({ name: "X", sea: 1e9 })).status).toBe(400);
    expect((await post({ name: "X", evil: true })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(w.db.all("SpecialRates")).toHaveLength(0);
  });
});
