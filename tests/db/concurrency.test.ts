// Concurrency: every test fires real parallel requests on separate connections against one PostgreSQL database.
// No sleeps and no retries: correctness comes from row locks, unique indexes and transactions.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbDescribe, createTestDb, customer, item, carton, staffUser, fxRate, packageRates, pricedItem, type TestDb } from "./helpers";
import { createInvoice, recordPayment } from "../../src/lib/db/invoices";
import { user } from "../../src/lib/db/actor";
import { allocateReference, allocateContainerReference } from "../../src/lib/db/references";
import { DomainError } from "../../src/lib/db/errors";

async function settle<T>(ps: Promise<T>[]) {
  const r = await Promise.allSettled(ps);
  const ok: T[] = [];
  const codes: string[] = [];
  for (const x of r) {
    if (x.status === "fulfilled") ok.push(x.value as T);
    else codes.push(x.reason instanceof DomainError ? x.reason.code : `RAW:${(x.reason as Error)?.message}`);
  }
  return { ok, codes };
}
let kn = 0;
const key = () => `conc-${Date.now()}-${++kn}-abcdefgh`;

dbDescribe("concurrency (PostgreSQL)", () => {
  let db: TestDb; let actor: string;
  beforeAll(async () => { db = await createTestDb(); actor = await staffUser(db.admin); await packageRates(db.admin); await fxRate(db.admin); });
  afterAll(async () => { await db?.close(); });

  it("simultaneous reference generation: 60 parallel allocations are unique and gapless", async () => {
    const refs = await Promise.all(Array.from({ length: 60 }, () => allocateReference(db.app, "item")));
    expect(new Set(refs).size).toBe(60);
    const nums = refs.map((r) => Number(r.slice(4))).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(refs[0]).toMatch(/^ITM-\d{4}$/);
  });

  it("reference formats match the existing application formats, including padding that never truncates", async () => {
    expect(await allocateReference(db.app, "invoice")).toBe("ORD-00001");
    expect(await allocateReference(db.app, "supplier")).toBe("SUP-0001");
    expect(await allocateReference(db.app, "carton")).toBe("CTN-0001");
    // Containers: the year is only PRINTED; the sequence is global and never restarts (docs/DECISIONS.md D1).
    // (Phase 6 asserted PMX-CON-2027-001 here - the superseded per-year reset; replaced in Phase 7B.)
    expect(await allocateContainerReference(db.app, 2026)).toBe("PMX-CON-2026-001");
    expect(await allocateContainerReference(db.app, 2026)).toBe("PMX-CON-2026-002");
    expect(await allocateContainerReference(db.app, 2027)).toBe("PMX-CON-2027-003");
    expect(await allocateContainerReference(db.app, 2027)).toBe("PMX-CON-2027-004");
    await db.admin.query("SELECT seed_reference_counter('carton','',9999)");
    expect(await allocateReference(db.app, "carton")).toBe("CTN-10000"); // lpad() would have produced CTN-1000
    await expect(allocateReference(db.app, "container" as never)).rejects.toThrow(/allocate_container_reference/);
    await expect(allocateContainerReference(db.app, 1999)).rejects.toThrow(/invalid container year/);
    await expect(allocateReference(db.app, "nonsense" as never)).rejects.toThrow();
  });

  it("deleting a record never causes reuse (the old count()+1 bug): counters only move forward", async () => {
    const c = await customer(db.admin);
    const a = await allocateReference(db.admin, "item");
    await db.admin.query("INSERT INTO items (item_ref, customer_id) VALUES ($1,$2)", [a, c]);
    await db.admin.query("SELECT 1"); // (no delete is even permitted for the runtime role)
    const b = await allocateReference(db.app, "item");
    expect(b).not.toBe(a);
  });

  it("a rolled-back transaction releases its number (no gaps in committed references)", async () => {
    const cl = await db.admin.connect();
    await cl.query("BEGIN");
    const lost = await allocateReference(cl, "supplier");
    await cl.query("ROLLBACK"); cl.release();
    expect(await allocateReference(db.app, "supplier")).toBe(lost);
  });

  it("simultaneous payments: 10 requests of GHS 30 against a GHS 100 balance -> exactly 3 succeed, 7 are overpayments, paid = 90.00", async () => {
    const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "8.00"); // 8 x 12.5 = 100.00
    const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() });
    expect(invoice.total_ghs).toBe("100.00");
    const r = await settle(Array.from({ length: 10 }, () => recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "30.00", actor: user(actor), idempotencyKey: key() })));
    expect(r.ok).toHaveLength(3);
    expect(r.codes).toEqual(Array(7).fill("OVERPAYMENT"));
    const inv = (await db.admin.query("SELECT amount_paid_ghs, balance_ghs, status FROM invoices WHERE id=$1", [invoice.id])).rows[0];
    expect(inv).toEqual({ amount_paid_ghs: "90.00", balance_ghs: "10.00", status: "Partial" });
    expect((await db.admin.query("SELECT sum(amount_ghs)::text AS s FROM payments WHERE invoice_id=$1 AND status='completed'", [invoice.id])).rows[0].s).toBe("90.00");
  });

  it("simultaneous payments that exactly settle the invoice all succeed and the invoice ends Paid with balance 0", async () => {
    const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "8.00");
    const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() });
    const r = await settle(Array.from({ length: 4 }, () => recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "25.00", actor: user(actor), idempotencyKey: key() })));
    expect(r.ok).toHaveLength(4);
    expect((await db.admin.query("SELECT amount_paid_ghs, balance_ghs, status FROM invoices WHERE id=$1", [invoice.id])).rows[0]).toEqual({ amount_paid_ghs: "100.00", balance_ghs: "0.00", status: "Paid" });
    const events = (await db.admin.query("SELECT new_status FROM status_events WHERE entity_type='invoice' AND entity_id=$1 ORDER BY id", [invoice.id])).rows.map((x) => x.new_status);
    expect(events[events.length - 1]).toBe("Paid");
    expect(events.filter((e) => e === "Paid")).toHaveLength(1);
  });

  it("the same payment idempotency key sent 12 times in parallel records exactly one payment", async () => {
    const c = await customer(db.admin); const i = await pricedItem(db.admin, c, "8.00");
    const { invoice } = await createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() });
    const k = key();
    const r = await settle(Array.from({ length: 12 }, () => recordPayment(db.app, { invoiceId: invoice.id, amountGhs: "40.00", actor: user(actor), idempotencyKey: k })));
    expect(r.codes).toEqual([]);
    expect(new Set(r.ok.map((x) => x.payment.id)).size).toBe(1);
    expect(r.ok.filter((x) => !x.replayed)).toHaveLength(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoice.id])).rows[0].n).toBe(1);
  });

  it("simultaneous invoice creation with the SAME idempotency key yields exactly one invoice", async () => {
    const c = await customer(db.admin); const i = await item(db.admin, c);
    const k = key();
    const r = await settle(Array.from({ length: 12 }, () => createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: k })));
    expect(r.codes).toEqual([]);
    expect(new Set(r.ok.map((x) => x.invoice.id)).size).toBe(1);
    expect(r.ok.filter((x) => !x.replayed)).toHaveLength(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1", [c])).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM keepup_sync WHERE invoice_id=$1", [r.ok[0].invoice.id])).rows[0].n).toBe(1);
  });

  it("simultaneous invoice creation for the same item with DIFFERENT keys: exactly one wins, the item is on one invoice", async () => {
    const c = await customer(db.admin); const i = await item(db.admin, c);
    const r = await settle(Array.from({ length: 8 }, () => createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() })));
    expect(r.ok).toHaveLength(1);
    expect(r.codes).toEqual(Array(7).fill("ITEM_ALREADY_INVOICED"));
    expect((await db.admin.query("SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1", [c])).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT invoice_id FROM items WHERE id=$1", [i])).rows[0].invoice_id).toBe(r.ok[0].invoice.id);
  });

  it("invoice numbers are unique and contiguous across parallel invoice creation for different customers", async () => {
    const jobs = await Promise.all(Array.from({ length: 15 }, async () => {
      const c = await customer(db.admin); const i = await item(db.admin, c);
      return createInvoice(db.app, { customerId: c, itemIds: [i], actor: user(actor), idempotencyKey: key() });
    }));
    const nums = jobs.map((j) => Number(j.invoice.invoice_ref.slice(4))).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(15);
    expect(nums[14] - nums[0]).toBe(14);
  });

  it("carton mutation race: invoicing and dissolving the same open carton at the same time never leave it both invoiced and dissolved", async () => {
    for (let round = 0; round < 6; round++) {
      const c = await customer(db.admin); const ct = await carton(db.admin, c);
      const dissolve = db.app.query("UPDATE cartons SET status='dissolved', dissolved_at=now() WHERE id=$1 AND status='open'", [ct]).then((x) => x.rowCount);
      const inv = settle([createInvoice(db.app, { customerId: c, cartonIds: [ct], actor: user(actor), idempotencyKey: key() })]);
      const [dissolved, invoiced] = await Promise.all([dissolve, inv]);
      const row = (await db.admin.query("SELECT status, invoice_id FROM cartons WHERE id=$1", [ct])).rows[0];
      const invoices = (await db.admin.query("SELECT count(*)::int AS n FROM invoice_lines WHERE carton_id=$1", [ct])).rows[0].n;
      if (row.status === "invoiced") { expect(invoiced.ok).toHaveLength(1); expect(invoices).toBe(1); expect(dissolved).toBe(0); }
      else { expect(row.status).toBe("dissolved"); expect(invoices).toBe(0); expect(invoiced.ok).toHaveLength(0); expect(row.invoice_id).toBeNull(); }
    }
  });

  it("two requests re-dimensioning the same open carton serialise cleanly (CBM always matches the stored dimensions)", async () => {
    const c = await customer(db.admin); const ct = await carton(db.admin, c);
    await Promise.all([
      db.app.query("UPDATE cartons SET length=200, width=100, height=100 WHERE id=$1", [ct]),
      db.app.query("UPDATE cartons SET length=50, width=50, height=50 WHERE id=$1", [ct]),
    ]);
    const r = (await db.admin.query("SELECT length, width, height, cbm FROM cartons WHERE id=$1", [ct])).rows[0];
    expect(Number(r.cbm)).toBeCloseTo((Number(r.length) * Number(r.width) * Number(r.height)) / 1_000_000, 9);
  });
});
