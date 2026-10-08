// Group B: items, cartons, containers, sorting on PostgreSQL. Prices are NEVER taken from the client: they come from item_authoritative_price()
// (priceItem) and the carton pricing below, from package_rates / special_rates in the database. Ownership is applied in SQL.
import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { z } from "zod";
import { PhotoUrlSchema } from "@/lib/schemas";
import { sendItemStatusEmail } from "@/lib/email";
import { allocateReference, allocateContainerReference } from "@/lib/db/references";
import { priceItem } from "@/lib/db/pricing";
import { authorize, isAllowed } from "@/lib/db/authz";
import { recordAudit, recordStatusEvent } from "@/lib/db/audit";
import { DomainError, toDomainError } from "@/lib/db/errors";
import { containerOut, itemOut } from "@/lib/db/mappers";
import { isUuid, ownerScope, selectItems, countItems, selectItemsPage } from "@/lib/db/app-queries";
import { pgRoute, ok, parseInput, readJson, type RouteCtx } from "@/lib/pg-api";

type P = { params: Promise<Record<string, string>> };
const STAFF = ["super_admin", "warehouse_staff"] as const;
const STEPS = ["Arrived at Transit Warehouse", "Shipped to Ghana", "Arrived in Ghana", "Awaiting Customs Clearance & Duty Process", "Sorting", "Ready for Pickup", "Completed"] as const;
const PROGRESSING = new Set(["Arrived in Ghana", "Awaiting Customs Clearance & Duty Process", "Sorting", "Ready for Pickup", "Completed"]);
const bad = (m: string) => new DomainError("INVALID_INPUT", m);
const notFound = (what: string) => new DomainError("NOT_FOUND", `${what} not found`);
const actorEmail = async (tx: PoolClient, c: RouteCtx) => (await tx.query("SELECT email FROM users WHERE id = $1", [c.actor.userId])).rows[0]?.email as string | undefined;
const page = (sp: URLSearchParams, max: number) => { const rl = parseInt(sp.get("limit") ?? "0"); const limit = rl > 0 ? Math.min(rl, max) : 50; const pg = Math.max(1, parseInt(sp.get("page") ?? "1") || 1); return { limit, pg }; };

// ================================================================ items
const CreateItem = z.object({
  weight: z.number().positive("Weight must be positive").max(10000).optional(), shippingType: z.enum(["air", "sea"]).optional(),
  length: z.number().positive().max(10000).optional(), width: z.number().positive().max(10000).optional(), height: z.number().positive().max(10000).optional(),
  dimensionUnit: z.enum(["cm", "inches"]).default("cm"), description: z.string().max(1000).optional().default(""), dateReceived: z.string().max(50),
  trackingNumber: z.string().max(100).optional(), customerId: z.string().min(1, "Customer ID is required").max(50), quantity: z.number().int().positive().max(10000).optional(),
  notes: z.string().max(2000).optional(), photoUrls: z.array(PhotoUrlSchema).max(20).optional(),
  // accepted so existing clients keep working, but NEVER used: the server computes every price
  estPrice: z.number().optional(), estShippingPrice: z.number().optional(), pkgEstShipping: z.number().optional(), pkgShippingRate: z.number().optional(), specialShippingRate: z.number().optional(),
  isSpecialItem: z.boolean().optional(), specialRateName: z.string().max(100).optional(), specialRateId: z.string().uuid().optional(),
});
const UpdateItem = z.object({
  weight: z.number().positive().max(10_000).optional(), length: z.number().positive().max(10_000).optional(), width: z.number().positive().max(10_000).optional(), height: z.number().positive().max(10_000).optional(),
  description: z.string().max(1000).optional(), trackingNumber: z.string().max(100).optional(), notes: z.string().max(2000).optional(), orderId: z.string().max(50).optional(),
  containerId: z.string().max(50).optional(), customerId: z.string().max(50).optional(), isMissing: z.boolean().optional(), photoUrls: z.array(PhotoUrlSchema).max(20).optional(),
  estPrice: z.number().optional(), estShippingPrice: z.number().optional(), pkgEstShipping: z.number().optional(), pkgShippingRate: z.number().optional(),
  shippingType: z.enum(["air", "sea"]).optional(), dimensionUnit: z.enum(["cm", "inches"]).optional(), quantity: z.number().int().positive().max(10_000).optional(),
  status: z.string().max(100).optional(), dateReceived: z.string().max(50).optional(),
});

async function resolveSpecialRate(tx: PoolClient, customerId: string, name?: string, id?: string): Promise<string | null> {
  if (id) return id;
  if (!name) return null;
  const { rows } = await tx.query<{ id: string }>(
    "SELECT id FROM special_rates WHERE lower(name) = lower($1) AND is_active AND (customer_id IS NULL OR customer_id = $2) ORDER BY customer_id NULLS LAST", [name, customerId]);
  if (rows.length === 0) throw new DomainError("SPECIAL_RATE_NOT_FOUND", `Special rate "${name}" was not found for this customer`);
  if (rows.length > 1 && rows[0].id !== rows[1].id) { /* customer-specific card wins over a general one */ }
  return rows[0].id;
}

