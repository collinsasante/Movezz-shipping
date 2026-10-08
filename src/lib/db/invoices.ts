// Invoice and payment operations. Each exported function is ONE transaction: either every step commits or none does.
// This is a deliberately small reference implementation of the target architecture (route -> service -> repository);
// the existing Airtable-backed routes are NOT switched to it in this phase.
import type { Pool } from "pg";
import { withActorTransaction, currentActorId, type ActorAssertion } from "./actor";
import { recordAudit, recordStatusEvent } from "./audit";
import { DomainError } from "./errors";
import { allocateReference } from "./references";
import { assertNoClientFinancials } from "./pricing";
import { beginIdempotent, completeIdempotent, fingerprint } from "./idempotency";

export interface CreateInvoiceInput {
  customerId: string;
  itemIds?: string[];               // loose items (not in a carton)
  cartonIds?: string[];             // open cartons; their member items are billed through the carton line
  discountUsd?: string;             // decimal string, default "0". Only a super_admin (database role of the verified actor) may use it.
  discountReason?: string;          // required (non-blank) when discountUsd > 0; frozen on the invoice
  invoiceDate?: string;             // YYYY-MM-DD
  notes?: string;
  /** The authenticated actor from the server auth layer (never request input). Verified by PostgreSQL. */
  actor: ActorAssertion;
  idempotencyKey: string;
  request?: { ip?: string; userAgent?: string };
}

export interface InvoiceRow {
  id: string; invoice_ref: string; customer_id: string; status: string;
  subtotal_usd: string; discount_usd: string; total_usd: string; fx_rate: string; fx_estimated: boolean;
  total_ghs: string; amount_paid_ghs: string; balance_ghs: string;
}

type Line = {
  item_id: string | null; carton_id: string | null; description: string; unit: string; basis: "tier" | "special";
  tier: string | null; rate: string | null; special_rate_id: string | null; special_rate_name: string | null; metadata: unknown;
};

const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * Creates an invoice. Every money value is computed here from authoritative database data; the caller supplies only WHAT to bill
 * (items/cartons), an optional discount (super_admin only) with its reason, and metadata. Prices, billing basis, special rates,
 * subtotal, FX and totals cannot be supplied (assertNoClientFinancials rejects them) and the database re-validates them.
 */
