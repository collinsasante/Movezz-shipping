// Item receiving / listing / deletion and the container routes.
import { describe, it, expect } from "vitest";
import { standardWorld } from "../helpers/world";
import { KNOWN_BUG, PRESERVE } from "../helpers/known";

const newItem = (over: Record<string, unknown> = {}) => ({ customerId: "recCustA", description: "Laptop", dateReceived: "2026-03-01", ...over });

describe("item receiving: POST /api/items", () => {
  it(PRESERVE("creates the item at the first pipeline status with the next ITM reference, defaults and creator"), async () => {
    const { w, staff } = await standardWorld();
    const res = await w.call("items", "POST", { token: staff, body: newItem({ weight: 2.5, trackingNumber: "1Z999", quantity: 2 }) });
    expect(res.status).toBe(201);
    expect(res.json?.data).toMatchObject({ itemRef: "ITM-0001", status: "Arrived at Transit Warehouse", dimensionUnit: "cm", isMissing: false, weight: 2.5, trackingNumber: "1Z999", quantity: 2, customerId: "recCustA" });
    expect(String(res.json?.data.createdBy)).toContain("@");
  });
  it(PRESERVE("stores photo URLs as attachments"), async () => {
    const { w, staff } = await standardWorld();
    const res = await w.call("items", "POST", { token: staff, body: newItem({ photoUrls: ["https://res.cloudinary.com/x/a.jpg", "https://res.cloudinary.com/x/b.jpg"] }) });
    expect(res.json?.data.photos.map((p: { url: string }) => p.url)).toEqual(["https://res.cloudinary.com/x/a.jpg", "https://res.cloudinary.com/x/b.jpg"]);
  });
  it(PRESERVE("validates input: positive bounded weight/dimensions, description length, photo count"), async () => {
    const { w, staff } = await standardWorld();
    const post = (body: Record<string, unknown>) => w.call("items", "POST", { token: staff, body: newItem(body) });
    expect((await post({ weight: 0 })).status).toBe(400);
    expect((await post({ weight: 10001 })).status).toBe(400);
    expect((await post({ length: -1 })).status).toBe(400);
    expect((await post({ description: "x".repeat(1001) })).status).toBe(400);
    expect((await post({ photoUrls: Array(21).fill("https://a.invalid/x.jpg") })).status).toBe(400);
    expect((await post({ customerId: "" })).status).toBe(400);
  });
  it(KNOWN_BUG("pricing fields are written in a SECOND update whose failure is silently swallowed"), async () => {
    // Future behavior (Phase 3): one transaction. Documents current behavior only.
    const { w, staff } = await standardWorld();
    w.db.beforeWrite = ({ table, op, fields }) => {
      if (table === "Items" && op === "update" && fields && "PkgEstShipping" in fields) throw new Error("update rejected");
    };
    const res = await w.call("items", "POST", { token: staff, body: newItem({ pkgEstShipping: 42, estPrice: 10 }) });
    expect(res.status).toBe(201); // success is reported...
    expect(w.db.all("Items")[0].fields["PkgEstShipping"]).toBeUndefined(); // ...but the price was never saved
  });
});