/** Prices (or re-prices) an item from the database. `strict` = an explicitly requested special rate: any failure aborts (no silent fallback). */
async function repriceItem(tx: PoolClient, itemId: string, specialRateId: string | null, strict: boolean): Promise<void> {
  await tx.query("SAVEPOINT reprice");
  try { await priceItem(tx, itemId, { specialRateId }); await tx.query("RELEASE SAVEPOINT reprice"); }
  catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT reprice");
    const m = toDomainError(e);
    const code = (m instanceof DomainError ? m.code : "") as string;
    if (strict || !["PRICING_NOT_FOUND", "PRICING_INVALID"].includes(code)) throw m;   // an item with no measurements yet is simply not priced yet
  }
}

async function loadItem(tx: PoolClient, c: RouteCtx, id: string) {
  const scope = ownerScope(c.actor);
  if (!isUuid(id)) throw notFound("Item");
  const r = await selectItems(tx, "i.id = $1 AND ($2::uuid IS NULL OR i.customer_id = $2)", [id, scope]);
  if (!r[0]) throw notFound("Item");
  return r[0];
}

async function addPhotos(tx: PoolClient, itemId: string, urls: z.infer<typeof PhotoUrlSchema>[] | undefined) {
  if (!urls) return;
  await tx.query("UPDATE item_photos SET archived_at = now() WHERE item_id = $1 AND archived_at IS NULL", [itemId]);
  let n = 0;
  for (const u of urls) {
    const url = typeof u === "string" ? u : (u as { url: string }).url;
    await tx.query("INSERT INTO item_photos (item_id, storage_provider, url, sort_order) VALUES ($1,'cloudinary',$2,$3)", [itemId, url, n++]);
  }
}

export const itemsGet = (request: NextRequest) => pgRoute(request, undefined, [...STAFF, "customer"], async (c) => {
  const sp = new URL(c.request.url).searchParams; const scope = ownerScope(c.actor);
  const { limit, pg } = page(sp, 500);
  const w: string[] = []; const v: unknown[] = []; const add = (sql: string, val: unknown) => { v.push(val); w.push(sql.replace("?", `$${v.length}`)); };
  if (scope) add("i.customer_id = ?", scope); else if (sp.get("customerId")) { if (!isUuid(sp.get("customerId"))) return ok([], { total: 0, totalPages: 1, page: pg }); add("i.customer_id = ?", sp.get("customerId")); }
  if (sp.get("status")) add("i.status = ?", sp.get("status"));
  if (sp.get("containerId")) { if (!isUuid(sp.get("containerId"))) return ok([], { total: 0, totalPages: 1, page: pg }); add("i.container_id = ?", sp.get("containerId")); }
  if (sp.get("orderId")) { if (!isUuid(sp.get("orderId"))) return ok([], { total: 0, totalPages: 1, page: pg }); add("i.invoice_id = ?", sp.get("orderId")); }
  if (sp.has("isMissing")) add("i.is_missing = ?", sp.get("isMissing") === "true");
  const s = (sp.get("search") ?? "").trim().toLowerCase().replace(/[%_\\]/g, "");
  if (s) add("(lower(i.item_ref) LIKE '%'||?||'%' OR lower(i.description) LIKE '%'||?||'%' OR lower(COALESCE(i.tracking_number,'')) LIKE '%'||?||'%' OR lower(c.name) LIKE '%'||?||'%' OR lower(c.shipping_mark) LIKE '%'||?||'%')", s);
  // the single '?' replacement above numbers only the first marker: expand the remaining search markers to the same parameter
  const where = (w.length ? w.join(" AND ") : "true").replace(/\?/g, `$${v.length}`);
  const total = await countItems(c.tx, where, v);                                   // paged in SQL: a page never loads the whole table into the Worker
  const data = await selectItemsPage(c.tx, where, v, limit, (pg - 1) * limit);
  return ok(data, { total, totalPages: Math.max(1, Math.ceil(total / limit)), page: pg });
});