export async function createInvoice(db: Pool, input: CreateInvoiceInput): Promise<{ invoice: InvoiceRow; replayed: boolean }> {
  assertNoClientFinancials(input, "createInvoice");
  const itemIds = uniq(input.itemIds ?? []).sort();
  const cartonIds = uniq(input.cartonIds ?? []).sort();
  if (itemIds.length + cartonIds.length === 0) throw new DomainError("INVALID_INPUT", "An invoice needs at least one item or carton");
  const discount = input.discountUsd ?? "0";
  if (!/^\d+(\.\d{1,2})?$/.test(discount)) throw new DomainError("DISCOUNT_INVALID", "Discount must be a non-negative amount with at most 2 decimals");
  const discounted = Number(discount) > 0;
  if (discounted && !/\S/.test(input.discountReason ?? "")) throw new DomainError("DISCOUNT_INVALID", "A discount needs a reason");

  const requestHash = fingerprint({ c: input.customerId, i: itemIds, k: cartonIds, d: discount, r: input.discountReason ?? null, date: input.invoiceDate ?? null, n: input.notes ?? null });

  return withActorTransaction(db, input.actor, async (tx) => {
    const actorId = await currentActorId(tx);
    const idem = await beginIdempotent(tx, { scope: "invoice.create", actorUserId: actorId, key: input.idempotencyKey, requestHash });
    if (idem.state === "replay") {
      const inv = (await tx.query<InvoiceRow>("SELECT * FROM invoices WHERE id = $1", [idem.resultEntityId])).rows[0];
      return { invoice: inv, replayed: true };
    }

    // discount authority (D16): decided from the DATABASE role of the verified actor, never from the request. The invoice
    // trigger (0011) enforces the same rule for any other path.
    if (discounted && (await tx.query<{ r: string | null }>("SELECT movezz_sec.actor_role() AS r")).rows[0].r !== "super_admin") {
      throw new DomainError("DISCOUNT_NOT_AUTHORIZED", "Only a super_admin may grant a discount");
    }

    // 1. ownership + state: lock the rows and require every one to belong to the customer and be uninvoiced
    const customer = (await tx.query("SELECT id, email, archived_at FROM customers WHERE id = $1 FOR SHARE", [input.customerId])).rows[0];
    if (!customer || customer.archived_at) throw new DomainError("NOT_FOUND", "Customer not found");

    const items = itemIds.length
      ? (await tx.query(
          `SELECT * FROM items WHERE id = ANY($1::uuid[]) AND customer_id = $2 AND invoice_id IS NULL AND carton_id IS NULL AND archived_at IS NULL ORDER BY id FOR UPDATE`,
          [itemIds, input.customerId])).rows
      : [];
    if (items.length !== itemIds.length) throw new DomainError("INVALID_INPUT", "Every item must exist, belong to the customer, be uninvoiced and not be in a carton");
    const cartons = cartonIds.length
      ? (await tx.query(
          `SELECT * FROM cartons WHERE id = ANY($1::uuid[]) AND customer_id = $2 AND status = 'open' ORDER BY id FOR UPDATE`,
          [cartonIds, input.customerId])).rows
      : [];
    if (cartons.length !== cartonIds.length) throw new DomainError("INVALID_INPUT", "Every carton must exist, belong to the customer and be open");

    // 2. pricing is recomputed HERE by PostgreSQL (item_authoritative_price) in one statement, so every line comes from one
    //    consistent set of rate rows. The item must already have been priced by staff (D5: unpriced items are never invoiced);
    //    its staff-selected special card is re-validated now and never silently replaced by the tier price.
    const lines: Line[] = [];
    for (const it of items) {
      const stored = it.billing_basis === "special" ? it.special_price_usd : it.tier_price_usd;
      if (stored === null || it.freight_type === null) throw new DomainError("ITEM_UNPRICED", `Item ${it.item_ref} has no price`);
    }
    if (items.length) {
      const fresh = (await tx.query(
        `SELECT x.id, p.* FROM unnest($1::uuid[], $2::uuid[]) AS x(id, card), LATERAL item_authoritative_price(x.id, x.card) p`,
        [items.map((i) => i.id), items.map((i) => (i.billing_basis === "special" ? i.special_rate_id : null))])).rows;
      const byId = new Map(fresh.map((r) => [r.id as string, r]));
      for (const it of items) {
        const p = byId.get(it.id);
        if (!p) throw new DomainError("PRICING_NOT_FOUND", `No authoritative price for item ${it.item_ref}`);
        const special = p.billing_basis === "special";
        const changed = String(it.tier_price_usd) !== String(p.tier_price_usd) || (special && String(it.special_price_usd) !== String(p.special_price_usd)) || it.billing_basis !== p.billing_basis;
        if (changed) {
          await tx.query(
            `UPDATE items SET package_tier = $2, tier_rate_usd = $3, tier_price_usd = $4, billing_basis = $5,
                    special_rate_id = $6, special_rate_name = $7, special_rate_usd = $8, special_price_usd = $9 WHERE id = $1`,
            [it.id, p.package_tier, p.tier_rate_usd, p.tier_price_usd, p.billing_basis, p.special_rate_id, p.special_rate_name, p.special_rate_usd, p.special_price_usd]);
          await recordAudit(tx, { action: "item.reprice", entityType: "item", entityId: it.id, request: input.request,
            before: { tier_price_usd: String(it.tier_price_usd), special_price_usd: it.special_price_usd === null ? null : String(it.special_price_usd) },
            after: { billing_basis: p.billing_basis, tier_price_usd: String(p.tier_price_usd), special_price_usd: special ? String(p.special_price_usd) : null, reason: "repriced at invoicing" } });
        }
        lines.push({
          item_id: it.id, carton_id: null, description: it.description || it.item_ref, unit: String(special ? p.special_price_usd : p.tier_price_usd), basis: p.billing_basis,
          tier: p.package_tier, rate: String(special ? p.special_rate_usd : p.tier_rate_usd),
          special_rate_id: special ? p.special_rate_id : null, special_rate_name: special ? p.special_rate_name : null,
          metadata: { item_ref: it.item_ref, tracking_number: it.tracking_number, cbm_total: it.cbm_total },
        });
      }
    }
    for (const c of cartons) {
      if (c.price_usd === null || Number(c.price_usd) <= 0) throw new DomainError("ITEM_UNPRICED", `Carton ${c.carton_ref} has no price`);
      lines.push({
        item_id: null, carton_id: c.id, description: `Carton ${c.carton_ref}`, unit: String(c.price_usd), basis: c.pricing_basis,
        tier: c.package_tier, rate: c.rate_usd === null ? null : String(c.rate_usd), special_rate_id: null, special_rate_name: null,
        metadata: { carton_ref: c.carton_ref, cbm: c.cbm },
      });
    }

    // 3. freeze FX (raises FX_RATE_MISSING; never defaults) and the money totals, all in NUMERIC
    const fx = (await tx.query("SELECT id, rate FROM current_fx_rate('USD', 'GHS', now())")).rows[0]; // MV001 -> FX_RATE_MISSING; never defaults
    if (!(Number(fx.rate) >= 0.1 && Number(fx.rate) <= 1000)) throw new DomainError("FX_RATE_INVALID", "The configured USD->GHS rate is outside the accepted range");
    const subtotal = (await tx.query<{ s: string }>("SELECT coalesce(sum(p), 0)::text AS s FROM unnest($1::numeric[]) p", [lines.map((l) => l.unit)])).rows[0].s;
    if ((await tx.query<{ bad: boolean }>("SELECT $1::numeric > $2::numeric AS bad", [discount, subtotal])).rows[0].bad) {
      throw new DomainError("DISCOUNT_INVALID", "The discount cannot exceed the invoice subtotal");
    }

    // 4. everything below is the same transaction
    const ref = await allocateReference(tx, "invoice");
    const inv = (await tx.query<InvoiceRow>(
      `INSERT INTO invoices (invoice_ref, customer_id, invoice_date, subtotal_usd, discount_usd, discount_reason, fx_rate, fx_rate_id, total_ghs,
                             external_idempotency_key, notes, created_by)
       VALUES ($1, $2, coalesce($3::date, current_date), $4::numeric, $5::numeric, $11, $6::numeric, $7,
               round(($4::numeric - $5::numeric) * $6::numeric, 2), $8, $9, $10)
       RETURNING *`,
      [ref, input.customerId, input.invoiceDate ?? null, subtotal, discount, fx.rate, fx.id, input.idempotencyKey, input.notes ?? null, null, input.discountReason ?? null] // created_by is stamped by the database from the verified actor
    )).rows[0];

    let n = 0;
    for (const l of lines) {
      await tx.query(
        `INSERT INTO invoice_lines (invoice_id, line_no, item_id, carton_id, description, quantity, unit_price_usd, line_total_usd,
                                    billing_basis, package_tier, rate_usd, special_rate_id, special_rate_name, metadata)
         VALUES ($1, $2, $3, $4, $5, 1, $6::numeric, $6::numeric, $7, $8, $9::numeric, $10, $11, $12)`,
        [inv.id, ++n, l.item_id, l.carton_id, l.description, l.unit, l.basis, l.tier, l.rate, l.special_rate_id, l.special_rate_name, JSON.stringify(l.metadata)]
      );
    }
    if (itemIds.length) await tx.query("UPDATE items SET invoice_id = $1 WHERE id = ANY($2::uuid[])", [inv.id, itemIds]);
    if (cartonIds.length) {
      await tx.query("UPDATE items SET invoice_id = $1 WHERE carton_id = ANY($2::uuid[]) AND invoice_id IS NULL", [inv.id, cartonIds]);
      await tx.query("UPDATE cartons SET status = 'invoiced', invoice_id = $1 WHERE id = ANY($2::uuid[])", [inv.id, cartonIds]);
      for (const id of cartonIds) {
        await recordStatusEvent(tx, { entityType: "carton", entityId: id, from: "open", to: "invoiced", reason: `invoiced on ${ref}` });
      }
    }
    // 'Paid' for a zero-total invoice (the database settles it)
    await recordStatusEvent(tx, { entityType: "invoice", entityId: inv.id, from: null, to: inv.status });
    await recordAudit(tx, {
      action: "invoice.create", entityType: "invoice", entityId: inv.id, request: input.request,
      after: { invoice_ref: ref, customer_id: input.customerId, subtotal_usd: subtotal, discount_usd: discount, fx_rate: String(fx.rate), total_ghs: inv.total_ghs, lines: lines.length },
    });
    if (discounted) {
      // the reason is part of the immutable invoice snapshot AND of the audit trail; the actor is the verified super_admin
      await recordAudit(tx, { action: "invoice.discount", entityType: "invoice", entityId: inv.id, request: input.request,
        after: { discount_usd: discount, discount_reason: input.discountReason, subtotal_usd: subtotal, invoice_ref: ref } });
    }
    // Keepup is created later by a worker from this row (never inline): the state machine starts at 'pending'.
    // A zero-total invoice is Movezz-only (docs/DECISIONS.md A2): no Keepup sale, sync state 'not_required'.
    await tx.query(`INSERT INTO keepup_sync (kind, invoice_id, idempotency_key, sync_state) VALUES ('invoice', $1, $2, $3)`,
      [inv.id, `invoice:${inv.id}`, Number(inv.total_ghs) === 0 ? "not_required" : "pending"]);
    if (customer.email) {
      await tx.query(
        `INSERT INTO notification_outbox (event_type, channel, recipient, payload, dedupe_key) VALUES ('invoice.created', 'email', $1, $2, $3)`,
        [customer.email, JSON.stringify({ invoice_id: inv.id, invoice_ref: ref, total_ghs: inv.total_ghs }), `invoice.created:${inv.id}`]
      );
    }
    await completeIdempotent(tx, idem.id, { entityType: "invoice", entityId: inv.id });
    return { invoice: inv, replayed: false };
  });
}