describe("item listing: GET /api/items (loads the whole table, filters and paginates in memory)", () => {
  async function many() {
    const s = await standardWorld();
    s.w.seed.container("recC1");
    s.w.seed.item("recI1", "recCustA", { TrackingNumber: "ZZ-TRACK-1", DateReceived: "2026-03-01", Status: "Sorting", Container: ["recC1"] });
    s.w.seed.item("recI2", "recCustA", { Description: "red bicycle", DateReceived: "2026-03-05" });
    s.w.seed.item("recI3", "recCustB", { DateReceived: "2026-03-03", IsMissing: true, Order: ["recO1"] });
    return s;
  }
  const idsOf = (r: { json?: Record<string, any> }) => (r.json?.data as { id: string }[]).map((i) => i.id); // eslint-disable-line @typescript-eslint/no-explicit-any

  it(PRESERVE("is sorted by DateReceived, newest first"), async () => {
    const s = await many();
    expect(idsOf(await s.w.call("items", "GET", { token: s.admin }))).toEqual(["recI2", "recI3", "recI1"]);
  });
  it(PRESERVE("filters by status, missing flag, container, order and customer"), async () => {
    const s = await many();
    const get = async (query: Record<string, string>) => idsOf(await s.w.call("items", "GET", { token: s.admin, query }));
    expect(await get({ status: "Sorting" })).toEqual(["recI1"]);
    expect(await get({ isMissing: "true" })).toEqual(["recI3"]);
    expect(await get({ containerId: "recC1" })).toEqual(["recI1"]);
    expect(await get({ orderId: "recO1" })).toEqual(["recI3"]);
    expect(await get({ customerId: "recCustB" })).toEqual(["recI3"]);
  });
  it(PRESERVE("search matches reference, description, tracking number, customer shipping mark and customer name (case-insensitive)"), async () => {
    const s = await many();
    const get = async (search: string) => idsOf(await s.w.call("items", "GET", { token: s.admin, query: { search } }));
    expect(await get("zz-track")).toEqual(["recI1"]);
    expect(await get("BICYCLE")).toEqual(["recI2"]);
    expect(await get("MOVEZZ-KB2222")).toEqual(["recI3"]);
    expect(await get("kofi")).toEqual(["recI3"]);
    expect(await get("ITM-recI2")).toEqual(["recI2"]);
  });
  it(PRESERVE("paginates 50 per page by default; limit is capped at 500; total/totalPages reflect the full set"), async () => {
    const s = await standardWorld();
    for (let i = 0; i < 55; i++) s.w.seed.item(`recP${String(i).padStart(2, "0")}`, "recCustA", { DateReceived: "2026-03-01" });
    const p1 = await s.w.call("items", "GET", { token: s.admin });
    expect(p1.json).toMatchObject({ total: 55, totalPages: 2, page: 1 });
    expect(p1.json?.data).toHaveLength(50);
    expect((await s.w.call("items", "GET", { token: s.admin, query: { page: "2" } })).json?.data).toHaveLength(5);
    expect((await s.w.call("items", "GET", { token: s.admin, query: { limit: "9999" } })).json?.data).toHaveLength(55);
  });
  it(PRESERVE("attaches the container's ETA (DepartureDate) to each item"), async () => {
    const s = await many();
    s.w.db.update("Containers", "recC1", { DepartureDate: "2026-04-20" });
    const res = await s.w.call("items", "GET", { token: s.admin });
    expect(res.json?.data.find((i: { id: string }) => i.id === "recI1").containerEta).toBe("2026-04-20");
  });
  it(KNOWN_BUG("every list request scans the whole Items table (and, for name resolution, the whole Customers table)"), async () => {
    const s = await many();
    s.w.db.clearCalls();
    await s.w.call("items", "GET", { token: s.admin, query: { limit: "1" } });
    expect(s.w.db.count("Items", "select")).toBe(1);
    expect(s.w.db.count("Customers", "select")).toBe(1);
  });
});