export const itemsPost = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  const d = parseInput(CreateItem, await readJson(c.request));
  if (!isUuid(d.customerId)) throw bad("Customer ID is invalid");
  const cust = (await c.tx.query("SELECT id FROM customers WHERE id = $1 AND status = 'active' AND archived_at IS NULL", [d.customerId])).rows[0];
  if (!cust) throw bad("The customer does not exist or is inactive");
  const ref = await allocateReference(c.tx, "item");
  const email = await actorEmail(c.tx, c);
  const date = /^\d{4}-\d{2}-\d{2}/.test(d.dateReceived) ? d.dateReceived.slice(0, 10) : null;
  if (!date) throw bad("dateReceived must be a date (YYYY-MM-DD)");
  const specialId = (d.isSpecialItem || d.specialRateName || d.specialRateId) ? await resolveSpecialRate(c.tx, d.customerId, d.specialRateName, d.specialRateId) : null;
  if (d.isSpecialItem && !specialId) throw bad("Choose the special rate for a special item");
  const row = (await c.tx.query(
    `INSERT INTO items (item_ref, customer_id, received_date, description, tracking_number, freight_type, weight_kg, length, width, height, dimension_unit, quantity, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ref, d.customerId, date, d.description, d.trackingNumber ?? null, d.shippingType ?? null, d.weight ?? null, d.length ?? null, d.width ?? null, d.height ?? null, d.dimensionUnit, d.quantity ?? 1, d.notes ?? null, email ?? null])).rows[0];
  await addPhotos(c.tx, row.id, d.photoUrls);
  await repriceItem(c.tx, row.id, specialId, !!specialId);
  await recordStatusEvent(c.tx, { entityType: "item", entityId: row.id, from: null, to: "Arrived at Transit Warehouse", reason: "received" });
  await recordAudit(c.tx, { action: "item.create", entityType: "item", entityId: row.id, after: { itemRef: ref } });
  const item = await loadItem(c.tx, c, row.id);
  return ok(item, { message: `Item ${ref} received and assigned to customer` }, 201);
});

export const itemGet = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF, "customer"], async (c) => ok(await loadItem(c.tx, c, c.params.id)));

export const itemPatch = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF], async (c) => {
  const d = parseInput(UpdateItem, await readJson(c.request));
  const cur = await loadItem(c.tx, c, c.params.id);
  if (d.orderId !== undefined) throw bad("Invoice linkage is controlled by the server and cannot be set here");
  if (d.customerId !== undefined && c.actor.role !== "super_admin") throw new DomainError("NOT_AUTHORIZED", "Only a super admin can change which customer owns an item");
  const measures = ["weight", "length", "width", "height", "shippingType", "dimensionUnit", "quantity", "customerId"].some((k) => (d as Record<string, unknown>)[k] !== undefined);
  if (measures && cur.orderId) throw new DomainError("IMMUTABLE_RECORD", "This item is already on an invoice; its measurements and owner can no longer be changed");
  const touchesPrice = ["estPrice", "estShippingPrice", "pkgEstShipping", "pkgShippingRate"].some((k) => (d as Record<string, unknown>)[k] !== undefined);
  if (touchesPrice && cur.orderId) throw new DomainError("IMMUTABLE_RECORD", "This item is already on an invoice; its prices can no longer be changed");
  const cols: Record<string, [string, unknown]> = {
    weight: ["weight_kg", d.weight], length: ["length", d.length], width: ["width", d.width], height: ["height", d.height], description: ["description", d.description],
    trackingNumber: ["tracking_number", d.trackingNumber], notes: ["notes", d.notes], isMissing: ["is_missing", d.isMissing], shippingType: ["freight_type", d.shippingType],
    dimensionUnit: ["dimension_unit", d.dimensionUnit], quantity: ["quantity", d.quantity], dateReceived: ["received_date", d.dateReceived?.slice(0, 10)],
  };
  const sets: string[] = []; const vals: unknown[] = [c.params.id];
  for (const [, [col, val]] of Object.entries(cols)) if (val !== undefined) { vals.push(val); sets.push(`${col} = $${vals.length}`); }
  if (d.customerId !== undefined) {
    if (!isUuid(d.customerId) || cur.orderId || cur.cartonNumber) throw bad("The owner can be changed only for an item that is not on an invoice or in a carton");
    vals.push(d.customerId); sets.push(`customer_id = $${vals.length}`);
  }
  if (d.containerId !== undefined) {
    if (d.containerId !== "" && !isUuid(d.containerId)) throw bad("Container not found");
    vals.push(d.containerId === "" ? null : d.containerId); sets.push(`container_id = $${vals.length}`);
  }
  if (sets.length) await c.tx.query(`UPDATE items SET ${sets.join(", ")} WHERE id = $1 AND archived_at IS NULL`, vals);
  if (d.photoUrls) await addPhotos(c.tx, c.params.id, d.photoUrls);
  const measure = ["weight", "length", "width", "height", "shippingType", "dimensionUnit", "quantity", "customerId"].some((k) => (d as Record<string, unknown>)[k] !== undefined);
  if (measure && !cur.orderId) {
    const sr = (await c.tx.query("SELECT special_rate_id FROM items WHERE id = $1", [c.params.id])).rows[0]?.special_rate_id ?? null;
    await repriceItem(c.tx, c.params.id, d.customerId ? null : sr, !!sr && !d.customerId);
  }
  if (d.status && d.status !== cur.status) await moveItemStatus(c, c.params.id, d.status, undefined);
  await recordAudit(c.tx, { action: "item.update", entityType: "item", entityId: c.params.id, after: { fields: Object.keys(d) } });
  return ok(await loadItem(c.tx, c, c.params.id), { message: "Item updated successfully" });
});

export const itemDelete = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  const cur = await loadItem(c.tx, c, c.params.id);
  if (cur.orderId) throw new DomainError("IMMUTABLE_RECORD", "This item is on an invoice and cannot be deleted; cancel the invoice first");
  if (cur.cartonNumber) throw new DomainError("INVALID_STATE", "Remove the item from its carton first");
  await c.tx.query("UPDATE items SET archived_at = now(), container_id = NULL WHERE id = $1", [c.params.id]);     // history is kept
  await recordAudit(c.tx, { action: "item.archive", entityType: "item", entityId: c.params.id });
  return { body: { success: true, message: "Item deleted" } };
});

/** One place for item status changes: forward-only for staff, container rule, missing flag, history event with the verified actor. */
async function moveItemStatus(c: RouteCtx, id: string, status: string, notes: string | undefined) {
  if (!STEPS.includes(status as (typeof STEPS)[number])) throw bad("Invalid status");
  const cur = (await c.tx.query("SELECT status, container_id, item_ref, customer_id, description, tracking_number FROM items WHERE id = $1 AND archived_at IS NULL FOR UPDATE", [id])).rows[0];
  if (!cur) throw notFound("Item");
  if (c.actor.role === "warehouse_staff" && STEPS.indexOf(status as (typeof STEPS)[number]) < STEPS.indexOf(cur.status)) throw bad("Status can only move forward in the pipeline");
  if (status === "Shipped to Ghana" && !cur.container_id) throw bad("Item must be assigned to a container before marking as 'Shipped to Ghana'");
  await c.tx.query(`UPDATE items SET status = $2, is_missing = CASE WHEN $3 THEN false ELSE is_missing END WHERE id = $1`, [id, status, PROGRESSING.has(status)]);
  await recordStatusEvent(c.tx, { entityType: "item", entityId: id, from: cur.status, to: status, reason: notes });
  return cur;
}

export const itemStatusPatch = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF], async (c) => {
  const d = parseInput(z.object({ status: z.enum(STEPS), notes: z.string().optional(), sendWhatsApp: z.boolean().optional().default(false) }), await readJson(c.request));
  if (!isUuid(c.params.id)) throw notFound("Item");
  const cur = await moveItemStatus(c, c.params.id, d.status, d.notes);
  const item = await loadItem(c.tx, c, c.params.id);
  c.after(async () => {   // after COMMIT: customer e-mail (best effort, as before); WhatsApp stays disabled until the outbox worker is enabled
    const cust = (await (await import("@/lib/db/client")).getPool().query("SELECT email, name FROM customers WHERE id = $1", [cur.customer_id])).rows[0];
    if (cust?.email) await sendItemStatusEmail({ to: cust.email, customerName: cust.name, itemRef: cur.item_ref, description: cur.description ?? "", status: d.status, trackingNumber: cur.tracking_number ?? undefined });
  });
  return ok(item, { message: `Item status updated to: ${d.status}` });
});

export const itemHistoryGet = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF, "customer"], async (c) => {
  const item = await loadItem(c.tx, c, c.params.id);       // "not yours" and "does not exist" are the same 404
  const { rows } = await c.tx.query(
    `SELECT e.id, e.old_status, e.new_status, e.reason, e.occurred_at, u.email, u.role FROM status_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.entity_type = 'item' AND e.entity_id = $1 ORDER BY e.id`, [item.id]);
  const hide = c.actor.role === "customer";                // customers see the history, not staff e-mail addresses
  return ok(rows.map((r) => ({ id: String(r.id), recordType: "Item", recordId: item.id, recordRef: item.itemRef, previousStatus: r.old_status ?? "", newStatus: r.new_status,
    changedBy: hide ? "Movezz staff" : (r.email ?? "system"), changedByRole: r.role ?? "warehouse_staff", changedAt: r.occurred_at.toISOString(), notes: r.reason ?? undefined })));
});

// ================================================================ sorting
export const sortingGet = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  const sp = new URL(c.request.url).searchParams; const s = (sp.get("search") ?? "").trim().toLowerCase().replace(/[%_\\]/g, "");
  const f = (cond: string) => selectItems(c.tx, `${cond} AND ($1 = '' OR lower(i.item_ref) LIKE '%'||$1||'%' OR lower(i.description) LIKE '%'||$1||'%' OR lower(c.name) LIKE '%'||$1||'%' OR lower(c.shipping_mark) LIKE '%'||$1||'%')`, [s]);
  const sorting = await f("i.status = 'Sorting'");
  const wantMissing = sp.has("missing"); const showMissing = sp.get("missing") === "true";
  const missing = wantMissing ? await f("i.is_missing") : [];
  return ok({ sorting, missing: showMissing ? missing : undefined, sortingCount: sorting.length, missingCount: missing.length });
});
export const sortingPost = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  const d = parseInput(z.object({ itemId: z.string().min(1), action: z.enum(["found", "missing"]), notes: z.string().optional() }), await readJson(c.request));
  if (!isUuid(d.itemId)) throw notFound("Item");
  if (d.action === "missing") {
    const r = await c.tx.query("UPDATE items SET is_missing = true WHERE id = $1 AND archived_at IS NULL RETURNING id", [d.itemId]);
    if (!r.rows[0]) throw notFound("Item");
    await recordAudit(c.tx, { action: "item.missing", entityType: "item", entityId: d.itemId });
    const item = await loadItem(c.tx, c, d.itemId);
    return ok(item, { message: `Item ${item.itemRef} flagged as missing` });
  }
  await c.tx.query("UPDATE items SET is_missing = false WHERE id = $1 AND archived_at IS NULL", [d.itemId]);
  await moveItemStatus(c, d.itemId, "Ready for Pickup", "Item found during sorting");
  const item = await loadItem(c.tx, c, d.itemId);
  return ok(item, { message: `Item ${item.itemRef} marked as found → Ready for Pickup` });
});

// ================================================================ cartons
const CartonDims = z.object({ length: z.number().positive().max(10000), width: z.number().positive().max(10000), height: z.number().positive().max(10000), weight: z.number().positive().max(10000).optional(), dimensionUnit: z.enum(["cm", "inches"]).default("cm") });
const CreateCarton = CartonDims.extend({ customerId: z.string().min(1), itemIds: z.array(z.string().min(1)).min(1, "Select at least one item") });
const UpdateCarton = z.object({
  length: z.number().positive().max(10000).optional(), width: z.number().positive().max(10000).optional(), height: z.number().positive().max(10000).optional(), weight: z.number().positive().max(10000).optional(),
  dimensionUnit: z.enum(["cm", "inches"]).optional(), addItemIds: z.array(z.string().min(1)).optional(), removeItemIds: z.array(z.string().min(1)).optional(),
});

/** Carton price from the database tier rate: sea = CBM x rate, air = kg x rate, rounded once to 2 decimals. */
async function priceCarton(tx: PoolClient, customerId: string, freight: "sea" | "air", dims: { length: number; width: number; height: number; weight?: number | null; unit: string }) {
  const cbm = (dims.length * dims.width * dims.height * (dims.unit === "inches" ? 16.387064 : 1)) / 1_000_000;
  if (freight === "air" && !(dims.weight && dims.weight > 0)) throw bad("Air freight cartons need a weight");
  const t = (await tx.query("SELECT package_tier FROM customers WHERE id = $1", [customerId])).rows[0]?.package_tier;
  const r = (await tx.query(
    `SELECT rate_usd FROM package_rates WHERE tier = $1 AND freight_type = $2 AND is_active AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())`, [t, freight])).rows[0];
  if (!r || Number(r.rate_usd) <= 0) throw new DomainError("PRICING_NOT_FOUND", `No active ${freight} rate for the ${t} tier`);
  const basis = freight === "sea" ? cbm : Number(dims.weight);
  const price = Math.round(basis * Number(r.rate_usd) * 100) / 100;
  if (!(price > 0)) throw new DomainError("PRICING_INVALID", "The computed carton price is not positive");
  return { cbm, tier: t as string, rate: Number(r.rate_usd), price };
}

async function checkMembers(tx: PoolClient, customerId: string, ids: string[], freight: string | null, skipCarton?: string) {
  if (ids.some((i) => !isUuid(i))) throw bad("One or more items do not exist");
  const rows = (await tx.query("SELECT id, item_ref, customer_id, freight_type, carton_id, invoice_id, billing_basis FROM items WHERE id = ANY($1::uuid[]) AND archived_at IS NULL ORDER BY id FOR UPDATE", [ids])).rows;
  if (rows.length !== ids.length) throw bad("One or more items do not exist");
  const refs = (a: typeof rows) => a.map((i) => i.item_ref).join(", ");
  const f = (fn: (i: (typeof rows)[number]) => boolean) => rows.filter(fn);
  let x;
  if ((x = f((i) => i.customer_id !== customerId)).length) throw bad(`All items in a carton must belong to the same customer: ${refs(x)}`);
  if ((x = f((i) => i.carton_id && i.carton_id !== skipCarton)).length) throw bad(`Already in a carton: ${refs(x)}`);
  if ((x = f((i) => i.invoice_id)).length) throw bad(`Already invoiced: ${refs(x)}`);
  if ((x = f((i) => i.billing_basis === "special")).length) throw bad(`Special-rate items can't be repacked into a carton: ${refs(x)}`);
  const fr = freight ?? rows[0].freight_type ?? "sea";
  if ((x = f((i) => (i.freight_type ?? "sea") !== fr)).length) throw bad(`All items in a carton must share the same freight type (${fr}): ${refs(x)} don't match`);
  return fr as "sea" | "air";
}