export interface RecordPaymentInput {
  invoiceId: string;
  amountGhs: string;                // decimal string, GHS, > 0
  method?: string;
  source?: "manual" | "keepup" | "import";
  externalReference?: string;
  keepupReference?: string;
  usdEquivalent?: string;           // historical snapshot only
  actor: ActorAssertion;
  idempotencyKey: string;
  request?: { ip?: string; userAgent?: string };
}

export async function recordPayment(db: Pool, input: RecordPaymentInput) {
  if (!/^\d+(\.\d{1,2})?$/.test(input.amountGhs) || Number(input.amountGhs) <= 0) {
    throw new DomainError("INVALID_INPUT", "Payment amount must be a positive GHS amount with at most 2 decimals");
  }
  const requestHash = fingerprint({ i: input.invoiceId, a: input.amountGhs, m: input.method ?? null, s: input.source ?? null, e: input.externalReference ?? null, k: input.keepupReference ?? null });
  return withActorTransaction(db, input.actor, async (tx) => {
    const actorId = await currentActorId(tx);
    const idem = await beginIdempotent(tx, { scope: "payment.create", actorUserId: actorId, key: input.idempotencyKey, requestHash });
    if (idem.state === "replay") {
      const p = (await tx.query("SELECT * FROM payments WHERE id = $1", [idem.resultEntityId])).rows[0];
      const inv = (await tx.query<InvoiceRow>("SELECT * FROM invoices WHERE id = $1", [p.invoice_id])).rows[0];
      return { payment: p, invoice: inv, replayed: true };
    }
    // The payments triggers lock the invoice row, reject overpayment, and recompute paid/balance/status + status event.
    const payment = (await tx.query(
      `INSERT INTO payments (invoice_id, amount_ghs, usd_equivalent, method, source, external_reference, keepup_reference, idempotency_key, created_by)
       VALUES ($1, $2::numeric, $3::numeric, coalesce($4, 'other'), coalesce($5, 'manual'), $6, $7, $8, $9) RETURNING *`,
      [input.invoiceId, input.amountGhs, input.usdEquivalent ?? null, input.method ?? null, input.source ?? null, input.externalReference ?? null,
       input.keepupReference ?? null, input.idempotencyKey, null] // created_by is stamped by the database from the verified actor
    )).rows[0];
    const invoice = (await tx.query<InvoiceRow>("SELECT * FROM invoices WHERE id = $1", [input.invoiceId])).rows[0];
    await recordAudit(tx, {
      action: "payment.create", entityType: "payment", entityId: payment.id, request: input.request,
      after: { invoice_id: input.invoiceId, amount_ghs: input.amountGhs, method: payment.method, source: payment.source, invoice_status: invoice.status },
    });
    await completeIdempotent(tx, idem.id, { entityType: "payment", entityId: payment.id });
    return { payment, invoice, replayed: false };
  });
}

