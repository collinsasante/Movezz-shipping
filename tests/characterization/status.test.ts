// Item status pipeline, container-driven status cascade, sorting (found/missing) and status history.
import { describe, it, expect, vi } from "vitest";
import { standardWorld, freshWorld } from "../helpers/world";
import { KNOWN_BUG, PRESERVE } from "../helpers/known";

const history = (w: Awaited<ReturnType<typeof freshWorld>>) => w.db.all("StatusHistory").map((r) => r.fields);

describe(PRESERVE("PATCH /api/items/[id]/status - role rules"), () => {
  it("lets an admin move to any status, including backwards", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Sorting" });
    const res = await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Arrived at Transit Warehouse" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Arrived at Transit Warehouse");
  });

  it("blocks warehouse staff from moving an item backwards (400)", async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Sorting" });
    const res = await w.call("items/[id]/status", "PATCH", { token: staff, params: { id: "recI1" }, body: { status: "Arrived in Ghana" } });
    expect(res.status).toBe(400);
    expect(res.json?.error).toBe("Status can only move forward in the pipeline");
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Sorting");
  });

  it("allows warehouse staff to move forward and to re-apply the same status", async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived in Ghana" });
    const same = await w.call("items/[id]/status", "PATCH", { token: staff, params: { id: "recI1" }, body: { status: "Arrived in Ghana" } });
    const fwd = await w.call("items/[id]/status", "PATCH", { token: staff, params: { id: "recI1" }, body: { status: "Awaiting Customs Clearance & Duty Process" } });
    expect([same.status, fwd.status]).toEqual([200, 200]);
  });

  it("allows warehouse staff to SKIP steps forward (the route comment says 'staff must go in order' but only backwards is blocked)", async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived in Ghana" });
    const res = await w.call("items/[id]/status", "PATCH", { token: staff, params: { id: "recI1" }, body: { status: "Completed" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Completed");
  });

  it("rejects an unknown status name (400) and denies customers (403)", async () => {
    const { w, admin, custA } = await standardWorld();
    w.seed.item("recI1", "recCustA");
    expect((await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Teleported" } })).status).toBe(400);
    expect((await w.call("items/[id]/status", "PATCH", { token: custA, params: { id: "recI1" }, body: { status: "Sorting" } })).status).toBe(403);
  });
});

describe(PRESERVE("'Shipped to Ghana' requires a container"), () => {
  it("returns 400 when the item has no container, even for an admin", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA");
    const res = await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Shipped to Ghana" } });
    expect(res.status).toBe(400);
    expect(res.json?.error).toMatch(/must be assigned to a container/);
  });
  it("succeeds when the item is in a container", async () => {
    const { w, admin } = await standardWorld();
    w.seed.container("recC1");
    w.seed.item("recI1", "recCustA", { Container: ["recC1"] });
    const res = await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Shipped to Ghana" } });
    expect(res.status).toBe(200);
  });
});

describe("status history and notifications on item status change", () => {
  it(PRESERVE("writes one StatusHistory row with previous/new status, actor and notes"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived in Ghana" });
    await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Sorting", notes: "moved to bay 3" } });
    expect(history(w)).toHaveLength(1);
    expect(history(w)[0]).toMatchObject({
      RecordType: "Item",
      RecordID: "recI1",
      PreviousStatus: "Arrived in Ghana",
      NewStatus: "Sorting",
      ChangedByRole: "super_admin",
      Notes: "moved to bay 3",
    });
    expect(String(history(w)[0]["ChangedBy"])).toContain("@");
    expect(history(w)[0]["ChangedAt"]).toBe("2026-03-15T10:00:00.000Z");
  });

  it(PRESERVE("emails the customer (fire-and-forget) with the new status"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived in Ghana" });
    await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Sorting" } });
    await vi.waitFor(() => expect(w.email.sendItemStatusEmail).toHaveBeenCalledTimes(1));
    expect(vi.mocked(w.email.sendItemStatusEmail).mock.calls[0][0]).toMatchObject({ status: "Sorting", customerName: "Ada Mensah" });
  });

  it(PRESERVE("does not attempt WhatsApp unless sendWhatsApp is true; never uses the network in tests"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived in Ghana", Order: ["recOrd1"] });
    w.seed.order("recOrd1", "recCustA");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Sorting", sendWhatsApp: true } });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("WHATSAPP_ACCESS_TOKEN"));
  });

  it(PRESERVE("GET /api/items/[id]/history returns the rows oldest first"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived in Ghana" });
    await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Sorting" } });
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Ready for Pickup" } });
    const res = await w.call("items/[id]/history", "GET", { token: admin, params: { id: "recI1" } });
    expect(res.json?.data.map((h: { newStatus: string }) => h.newStatus)).toEqual(["Sorting", "Ready for Pickup"]);
  });
});

describe(KNOWN_BUG("status history is best-effort and incomplete"), () => {
  // Future behavior (Phase 3 ADR-12): status_events written in the SAME transaction, for items, containers, cartons and invoices.
  // These tests document current behavior only.
  it("documents that the status change SUCCEEDS even when the history write fails (silent audit gap)", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived in Ghana" });
    w.db.beforeWrite = ({ table }) => {
      if (table === "StatusHistory") throw new Error("history store down");
    };
    const res = await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Sorting" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Sorting");
    expect(history(w)).toHaveLength(0);
  });
  it("documents that PATCH /api/items/[id] accepts a 'status' field but silently ignores it", async () => {
    const { w, admin } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived in Ghana" });
    const res = await w.call("items/[id]", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Completed", description: "edited" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Arrived in Ghana");
    expect(w.db.get("Items", "recI1")?.fields["Description"]).toBe("edited");
  });
});