async function cartonResult(tx: PoolClient, cartonId: string) {
  const ca = (await tx.query("SELECT * FROM cartons WHERE id = $1", [cartonId])).rows[0];
  const items = await selectItems(tx, "i.carton_id = $1", [cartonId]);
  return { cartonNumber: ca.carton_ref, items, cbm: ca.cbm === null ? 0 : Number(ca.cbm), totalPrice: Number(ca.price_usd ?? 0) };
}

export const cartonsGet = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  await authorize(c.tx, "carton.read.any");
  const cid = new URL(c.request.url).searchParams.get("customerId");
  if (cid && !isUuid(cid)) return ok([]);
  const { rows } = await c.tx.query("SELECT id FROM cartons WHERE status = 'open' AND ($1::uuid IS NULL OR customer_id = $1) ORDER BY created_at DESC, id", [cid]);
  const out = []; for (const r of rows) { const x = await cartonResult(c.tx, r.id); out.push({ cartonNumber: x.cartonNumber, items: x.items, cbm: x.cbm }); }
  return ok(out);
});

export const cartonsPost = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  const d = parseInput(CreateCarton, await readJson(c.request));
  if (!isUuid(d.customerId)) throw bad("Customer ID is invalid");
  const ids = Array.from(new Set(d.itemIds));
  const freight = await checkMembers(c.tx, d.customerId, ids, null);
  const p = await priceCarton(c.tx, d.customerId, freight, { ...d, unit: d.dimensionUnit });
  const ref = await allocateReference(c.tx, "carton");
  const email = await actorEmail(c.tx, c);
  const ca = (await c.tx.query(
    `INSERT INTO cartons (carton_ref, customer_id, freight_type, length, width, height, dimension_unit, weight_kg, package_tier, rate_usd, price_usd, pricing_basis, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'tier',$12) RETURNING id`,
    [ref, d.customerId, freight, d.length, d.width, d.height, d.dimensionUnit, d.weight ?? null, p.tier, p.rate, p.price, email ?? null])).rows[0];
  await c.tx.query("UPDATE items SET carton_id = $1 WHERE id = ANY($2::uuid[])", [ca.id, ids]);
  await recordAudit(c.tx, { action: "carton.create", entityType: "carton", entityId: ca.id, after: { cartonRef: ref, items: ids.length } });
  const res = await cartonResult(c.tx, ca.id);
  return ok(res, { message: `Carton ${ref} created from ${res.items.length} item(s)` }, 201);
});