describe("item deletion", () => {
  it(PRESERVE("is admin-only, unlinks the container and order, then hard-deletes the record"), async () => {
    const { w, admin, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Container: ["recC1"], Order: ["recO1"] });
    expect((await w.call("items/[id]", "DELETE", { token: staff, params: { id: "recI1" } })).status).toBe(403);
    const res = await w.call("items/[id]", "DELETE", { token: admin, params: { id: "recI1" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")).toBeUndefined();
  });
  it(KNOWN_BUG("deleting an item leaves its status history behind and does not remove it from the order's or container's own item list"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.container("recC1", { Items: ["recI1"] });
    w.seed.order("recO1", "recCustA", { Items: ["recI1"] });
    w.seed.item("recI1", "recCustA", { Container: ["recC1"], Order: ["recO1"], Status: "Sorting" });
    await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Ready for Pickup" } });
    await w.call("items/[id]", "DELETE", { token: admin, params: { id: "recI1" } });
    expect(w.db.all("StatusHistory")).toHaveLength(1); // orphaned history row
    expect(w.db.get("Orders", "recO1")?.fields["Items"]).toEqual(["recI1"]); // still points at the deleted item (real Airtable would sync this inverse link)
  });
});

describe("containers", () => {
  it(PRESERVE("POST requires super_admin and a container number (trackingNumber); creates status Loading with a PMX-CON reference"), async () => {
    const { w, admin, staff } = await standardWorld();
    expect((await w.call("containers", "POST", { token: staff, body: { trackingNumber: "MSCU1" } })).status).toBe(403);
    expect((await w.call("containers", "POST", { token: admin, body: {} })).status).toBe(400);
    const res = await w.call("containers", "POST", { token: admin, body: { trackingNumber: "MSCU1", name: "MSC", eta: "2026-05-01" } });
    expect(res.status).toBe(201);
    expect(res.json?.data).toMatchObject({ containerId: "PMX-CON-2026-001", status: "Loading", trackingNumber: "MSCU1", eta: "2026-05-01", name: "MSC" });
  });
  it(PRESERVE("the 'eta' shown in the UI is stored in the DepartureDate field"), async () => {
    const { w, admin } = await standardWorld();
    await w.call("containers", "POST", { token: admin, body: { trackingNumber: "MSCU1", eta: "2026-05-01" } });
    expect(w.db.all("Containers")[0].fields["DepartureDate"]).toBe("2026-05-01");
  });
  it(PRESERVE("GET /api/containers/[id] hydrates members, de-duplicates repeated ids and fills in customer name/mark"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.container("recC1", { Items: ["recI1", "recI1", "recI2"] });
    w.seed.item("recI1", "recCustA", { Container: ["recC1"] });
    w.seed.item("recI2", "recCustB", { Container: ["recC1"] });
    const res = await w.call("containers/[id]", "GET", { token: admin, params: { id: "recC1" } });
    expect(res.json?.data.items.map((i: { id: string }) => i.id)).toEqual(["recI1", "recI2"]);
    expect(res.json?.data.items[1]).toMatchObject({ customerName: "Kofi Boateng", customerShippingMark: "MOVEZZ-KB2222" });
  });
  it(KNOWN_BUG("loading a container performs one Airtable read per member item (N+1)"), async () => {
    const { w, admin } = await standardWorld();
    const members = ["recI1", "recI2", "recI3", "recI4", "recI5"];
    w.seed.container("recC1", { Items: members });
    for (const id of members) w.seed.item(id, "recCustA", { Container: ["recC1"] });
    w.db.clearCalls();
    await w.call("containers/[id]", "GET", { token: admin, params: { id: "recC1" } });
    expect(w.db.count("Items", "find")).toBe(5);
  });
  it(PRESERVE("the container LIST reports totalCbm by summing the member items' own dimensions"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.container("recC1", { Items: ["recI1"] });
    w.seed.item("recI1", "recCustA", { Container: ["recC1"], Length: 100, Width: 100, Height: 100 });
    const res = await w.call("containers", "GET", { token: admin });
    expect(res.status).toBe(200);
    expect(res.json?.data[0].totalCbm).toBe(1);
  });
  it(KNOWN_BUG("container totalCbm ignores item quantity and carton dimensions (same blind spot as the dashboards)"), async () => {
    // Future behavior (Phase 3 R-7): quantity-aware CBM from one shared definition. Documents current behavior only.
    const { w, admin } = await standardWorld();
    w.seed.container("recC1", { Items: ["recI1"] });
    w.seed.item("recI1", "recCustA", { Container: ["recC1"], Length: 100, Width: 100, Height: 100, Quantity: 3 });
    const res = await w.call("containers", "GET", { token: admin });
    expect(res.json?.data[0].totalCbm).toBe(1); // 3 units = 3 m3 for billing, 1 m3 here
  });
  it(PRESERVE("the list is available to staff and filters by status / search"), async () => {
    const { w, staff } = await standardWorld();
    w.seed.container("recC1", { Status: "Loading", TrackingNumber: "MSCU111", Name: "MSC" });
    w.seed.container("recC2", { Status: "Shipped to Ghana", TrackingNumber: "CMAU222", Name: "CMA" });
    const ids = async (query: Record<string, string>) => ((await w.call("containers", "GET", { token: staff, query })).json?.data as { id: string }[]).map((c) => c.id);
    expect(await ids({ status: "Shipped to Ghana" })).toEqual(["recC2"]);
    expect(await ids({ search: "mscu" })).toEqual(["recC1"]);
  });
  it(PRESERVE("PATCH can edit the container's creation date (CreatedAt)"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.container("recC1");
    const res = await w.call("containers/[id]", "PATCH", { token: admin, params: { id: "recC1" }, body: { createdAt: "2026-01-02" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Containers", "recC1")?.fields["CreatedAt"]).toBe("2026-01-02");
  });
  it(KNOWN_BUG("deleting a container is a hard delete even when it holds items"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.container("recC1", { Items: ["recI1"] });
    w.seed.item("recI1", "recCustA", { Container: ["recC1"], Status: "Shipped to Ghana" });
    expect((await w.call("containers/[id]", "DELETE", { token: admin, params: { id: "recC1" } })).status).toBe(200);
    expect(w.db.get("Containers", "recC1")).toBeUndefined();
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Shipped to Ghana"); // stays "shipped" with no container
  });
});