describe("is_missing handling", () => {
  it(PRESERVE("progress statuses clear the missing flag; early statuses do not"), async () => {
    const { w, admin } = await standardWorld();
    w.seed.container("recC1");
    w.seed.item("recI1", "recCustA", { IsMissing: true, Container: ["recC1"], Status: "Arrived at Transit Warehouse" });
    await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Shipped to Ghana" } });
    expect(w.db.get("Items", "recI1")?.fields["IsMissing"]).toBe(true);
    await w.call("items/[id]/status", "PATCH", { token: admin, params: { id: "recI1" }, body: { status: "Sorting" } });
    expect(w.db.get("Items", "recI1")?.fields["IsMissing"]).toBeUndefined();
  });

  it(PRESERVE("sorting 'missing' sets the flag and leaves the status unchanged"), async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Sorting" });
    const res = await w.call("sorting", "POST", { token: staff, body: { itemId: "recI1", action: "missing" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields).toMatchObject({ IsMissing: true, Status: "Sorting" });
  });

  it(PRESERVE("sorting 'found' clears the flag, moves to Ready for Pickup and logs history with a fixed note"), async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Sorting", IsMissing: true });
    const res = await w.call("sorting", "POST", { token: staff, body: { itemId: "recI1", action: "found" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields["IsMissing"]).toBeUndefined();
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Ready for Pickup");
    expect(history(w)[0]).toMatchObject({ NewStatus: "Ready for Pickup", Notes: "Item found during sorting" });
  });

  it(KNOWN_BUG("'missing' is not recorded in history, and 'found' does not require the item to be in Sorting"), async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Arrived at Transit Warehouse" });
    await w.call("sorting", "POST", { token: staff, body: { itemId: "recI1", action: "missing" } });
    expect(history(w)).toHaveLength(0);
    await w.call("sorting", "POST", { token: staff, body: { itemId: "recI1", action: "found" } });
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Ready for Pickup"); // jumped from the first step
  });

  it(PRESERVE("GET /api/sorting lists items in Sorting and, when asked, missing items"), async () => {
    const { w, staff } = await standardWorld();
    w.seed.item("recI1", "recCustA", { Status: "Sorting" });
    w.seed.item("recI2", "recCustA", { Status: "Sorting", IsMissing: true });
    w.seed.item("recI3", "recCustA", { Status: "Completed" });
    const res = await w.call("sorting", "GET", { token: staff, query: { missing: "true" } });
    expect(res.json?.data.sortingCount).toBe(2);
    expect(res.json?.data.missingCount).toBe(1);
  });
});

describe("container-driven status changes", () => {
  async function loaded() {
    const s = await standardWorld();
    const { w } = s;
    w.seed.container("recC1", { Items: ["recI1", "recI2"] });
    w.seed.item("recI1", "recCustA", { Container: ["recC1"], Status: "Arrived at Transit Warehouse" });
    w.seed.item("recI2", "recCustA", { Container: ["recC1"], Status: "Arrived at Transit Warehouse" });
    return s;
  }

  it(PRESERVE("'Shipped to Ghana' sets every member to 'Shipped to Ghana'"), async () => {
    const { w, admin } = await loaded();
    const res = await w.call("containers/[id]/status", "PATCH", { token: admin, params: { id: "recC1" }, body: { status: "Shipped to Ghana" } });
    expect(res.status).toBe(200);
    expect(["recI1", "recI2"].map((id) => w.db.get("Items", id)?.fields["Status"])).toEqual(["Shipped to Ghana", "Shipped to Ghana"]);
  });

  it(PRESERVE("'Arrived in Ghana' sets members to 'Awaiting Customs Clearance & Duty Process' (not 'Arrived in Ghana')"), async () => {
    const { w, admin } = await loaded();
    await w.call("containers/[id]/status", "PATCH", { token: admin, params: { id: "recC1" }, body: { status: "Arrived in Ghana" } });
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Awaiting Customs Clearance & Duty Process");
  });

  it(PRESERVE("'Loading' has no cascade"), async () => {
    const { w, admin } = await loaded();
    await w.call("containers/[id]/status", "PATCH", { token: admin, params: { id: "recC1" }, body: { status: "Loading" } });
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Arrived at Transit Warehouse");
  });

  it(PRESERVE("only super_admin may change a container's status (staff 403)"), async () => {
    const { w, staff } = await loaded();
    const res = await w.call("containers/[id]/status", "PATCH", { token: staff, params: { id: "recC1" }, body: { status: "Shipped to Ghana" } });
    expect(res.status).toBe(403);
  });

  it(KNOWN_BUG("the container cascade is blind to each item's current status and leaves no trace"), async () => {
    // Future behavior (Phase 3 R-12): one status_events row per item and customer notifications.
    // This test documents current behavior only.
    const { w, admin } = await loaded();
    w.db.update("Items", "recI2", { Status: "Completed", IsMissing: true });
    await w.call("containers/[id]/status", "PATCH", { token: admin, params: { id: "recC1" }, body: { status: "Shipped to Ghana" } });
    expect(w.db.get("Items", "recI2")?.fields["Status"]).toBe("Shipped to Ghana"); // a Completed item is pulled BACK
    expect(w.db.get("Items", "recI2")?.fields["IsMissing"]).toBe(true); // flag not cleared
    expect(history(w)).toHaveLength(0); // no StatusHistory rows for any cascaded item
    expect(w.email.sendItemStatusEmail).not.toHaveBeenCalled(); // no customer notification
  });

  it(KNOWN_BUG("container status changes themselves are not recorded in StatusHistory"), async () => {
    const { w, admin } = await loaded();
    await w.call("containers/[id]/status", "PATCH", { token: admin, params: { id: "recC1" }, body: { status: "Shipped to Ghana" } });
    expect(history(w)).toHaveLength(0);
  });

  it(PRESERVE("sync-items re-applies the container's mapped status to every member and reports the count"), async () => {
    const { w, admin } = await loaded();
    w.db.update("Containers", "recC1", { Status: "Shipped to Ghana" });
    const res = await w.call("containers/[id]/sync-items", "POST", { token: admin, params: { id: "recC1" } });
    expect(res.status).toBe(200);
    expect(w.db.get("Items", "recI1")?.fields["Status"]).toBe("Shipped to Ghana");
  });
});

describe("container membership (data layer)", () => {
  it(PRESERVE("an item can be in only one container"), async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.container("recC1");
    w.seed.container("recC2");
    w.seed.item("recI1", "recCustA", { Container: ["recC1"] });
    await expect(w.airtable.containersApi.addItem("recC2", "recI1", "a@example.invalid")).rejects.toThrow(/already loaded into another container/);
  });
  it(PRESERVE("adding writes both sides of the link and is idempotent"), async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.container("recC1");
    w.seed.item("recI1", "recCustA");
    await w.airtable.containersApi.addItem("recC1", "recI1", "a@example.invalid");
    await w.airtable.containersApi.addItem("recC1", "recI1", "a@example.invalid");
    expect(w.db.get("Containers", "recC1")?.fields["Items"]).toEqual(["recI1"]);
    expect(w.db.get("Items", "recI1")?.fields["Container"]).toEqual(["recC1"]);
  });
  it(PRESERVE("removing clears both sides; deleting a container unlinks its items first"), async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.container("recC1", { Items: ["recI1"] });
    w.seed.item("recI1", "recCustA", { Container: ["recC1"] });
    await w.airtable.containersApi.removeItem("recC1", "recI1", "a@example.invalid");
    expect(w.db.get("Items", "recI1")?.fields["Container"]).toBeUndefined();
    // The fake does not sync inverse links (real Airtable does), so re-link BOTH sides explicitly.
    w.db.update("Items", "recI1", { Container: ["recC1"] });
    w.db.update("Containers", "recC1", { Items: ["recI1"] });
    await w.airtable.containersApi.delete("recC1");
    expect(w.db.get("Items", "recI1")?.fields["Container"]).toBeUndefined();
    expect(w.db.get("Containers", "recC1")).toBeUndefined();
  });
});