async function lockCarton(tx: PoolClient, ref: string) {
  const ca = (await tx.query("SELECT * FROM cartons WHERE carton_ref = $1 FOR UPDATE", [ref])).rows[0];
  if (!ca || ca.status === "dissolved") throw bad("Carton not found");
  if (ca.status === "invoiced") throw new DomainError("IMMUTABLE_RECORD", "This carton is already invoiced and can no longer be changed");
  return ca;
}
async function dissolve(tx: PoolClient, ca: { id: string }) {
  await tx.query("UPDATE items SET carton_id = NULL WHERE carton_id = $1", [ca.id]);
  await tx.query("UPDATE cartons SET status = 'dissolved', dissolved_at = now() WHERE id = $1", [ca.id]);
  await recordStatusEvent(tx, { entityType: "carton", entityId: ca.id, from: "open", to: "dissolved" });
}

export const cartonPatch = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF], async (c) => {
  const d = parseInput(UpdateCarton, await readJson(c.request));
  const ca = await lockCarton(c.tx, c.params.cartonNumber);
  const members = (await c.tx.query("SELECT id FROM items WHERE carton_id = $1 FOR UPDATE", [ca.id])).rows.map((r) => r.id as string);
  const remove = new Set(d.removeItemIds ?? []);
  const keep = members.filter((m) => !remove.has(m));
  const add = Array.from(new Set(d.addItemIds ?? [])).filter((i) => !keep.includes(i));
  if (add.length) await checkMembers(c.tx, ca.customer_id, add, ca.freight_type);
  const all = [...keep, ...add];
  if (all.length === 0) { await dissolve(c.tx, ca); await recordAudit(c.tx, { action: "carton.dissolve", entityType: "carton", entityId: ca.id }); return ok({ cartonNumber: ca.carton_ref, items: [], cbm: 0, totalPrice: 0 }, { message: `Carton ${ca.carton_ref} updated` }); }
  const dims = { length: d.length ?? Number(ca.length), width: d.width ?? Number(ca.width), height: d.height ?? Number(ca.height), weight: d.weight ?? (ca.weight_kg === null ? null : Number(ca.weight_kg)), unit: d.dimensionUnit ?? ca.dimension_unit };
  const pr = await priceCarton(c.tx, ca.customer_id, ca.freight_type, dims);
  await c.tx.query("UPDATE items SET carton_id = NULL WHERE carton_id = $1 AND NOT (id = ANY($2::uuid[]))", [ca.id, all]);
  await c.tx.query("UPDATE items SET carton_id = $1 WHERE id = ANY($2::uuid[])", [ca.id, all]);
  await c.tx.query("UPDATE cartons SET length=$2,width=$3,height=$4,weight_kg=$5,dimension_unit=$6,package_tier=$7,rate_usd=$8,price_usd=$9 WHERE id=$1",
    [ca.id, dims.length, dims.width, dims.height, dims.weight, dims.unit, pr.tier, pr.rate, pr.price]);
  await recordAudit(c.tx, { action: "carton.update", entityType: "carton", entityId: ca.id, after: { items: all.length } });
  return ok(await cartonResult(c.tx, ca.id), { message: `Carton ${ca.carton_ref} updated` });
});

