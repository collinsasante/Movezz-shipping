// Group D/E: orders (= invoices), invoice creation/cancellation, payments on PostgreSQL. Staff have no financial access (D6); customers see their own.
// The route validates and delegates: pricing, FX, discounts, locking, idempotency, immutability, audit and Keepup state are the invoice service's job.
import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { z } from "zod";
import { sendPaymentConfirmedEmail, sendPartialPaymentEmail } from "@/lib/email";
import { getPool } from "@/lib/db/client";
import { authorize, isAllowed } from "@/lib/db/authz";
import { createInvoice, recordPayment, cancelInvoice } from "@/lib/db/invoices";
import { retryKeepupSync } from "@/lib/db/integration-admin";
import { recordAudit } from "@/lib/db/audit";
import { DomainError } from "@/lib/db/errors";
import { isUuid, ownerScope, selectItems, selectOrders, countOrders, selectOrdersPage } from "@/lib/db/app-queries";
import { pgRoute, pgServiceRoute, readAs, ok, parseInput, readJson, readJsonOptional, throttle, type RouteCtx } from "@/lib/pg-api";

type P = { params: Promise<Record<string, string>> };
const bad = (m: string) => new DomainError("INVALID_INPUT", m);
const adminOnly = (actor: Parameters<typeof readAs>[0]) => readAs(actor, (tx) => authorize(tx, "invoice.read.any"));   // financial administration: super_admin
const notFound = () => new DomainError("NOT_FOUND", "Order not found");

/** Financial read access: super_admin (any) or the customer (own). Warehouse staff have none. */
function financialScope(c: RouteCtx): string | null {
  if (!isAllowed(c.actor, "invoice.read.any") && !isAllowed(c.actor, "invoice.read.own")) throw new DomainError("NOT_AUTHORIZED", "Forbidden");
  return ownerScope(c.actor);
}

export const ordersGet = (request: NextRequest) => pgRoute(request, undefined, ["super_admin", "warehouse_staff", "customer"], async (c) => {
  const scope = financialScope(c);
  const sp = new URL(c.request.url).searchParams;
  const pg = Math.max(1, parseInt(sp.get("page") ?? "1") || 1); const limit = 50;
  const cust = scope ?? sp.get("customerId");
  if (cust && !isUuid(cust)) return ok([], { total: 0, totalPages: 1, page: pg });
  const s = (sp.get("search") ?? "").trim().toLowerCase().replace(/[%_\\]/g, "");
  const st = sp.get("status");
  const where = `($1::uuid IS NULL OR v.customer_id = $1) AND ($2::text IS NULL OR v.status = $2) AND v.status <> 'Cancelled' AND ($3 = '' OR lower(v.invoice_ref) LIKE '%'||$3||'%' OR lower(c.name) LIKE '%'||$3||'%' OR lower(c.shipping_mark) LIKE '%'||$3||'%')`;
  const vals = [cust ?? null, st === "Pending" || st === "Partial" || st === "Paid" ? st : null, s];
  const total = await countOrders(c.tx, where, vals);                               // paged in SQL
  const data = await selectOrdersPage(c.tx, where, vals, limit, (pg - 1) * limit);
  return ok(data, { total, totalPages: Math.max(1, Math.ceil(total / limit)), page: pg });
});

async function loadOrder(tx: PoolClient, c: RouteCtx, id: string) {
  const scope = financialScope(c);
  if (!isUuid(id)) throw notFound();
  const o = (await selectOrders(tx, "v.id = $1 AND ($2::uuid IS NULL OR v.customer_id = $2)", [id, scope]))[0];
  if (!o) throw notFound();
  return o;
}

export const orderGet = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin", "warehouse_staff", "customer"], async (c) => {
  const order = await loadOrder(c.tx, c, c.params.id);
  const items = await selectItems(c.tx, "i.invoice_id = $1", [order.id]);
  // frozen at issue time (the invoice's own FX), never recomputed from today's rate; Keepup figures are the ledger the worker pushes
  return ok({ ...order, items, invoiceTotalGhs: order.totalGhs, keepupTotalAmount: order.totalGhs, keepupAmountPaid: order.amountPaid ?? 0, keepupBalanceDue: order.balanceDue ?? 0 });
});

const CreateOrder = z.object({
  customerId: z.string().min(1, "Customer ID is required"), itemIds: z.array(z.string()).min(1, "At least one item is required"),
  invoiceAmount: z.number().optional(),                       // accepted for compatibility, NEVER used: the server computes the subtotal
  invoiceDate: z.string().optional(), notes: z.string().max(2000).optional(),
  discount: z.number().min(0).max(1_000_000).optional(), discountReason: z.string().max(500).optional(),
});