/** Reversal: marks the payment voided (never deletes it); the invoice's paid amount, balance and status follow. */
export async function voidPayment(db: Pool, input: { paymentId: string; reason: string; actor: ActorAssertion }) {
  if (!input.reason.trim()) throw new DomainError("INVALID_INPUT", "A void reason is required");
  return withActorTransaction(db, input.actor, async (tx) => {
    const p = (await tx.query(
      `UPDATE payments SET status = 'voided', voided_at = now(), void_reason = $2 WHERE id = $1 AND status = 'completed' RETURNING *`, // voided_by is stamped by the database
      [input.paymentId, input.reason]
    )).rows[0];
    if (!p) throw new DomainError("INVALID_STATE", "Payment not found or already voided");
    await recordStatusEvent(tx, { entityType: "payment", entityId: p.id, from: "completed", to: "voided", reason: input.reason });
    await recordAudit(tx, { action: "payment.void", entityType: "payment", entityId: p.id,
      after: { invoice_id: p.invoice_id, amount_ghs: String(p.amount_ghs), reason: input.reason } });
    const invoice = (await tx.query<InvoiceRow>("SELECT * FROM invoices WHERE id = $1", [p.invoice_id])).rows[0];
    return { payment: p, invoice };
  });
}

/** Cancels an invoice (never deletes). Refused while completed payments exist. Releasing items/cartons is a later-phase rule. */
export async function cancelInvoice(db: Pool, input: { invoiceId: string; reason: string; actor: ActorAssertion }) {
  if (!input.reason.trim()) throw new DomainError("INVALID_INPUT", "A cancel reason is required");
  return withActorTransaction(db, input.actor, async (tx) => {
    const old = (await tx.query("SELECT status FROM invoices WHERE id = $1 FOR UPDATE", [input.invoiceId])).rows[0];
    if (!old) throw new DomainError("NOT_FOUND", "Invoice not found");
    const inv = (await tx.query<InvoiceRow>(
      `UPDATE invoices SET status = 'Cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1 RETURNING *`, // cancelled_by is stamped by the database
      [input.invoiceId, input.reason]
    )).rows[0];
    await recordStatusEvent(tx, { entityType: "invoice", entityId: input.invoiceId, from: old.status, to: "Cancelled", reason: input.reason });
    await recordAudit(tx, { action: "invoice.cancel", entityType: "invoice", entityId: input.invoiceId, after: { reason: input.reason } });
    return inv;
  });
}