export const cartonDelete = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF], async (c) => {
  const ca = await lockCarton(c.tx, c.params.cartonNumber);
  await dissolve(c.tx, ca);
  await recordAudit(c.tx, { action: "carton.dissolve", entityType: "carton", entityId: ca.id });
  return { body: { success: true, message: "Carton dissolved" } };
});

// ================================================================ containers
const CONTAINER_SELECT = `SELECT co.*, COALESCE((SELECT array_agg(i.id ORDER BY i.created_at) FROM items i WHERE i.container_id = co.id AND i.archived_at IS NULL), '{}') AS item_ids,
    (SELECT count(*) FROM items i WHERE i.container_id = co.id AND i.archived_at IS NULL) AS item_count,
    COALESCE((SELECT sum(i.cbm_total) FROM items i WHERE i.container_id = co.id AND i.archived_at IS NULL), 0) AS total_cbm FROM containers co`;
const getContainer = async (tx: PoolClient, id: string) => {
  if (!isUuid(id)) throw notFound("Container");
  const r = (await tx.query(`${CONTAINER_SELECT} WHERE co.id = $1 AND co.archived_at IS NULL`, [id])).rows[0];
  if (!r) throw notFound("Container");
  return r;
};
const CreateContainer = z.object({ name: z.string().max(200).optional(), description: z.string().max(1000).optional(), eta: z.string().max(50).optional(),
  trackingNumber: z.string().min(1, "Container number is required").max(100), notes: z.string().max(2000).optional() });