export const ordersPost = (request: NextRequest) => pgServiceRoute(request, undefined, async (c) => {
  const d = parseInput(CreateOrder, await readJson(c.request));
  if (!isUuid(d.customerId) || d.itemIds.some((i) => !isUuid(i))) throw bad("One or more items do not exist");
  const ids = Array.from(new Set(d.itemIds));
  const rows = await readAs(c.actor, async (tx) => (await tx.query("SELECT id, carton_id FROM items WHERE id = ANY($1::uuid[])", [ids])).rows);
  if (rows.length !== ids.length) throw bad("One or more items do not exist");
  const cartonIds = Array.from(new Set(rows.map((r) => r.carton_id).filter(Boolean))) as string[];
  if (cartonIds.length) {
    const members = await readAs(c.actor, async (tx) => (await tx.query("SELECT id FROM items WHERE carton_id = ANY($1::uuid[]) AND archived_at IS NULL", [cartonIds])).rows.map((r) => r.id as string));
    if (members.some((m) => !ids.includes(m))) throw bad("A carton must be invoiced with all of its items");
  }
  const loose = rows.filter((r) => !r.carton_id).map((r) => r.id as string);
  const { invoice, replayed } = await createInvoice(getPool(), {
    customerId: d.customerId, itemIds: loose, cartonIds, invoiceDate: d.invoiceDate?.slice(0, 10), notes: d.notes,
    ...(d.discount ? { discountUsd: d.discount.toFixed(2), discountReason: d.discountReason ?? "" } : {}),
    actor: c.actor, idempotencyKey: c.idempotencyKey,
  });
  const order = (await readAs(c.actor, (tx) => selectOrders(tx, "v.id = $1", [invoice.id])))[0];
  return ok(order, { message: `Order ${order.orderRef} created successfully` }, replayed ? 200 : 201);
});

const UpdateOrder = z.object({
  invoiceAmount: z.number().positive().optional(), discount: z.number().min(0).optional(), invoiceDate: z.string().optional(), status: z.enum(["Pending", "Partial", "Paid"]).optional(),
  notes: z.string().optional(), itemIds: z.array(z.string()).optional(), syncKeeup: z.boolean().optional(), paymentAmount: z.number().positive().optional(),
});
const same = (a: number, b: number | undefined) => Math.abs(a - (b ?? 0)) < 0.005;

export const orderPatch = (request: NextRequest, p: P) => pgServiceRoute(request, p.params, async (c) => {
  await adminOnly(c.actor);
  const d = parseInput(UpdateOrder, await readJson(c.request));
  const id = c.params.id; if (!isUuid(id)) throw notFound();
  const cur = await readAs(c.actor, async (tx) => ({ order: (await selectOrders(tx, "v.id = $1", [id]))[0], tx: null }));
  const o = cur.order; if (!o) throw notFound();
  // an issued invoice is immutable (locked financial model): any attempt to change what was issued is refused, an unchanged echo is fine
  const immutable = (d.invoiceAmount !== undefined && !same(o.invoiceAmount, d.invoiceAmount)) || (d.discount !== undefined && !same(o.discount ?? 0, d.discount))
    || (d.invoiceDate !== undefined && d.invoiceDate.slice(0, 10) !== o.invoiceDate) || (d.itemIds !== undefined && (d.itemIds.length !== o.itemIds.length || d.itemIds.some((i) => !o.itemIds.includes(i))));
  if (immutable) throw new DomainError("IMMUTABLE_RECORD", "An issued invoice cannot be changed. Cancel it and issue a new one.");
  if (d.status && d.status !== "Paid" && d.status !== o.status) throw new DomainError("INVALID_STATE", "The payment status follows the recorded payments and cannot be set directly");
  if (o.status === "Cancelled") throw new DomainError("INVALID_STATE", "This invoice is cancelled");

  let amount: string | null = null;
  if (d.paymentAmount !== undefined) amount = d.paymentAmount.toFixed(2);
  else if (d.status === "Paid" && o.status !== "Paid" && (o.balanceDue ?? 0) > 0) amount = (o.balanceDue as number).toFixed(2);
  let paid: Awaited<ReturnType<typeof recordPayment>> | null = null;
  if (amount) paid = await recordPayment(getPool(), { invoiceId: id, amountGhs: amount, method: "manual", source: "manual", actor: c.actor, idempotencyKey: c.idempotencyKey });
  if (d.notes !== undefined) await readAs(c.actor, async (tx) => { await tx.query("UPDATE invoices SET notes = $2 WHERE id = $1", [id, d.notes]); await recordAudit(tx, { action: "invoice.notes", entityType: "invoice", entityId: id }); });
  const order = (await readAs(c.actor, (tx) => selectOrders(tx, "v.id = $1", [id])))[0];

  if (paid && !paid.replayed) {   // best-effort customer e-mail after the payment committed
    const cust = await readAs(c.actor, async (tx) => (await tx.query("SELECT email, name FROM customers WHERE id = $1", [order.customerId])).rows[0]);
    if (cust?.email) {
      if (order.status === "Paid") await sendPaymentConfirmedEmail({ to: cust.email, customerName: cust.name, orderRef: order.orderRef, invoiceAmount: order.totalGhs ?? 0, currency: "GHS" }).catch(() => {});
      else await sendPartialPaymentEmail({ to: cust.email, customerName: cust.name, orderRef: order.orderRef, amountPaid: order.amountPaid ?? 0, balanceDue: order.balanceDue ?? 0, currency: "GHS", keepupLink: order.keepupLink }).catch(() => {});
    }
  }
  return ok(order, { message: "Order updated successfully" });
});

