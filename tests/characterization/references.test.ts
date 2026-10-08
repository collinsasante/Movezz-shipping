// Reference-number generation (ITM / ORD / PMX-CON / SUP) and customer creation, against the real data layer.
import { describe, it, expect } from "vitest";
import { freshWorld } from "../helpers/world";
import { KNOWN_BUG, PRESERVE, FIXED } from "../helpers/known";

const itemInput = (customerId: string, description = "Box") => ({
  customerId,
  description,
  dateReceived: "2026-03-01",
});

describe(PRESERVE("reference formats produced by the data layer"), () => {
  it("first records get ITM-0001, ORD-00001, SUP-0001 and PMX-CON-<year>-001", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    const item = await w.airtable.itemsApi.create(itemInput("recCustA"), "staff@example.invalid");
    const order = await w.airtable.ordersApi.create(
      { customerId: "recCustA", itemIds: [item.id], invoiceAmount: 50, invoiceDate: "2026-03-10" },
      "admin@example.invalid"
    );
    const supplier = await w.airtable.suppliersApi.create({ name: "Acme" }, "admin@example.invalid");
    const container = await w.airtable.containersApi.create({ trackingNumber: "MSCU123" }, "admin@example.invalid");
    expect(item.itemRef).toBe("ITM-0001");
    expect(order.orderRef).toBe("ORD-00001");
    expect(supplier.supplierId).toBe("SUP-0001");
    expect(container.containerId).toBe("PMX-CON-2026-001");
  });

  it("increments sequentially while nothing is deleted", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) refs.push((await w.airtable.itemsApi.create(itemInput("recCustA"), "s@example.invalid")).itemRef);
    expect(refs).toEqual(["ITM-0001", "ITM-0002", "ITM-0003"]);
  });
});

describe(KNOWN_BUG("reference numbers are derived from count + 1"), () => {
  // Future behavior (Phase 3 R-6 / ADR-9): transactional reference_counters; never reuse a number.
  // This test documents current behavior only. It must be inverted when the counter implementation lands.

  it("documents that deleting an item makes the NEXT item reuse an existing reference", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    const a = await w.airtable.itemsApi.create(itemInput("recCustA", "first"), "s@example.invalid"); // ITM-0001
    const b = await w.airtable.itemsApi.create(itemInput("recCustA", "second"), "s@example.invalid"); // ITM-0002
    await w.airtable.itemsApi.delete(a.id);
    const c = await w.airtable.itemsApi.create(itemInput("recCustA", "third"), "s@example.invalid");
    expect(b.itemRef).toBe("ITM-0002");
    expect(c.itemRef).toBe("ITM-0002"); // DUPLICATE of b
    const refs = w.db.all("Items").map((r) => r.fields["ItemRef"]);
    expect(refs.sort()).toEqual(["ITM-0002", "ITM-0002"]);
  });

  it("documents that two simultaneous item creations receive the SAME reference", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    const [x, y] = await Promise.all([
      w.airtable.itemsApi.create(itemInput("recCustA", "x"), "s@example.invalid"),
      w.airtable.itemsApi.create(itemInput("recCustA", "y"), "s@example.invalid"),
    ]);
    expect(x.itemRef).toBe("ITM-0001");
    expect(y.itemRef).toBe("ITM-0001");
  });

  it("documents the same reuse for orders (delete then create)", async () => {
    const w = await freshWorld();
    w.seed.customer("recCustA");
    w.seed.item("recI1", "recCustA");
    w.seed.item("recI2", "recCustA");
    w.seed.item("recI3", "recCustA");
    const o1 = await w.airtable.ordersApi.create({ customerId: "recCustA", itemIds: ["recI1"], invoiceAmount: 10, invoiceDate: "2026-03-10" }, "a@example.invalid");
    const o2 = await w.airtable.ordersApi.create({ customerId: "recCustA", itemIds: ["recI2"], invoiceAmount: 10, invoiceDate: "2026-03-10" }, "a@example.invalid");
    await w.airtable.ordersApi.delete(o1.id);
    const o3 = await w.airtable.ordersApi.create({ customerId: "recCustA", itemIds: ["recI3"], invoiceAmount: 10, invoiceDate: "2026-03-10" }, "a@example.invalid");
    expect([o2.orderRef, o3.orderRef]).toEqual(["ORD-00002", "ORD-00002"]);
  });

  it("documents the same reuse for suppliers and containers", async () => {
    const w = await freshWorld();
    const s1 = await w.airtable.suppliersApi.create({ name: "A" }, "a@example.invalid");
    const s2 = await w.airtable.suppliersApi.create({ name: "B" }, "a@example.invalid");
    await w.airtable.suppliersApi.delete(s1.id);
    const s3 = await w.airtable.suppliersApi.create({ name: "C" }, "a@example.invalid");
    expect([s2.supplierId, s3.supplierId]).toEqual(["SUP-0002", "SUP-0002"]);

    const c1 = await w.airtable.containersApi.create({ trackingNumber: "T1" }, "a@example.invalid");
    const c2 = await w.airtable.containersApi.create({ trackingNumber: "T2" }, "a@example.invalid");
    await w.airtable.containersApi.delete(c1.id);
    const c3 = await w.airtable.containersApi.create({ trackingNumber: "T3" }, "a@example.invalid");
    expect([c2.containerId, c3.containerId]).toEqual(["PMX-CON-2026-002", "PMX-CON-2026-002"]);
  });

  it("documents that the container sequence never restarts in a new year (count of ALL containers + 1)", async () => {
    const w = await freshWorld();
    await w.airtable.containersApi.create({ trackingNumber: "T1" }, "a@example.invalid");
    await w.airtable.containersApi.create({ trackingNumber: "T2" }, "a@example.invalid");
    const { vi } = await import("vitest");
    vi.setSystemTime(new Date("2027-01-05T10:00:00.000Z"));
    const next = await w.airtable.containersApi.create({ trackingNumber: "T3" }, "a@example.invalid");
    expect(next.containerId).toBe("PMX-CON-2027-003"); // Phase 3 R-6 expects PMX-CON-2027-001
  });
});