const UpdateContainer = z.object({ name: z.string().max(200).optional(), description: z.string().max(1000).optional(), eta: z.string().max(50).optional(), arrivalDate: z.string().max(50).optional(),
  trackingNumber: z.string().max(100).optional(), notes: z.string().max(2000).optional(), createdAt: z.string().max(50).optional() });
const dateOrNull = (v: string | undefined) => (v === undefined ? undefined : v === "" ? null : /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : (() => { throw bad("Dates must be YYYY-MM-DD"); })());

export const containersGet = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  const sp = new URL(c.request.url).searchParams; const s = (sp.get("search") ?? "").trim().toLowerCase().replace(/[%_\\]/g, "");
  const { pg } = page(sp, 50); const limit = 50;
  const where = `co.archived_at IS NULL AND ($1::text IS NULL OR co.status = $1) AND ($2 = '' OR lower(co.container_ref) LIKE '%'||$2||'%' OR lower(COALESCE(co.container_number,'')) LIKE '%'||$2||'%' OR lower(COALESCE(co.shipping_line,'')) LIKE '%'||$2||'%')`;
  const vals = [sp.get("status"), s];
  const total = Number((await c.tx.query(`SELECT count(*) AS n FROM containers co WHERE ${where}`, vals)).rows[0].n);
  const { rows } = await c.tx.query(`${CONTAINER_SELECT} WHERE ${where} ORDER BY co.created_at DESC, co.id LIMIT $3 OFFSET $4`, [...vals, limit, (pg - 1) * limit]);
  return ok(rows.map(containerOut), { total, totalPages: Math.max(1, Math.ceil(total / limit)), page: pg });
});