export const orderDelete = (request: NextRequest, p: P) => pgServiceRoute(request, p.params, async (c) => {
  const id = c.params.id; if (!isUuid(id)) throw notFound();
  const body = (await readJsonOptional(c.request)) as { reason?: string };
  const reason = typeof body.reason === "string" && /\S/.test(body.reason) ? body.reason : "Deleted by an administrator from the orders screen";
  await cancelInvoice(getPool(), { invoiceId: id, reason, actor: c.actor, idempotencyKey: c.idempotencyKey });
  return { body: { success: true, message: "Order deleted" } };
});

// ---------------------------------------------------------------- Keepup state (the worker owns synchronisation; routes only report / request)
export const createInvoicePost = (request: NextRequest, p: P) => pgServiceRoute(request, p.params, async (c) => {
  await adminOnly(c.actor);
  throttle(c.actor.userId ?? null, "create-invoice", 10);
  const id = c.params.id; if (!isUuid(id)) throw notFound();
  const regenerate = ((await readJsonOptional(c.request)) as { regenerate?: boolean }).regenerate === true;
  const row = await readAs(c.actor, async (tx) => {
    const inv = (await tx.query("SELECT v.status, v.keepup_sale_id, v.keepup_link, k.id AS sync_id, k.sync_state FROM invoices v LEFT JOIN keepup_sync k ON k.invoice_id = v.id AND k.kind = 'invoice' WHERE v.id = $1", [id])).rows[0];
    return inv;
  });
  if (!row) throw notFound();
  if (row.status === "Paid") return { status: 400, body: { success: false, error: "Cannot create invoice for a paid order" } };
  if (row.status === "Cancelled") throw new DomainError("INVALID_STATE", "This invoice is cancelled");
  if (row.keepup_sale_id) {
    if (regenerate) throw new DomainError("INVALID_STATE", "The Keepup invoice already exists and cannot be regenerated");
    return { body: { success: true, data: { saleId: row.keepup_sale_id, link: row.keepup_link ?? null, existing: true }, message: "Invoice already exists in Keepup" } };
  }
  if (regenerate && row.sync_state === "failed") {
    await retryKeepupSync(getPool(), { syncId: row.sync_id, reason: "retry requested from the orders screen", actor: c.actor });
  } else if (regenerate) throw new DomainError("INVALID_STATE", "Only a synchronisation that failed can be retried");
  return { status: 202, body: { success: true, data: { saleId: null, link: null, existing: false, syncState: row.sync_state ?? "pending" }, message: "The invoice is queued for Keepup synchronisation" } };
});
// The cancel screen calls this before DELETE /api/orders/[id]. Keepup links are owned by the synchronisation worker and cancellation is one transaction
// in the invoice service, so there is nothing to clear: report success without changing anything (the real cancellation follows).
export const createInvoiceDelete = (request: NextRequest, p: P) => pgServiceRoute(request, p.params, async (c) => {
  await adminOnly(c.actor);
  return { body: { success: true, message: "Nothing to clear: Keepup links are managed by the synchronisation worker" } };
});
export const keepupSyncPost = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  throttle(c.actor.userId, "keepup-sync", 6);
  // PostgreSQL is the ledger and pushes to Keepup through the worker; there is nothing to pull back into the orders
  const r = (await c.tx.query(`SELECT count(*) FILTER (WHERE k.sync_state = 'synced')::int AS synced, count(*) FILTER (WHERE k.sync_state IN ('failed','needs_reconciliation','outcome_unknown'))::int AS errors FROM keepup_sync k WHERE k.kind = 'invoice'`)).rows[0];
  return { body: { success: true, synced: r.synced, updated: 0, errors: r.errors } };
});