describe("customer creation (data layer)", () => {
  it(PRESERVE("creates an active customer with a generated mark and address"), async () => {
    const w = await freshWorld();
    const c = await w.airtable.customersApi.create(
      { name: "Ada Mensah", phone: "0244001234", email: "ada@example.invalid" },
      "admin@example.invalid"
    );
    expect(c.shippingMark).toBe("MOVEZZ-AM1234");
    expect(c.shippingAddress).toBe("MOVEZZ-AM1234, A-Z Bulk Warehouse, Amrahia, Adenta-Dodowa Road");
    expect(c.status).toBe("active");
    expect(c.package).toBeUndefined(); // no tier stored at creation; billing code treats undefined as "basic"
  });

  it(PRESERVE("an explicit shippingAddress overrides the generated one"), async () => {
    const w = await freshWorld();
    const c = await w.airtable.customersApi.create(
      { name: "Ada Mensah", phone: "0244001234", email: "ada@example.invalid", shippingAddress: "East Legon, Accra" },
      "admin@example.invalid"
    );
    expect(c.shippingAddress).toBe("East Legon, Accra");
  });

  it(FIXED("customer creation never hands out an existing shipping mark (-2, -3 ... suffix on collision)"), async () => {
    // Phase 3 rule R-2. The pure generator still collides (see utils.test.ts); the data layer resolves it.
    const w = await freshWorld();
    const a = await w.airtable.customersApi.create({ name: "Ada Mensah", phone: "0244001234", email: "a@example.invalid" }, "x@example.invalid");
    const b = await w.airtable.customersApi.create({ name: "Alice Mills", phone: "0200001234", email: "b@example.invalid" }, "x@example.invalid");
    const c = await w.airtable.customersApi.create({ name: "Amy Moore", phone: "0555551234", email: "c@example.invalid" }, "x@example.invalid");
    expect([a.shippingMark, b.shippingMark, c.shippingMark]).toEqual(["MOVEZZ-AM1234", "MOVEZZ-AM1234-2", "MOVEZZ-AM1234-3"]);
    expect(b.shippingAddress).toContain("MOVEZZ-AM1234-2");
  });

  it(PRESERVE("changing the name regenerates the mark and address (unless an explicit mark is supplied)"), async () => {
    const w = await freshWorld();
    const c = await w.airtable.customersApi.create({ name: "Ada Mensah", phone: "0244001234", email: "a@example.invalid" }, "x@example.invalid");
    const renamed = await w.airtable.customersApi.update(c.id, { name: "Kofi Boateng" }, "x@example.invalid");
    expect(renamed.shippingMark).toBe("MOVEZZ-KB1234");
    expect(renamed.shippingAddress).toContain("MOVEZZ-KB1234");
    const pinned = await w.airtable.customersApi.update(c.id, { shippingMark: "CUSTOM-1", name: "Someone Else" }, "x@example.invalid");
    expect(pinned.shippingMark).toBe("CUSTOM-1");
  });

  it(FIXED("changing name AND phone in one update derives the mark from the FINAL name and phone"), async () => {
    const w = await freshWorld();
    const c = await w.airtable.customersApi.create({ name: "Ada Mensah", phone: "0244001234", email: "a@example.invalid" }, "x@example.invalid");
    const updated = await w.airtable.customersApi.update(c.id, { name: "Kofi Boateng", phone: "0244009999" }, "x@example.invalid");
    expect(updated.name).toBe("Kofi Boateng");
    expect(updated.shippingMark).toBe("MOVEZZ-KB9999");
    expect(updated.shippingAddress).toContain("MOVEZZ-KB9999");
  });

  it(PRESERVE("changing the phone regenerates the mark from the new last 4 digits"), async () => {
    const w = await freshWorld();
    const c = await w.airtable.customersApi.create({ name: "Ada Mensah", phone: "0244001234", email: "a@example.invalid" }, "x@example.invalid");
    const updated = await w.airtable.customersApi.update(c.id, { phone: "0244009999" }, "x@example.invalid");
    expect(updated.shippingMark).toBe("MOVEZZ-AM9999");
  });

  it(PRESERVE("legacy package names are mapped when read (standard->basic, discounted->business, premium->enterprise)"), async () => {
    const w = await freshWorld();
    w.seed.customer("recA", { CustomerPackage: "standard" });
    w.seed.customer("recB", { CustomerPackage: "discounted" });
    w.seed.customer("recC", { CustomerPackage: "premium" });
    w.seed.customer("recD", { CustomerPackage: "special" });
    const read = async (id: string) => (await w.airtable.customersApi.getById(id)).package;
    expect([await read("recA"), await read("recB"), await read("recC"), await read("recD")]).toEqual(["basic", "business", "enterprise", "special"]);
  });
});