export const containersPost = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  const d = parseInput(CreateContainer, await readJson(c.request));
  const ref = await allocateContainerReference(c.tx);       // PMX-CON-<year>-<NNN>: the sequence is global, from the transactional counter
  const row = (await c.tx.query(
    `INSERT INTO containers (container_ref, container_number, shipping_line, description, eta, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ref, d.trackingNumber, d.name ?? null, d.description ?? null, dateOrNull(d.eta) ?? null, d.notes ?? null, await actorEmail(c.tx, c) ?? null])).rows[0];
  await recordAudit(c.tx, { action: "container.create", entityType: "container", entityId: row.id, after: { containerRef: ref } });
  return ok(containerOut(await getContainer(c.tx, row.id)), { message: `Container ${ref} created` }, 201);
});

export const containerGet = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF], async (c) => {
  const co = await getContainer(c.tx, c.params.id);
  const items = await selectItems(c.tx, "i.container_id = $1", [c.params.id], "ORDER BY i.created_at, i.id");
  return ok({ ...containerOut(co), items });
});

export const containerPatch = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  const d = parseInput(UpdateContainer, await readJson(c.request));
  await getContainer(c.tx, c.params.id);
  const m: Record<string, unknown> = { shipping_line: d.name, description: d.description, eta: dateOrNull(d.eta), arrival_date: dateOrNull(d.arrivalDate), container_number: d.trackingNumber, notes: d.notes };
  const sets: string[] = []; const vals: unknown[] = [c.params.id];
  for (const [col, v] of Object.entries(m)) if (v !== undefined) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  if (sets.length) await c.tx.query(`UPDATE containers SET ${sets.join(", ")} WHERE id = $1`, vals);
  await recordAudit(c.tx, { action: "container.update", entityType: "container", entityId: c.params.id, after: { fields: Object.keys(d) } });
  return ok(containerOut(await getContainer(c.tx, c.params.id)), { message: "Container updated" });
});

export const containerDelete = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  const co = await getContainer(c.tx, c.params.id);
  if (Number(co.item_count) > 0) throw new DomainError("INVALID_STATE", "Remove the items from the container first");
  await c.tx.query("UPDATE containers SET archived_at = now() WHERE id = $1", [c.params.id]);
  await recordAudit(c.tx, { action: "container.archive", entityType: "container", entityId: c.params.id });
  return { body: { success: true, message: "Container deleted" } };
});

const ItemRef = z.object({ itemId: z.string().min(1, "Item ID is required") });
export const containerItemsPost = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF], async (c) => {
  const { itemId } = parseInput(ItemRef, await readJson(c.request));
  await getContainer(c.tx, c.params.id);
  if (!isUuid(itemId)) throw notFound("Item");
  const it = (await c.tx.query("SELECT container_id FROM items WHERE id = $1 AND archived_at IS NULL FOR UPDATE", [itemId])).rows[0];
  if (!it) throw notFound("Item");
  if (it.container_id && it.container_id !== c.params.id) throw bad("This item is already loaded into another container. Remove it from that container first.");
  await c.tx.query("UPDATE items SET container_id = $2 WHERE id = $1", [itemId, c.params.id]);
  await recordAudit(c.tx, { action: "container.add_item", entityType: "container", entityId: c.params.id, after: { itemId } });
  return ok(containerOut(await getContainer(c.tx, c.params.id)), { message: "Item added to container" });
});
export const containerItemsDelete = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF], async (c) => {
  const { itemId } = parseInput(ItemRef, await readJson(c.request));
  await getContainer(c.tx, c.params.id);
  if (!isUuid(itemId)) throw notFound("Item");
  await c.tx.query("UPDATE items SET container_id = NULL WHERE id = $1 AND container_id = $2", [itemId, c.params.id]);
  await recordAudit(c.tx, { action: "container.remove_item", entityType: "container", entityId: c.params.id, after: { itemId } });
  return ok(containerOut(await getContainer(c.tx, c.params.id)), { message: "Item removed from container" });
});

const CASCADE: Record<string, string> = { "Shipped to Ghana": "Shipped to Ghana", "Arrived in Ghana": "Awaiting Customs Clearance & Duty Process" };
/** Advance-only: items already at or beyond the target, and items flagged missing, are left exactly as they are. Every move is recorded. */
async function cascade(c: RouteCtx, co: { id: string; container_ref: string }, target: string): Promise<number> {
  const ti = STEPS.indexOf(target as (typeof STEPS)[number]);
  const rows = (await c.tx.query("SELECT id, status FROM items WHERE container_id = $1 AND archived_at IS NULL AND NOT is_missing FOR UPDATE", [co.id])).rows
    .filter((r) => { const i = STEPS.indexOf(r.status); return i !== -1 && i < ti; });
  for (const r of rows) {
    await c.tx.query("UPDATE items SET status = $2 WHERE id = $1", [r.id, target]);
    await recordStatusEvent(c.tx, { entityType: "item", entityId: r.id, from: r.status, to: target, reason: `Container ${co.container_ref} status changed` });
  }
  return rows.length;
}
export const containerStatusPatch = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  const d = parseInput(z.object({ status: z.enum(["Loading", "Shipped to Ghana", "Arrived in Ghana"]), notes: z.string().optional(), arrivalDate: z.string().optional() }), await readJson(c.request));
  const co = await getContainer(c.tx, c.params.id);
  const arr = dateOrNull(d.arrivalDate);
  await c.tx.query("UPDATE containers SET status = $2, arrival_date = COALESCE($3::date, arrival_date) WHERE id = $1", [c.params.id, d.status, arr ?? null]);
  await recordStatusEvent(c.tx, { entityType: "container", entityId: c.params.id, from: co.status, to: d.status, reason: d.notes });
  if (CASCADE[d.status]) await cascade(c, co, CASCADE[d.status]);
  const out = await getContainer(c.tx, c.params.id);
  return ok(containerOut(out), { message: d.status === "Arrived in Ghana" ? `Container ${out.container_ref} arrived in Ghana. All ${out.item_count} items updated automatically.` : `Container ${out.container_ref} status updated to: ${d.status}` });
});
export const containerSyncPost = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  const co = await getContainer(c.tx, c.params.id);
  const target = CASCADE[co.status];
  if (!target) return { body: { success: true, message: "No status cascade defined for this container status", updated: 0 } };
  const updated = await cascade(c, co, target);
  return { body: { success: true, message: `${updated} item${updated !== 1 ? "s" : ""} synced to "${target}"`, updated } };
});

void itemOut; void isAllowed;
