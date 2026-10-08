// Group C: rates, FX settings, warehouses, suppliers on PostgreSQL. Only a super_admin writes configuration (also enforced by database
// triggers). Rates are versioned, never overwritten: a change closes the current row and opens a new one, so past prices stay explainable.
import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { z } from "zod";
import { PackageRatesSchema } from "@/lib/schemas";
import { authorize } from "@/lib/db/authz";
import { recordAudit } from "@/lib/db/audit";
import { allocateReference } from "@/lib/db/references";
import { DomainError } from "@/lib/db/errors";
import { isUuid } from "@/lib/db/app-queries";
import { pgRoute, ok, parseInput, readJson, type RouteCtx } from "@/lib/pg-api";

type P = { params: Promise<Record<string, string>> };
const ALL = ["super_admin", "warehouse_staff", "customer"] as const;
const STAFF = ["super_admin", "warehouse_staff"] as const;
const bad = (m: string) => new DomainError("INVALID_INPUT", m);
const notFound = (w: string) => new DomainError("NOT_FOUND", `${w} not found`);
const actorEmail = async (tx: PoolClient, c: RouteCtx) => (await tx.query("SELECT email FROM users WHERE id = $1", [c.actor.userId])).rows[0]?.email as string | undefined;

// ---------------------------------------------------------------- package rates
async function currentPackageRates(tx: PoolClient) {
  const out: Record<string, { sea: number; air: number }> = { basic: { sea: 0, air: 0 }, business: { sea: 0, air: 0 }, enterprise: { sea: 0, air: 0 }, special: { sea: 0, air: 0 } };
  const { rows } = await tx.query("SELECT tier, freight_type, rate_usd FROM package_rates WHERE is_active AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())");
  for (const r of rows) out[r.tier][r.freight_type as "sea" | "air"] = Number(r.rate_usd);
  return out;
}
export const packageRatesGet = (request: NextRequest) => pgRoute(request, undefined, [...ALL], async (c) => ok(await currentPackageRates(c.tx)));
export const packageRatesPut = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  await authorize(c.tx, "rates.admin");
  const parsed = PackageRatesSchema.safeParse(await readJson(c.request).catch(() => null));
  if (!parsed.success) throw bad(parsed.error.errors.map((e) => `${e.path.join(".") || "body"}: ${e.message}`).join(", "));
  const cur = await currentPackageRates(c.tx);
  for (const [tier, v] of Object.entries(parsed.data)) for (const f of ["sea", "air"] as const) {
    if (cur[tier][f] === v[f]) continue;
    await c.tx.query("UPDATE package_rates SET effective_to = now() WHERE tier = $1 AND freight_type = $2 AND is_active AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())", [tier, f]);
    if (v[f] > 0) await c.tx.query("INSERT INTO package_rates (tier, freight_type, rate_usd, effective_from) VALUES ($1,$2,$3,now())", [tier, f, v[f]]);   // 0 = no rate: pricing then refuses, it never guesses
    await recordAudit(c.tx, { action: "rates.package", entityType: "package_rate", entityId: `${tier}:${f}`, before: { rate: cur[tier][f] }, after: { rate: v[f] } });
  }
  return ok(await currentPackageRates(c.tx));
});

// ---------------------------------------------------------------- special rates
const specialOut = (r: Record<string, unknown>) => ({ id: r.id, name: r.name, sea: r.sea_rate_usd === null ? 0 : Number(r.sea_rate_usd), air: r.air_rate_usd === null ? 0 : Number(r.air_rate_usd), customerId: r.customer_id ?? undefined });
const SpecialIn = z.object({ name: z.string().trim().min(1, "Rate name is required").max(100), sea: z.coerce.number().finite().min(0).max(100_000).default(0), air: z.coerce.number().finite().min(0).max(100_000).default(0), customerId: z.string().uuid().optional() }).strict();
export const specialRatesGet = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  const { rows } = await c.tx.query("SELECT * FROM special_rates WHERE is_active AND (effective_to IS NULL OR effective_to > now()) ORDER BY name, id");
  return ok(rows.map(specialOut));
});
export const specialRatesPost = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  await authorize(c.tx, "rates.admin");
  const d = parseInput(SpecialIn, await readJson(c.request).catch(() => null));
  if (!d.sea && !d.air) throw bad("At least one of the sea or air rates is required");
  const r = (await c.tx.query("INSERT INTO special_rates (name, customer_id, sea_rate_usd, air_rate_usd) VALUES ($1,$2,$3,$4) RETURNING *", [d.name, (d as { customerId?: string }).customerId ?? null, d.sea || null, d.air || null])).rows[0];
  await recordAudit(c.tx, { action: "rates.special.create", entityType: "special_rate", entityId: r.id, after: { name: d.name } });
  return ok(specialOut(r), {}, 201);
});
export const specialRatePatch = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  await authorize(c.tx, "rates.admin");
  const d = parseInput(SpecialIn, await readJson(c.request).catch(() => null));
  if (!isUuid(c.params.id)) throw notFound("Special rate");
  if (!d.sea && !d.air) throw bad("At least one of the sea or air rates is required");
  const r = (await c.tx.query("UPDATE special_rates SET name = $2, sea_rate_usd = $3, air_rate_usd = $4 WHERE id = $1 AND is_active RETURNING *", [c.params.id, d.name, d.sea || null, d.air || null])).rows[0];
  if (!r) throw notFound("Special rate");
  await recordAudit(c.tx, { action: "rates.special.update", entityType: "special_rate", entityId: r.id, after: { name: d.name } });
  return ok(specialOut(r));
});
export const specialRateDelete = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  await authorize(c.tx, "rates.admin");
  if (!isUuid(c.params.id)) throw notFound("Special rate");
  // items keep an immutable snapshot of the rate they were priced with, so a card is retired (inactive, window closed), never deleted
  const r = await c.tx.query("UPDATE special_rates SET is_active = false, effective_to = GREATEST(now(), effective_from + interval '1 millisecond') WHERE id = $1 AND is_active RETURNING id", [c.params.id]);
  if (!r.rows[0]) throw notFound("Special rate");
  await recordAudit(c.tx, { action: "rates.special.retire", entityType: "special_rate", entityId: c.params.id });
  return { body: { success: true } };
});

// ---------------------------------------------------------------- settings (the USD -> GHS rate)
export const settingsGet = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  const r = (await c.tx.query("SELECT rate FROM current_fx_rate('USD','GHS', now())")).rows[0];
  // shippingRatePerCbm was a legacy estimate field; prices come from package_rates, so it is not stored (0 = not configured)
  return ok(r && r.rate !== null ? { usdToGhs: Number(r.rate), shippingRatePerCbm: 0 } : null);
});
export const settingsPut = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  await authorize(c.tx, "rates.admin");
  const d = parseInput(z.object({ usdToGhs: z.number().min(0.1, "USD → GHS rate looks too low").max(1000, "USD → GHS rate looks too high"), shippingRatePerCbm: z.number().positive("Shipping rate must be positive") }), await readJson(c.request));
  const r = (await c.tx.query("INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at, created_by) VALUES ('USD','GHS',$1,'admin',now(),$2) RETURNING id", [d.usdToGhs, await actorEmail(c.tx, c) ?? null])).rows[0];
  await recordAudit(c.tx, { action: "rates.fx", entityType: "fx_rate", entityId: r.id, after: { usdToGhs: d.usdToGhs } });
  return { body: { success: true, message: "Settings saved" } };
});

// ---------------------------------------------------------------- warehouses
const whOut = (r: Record<string, unknown>) => ({ id: r.id, name: r.name, address: r.address ?? "", country: r.country ?? undefined, phone: r.phone ?? undefined, isActive: !!r.is_active, createdAt: (r.created_at as Date).toISOString() });
export const warehousesGet = (request: NextRequest) => pgRoute(request, undefined, [...ALL], async (c) => {
  const { rows } = await c.tx.query("SELECT * FROM warehouses WHERE ($1::boolean OR is_active) ORDER BY name, id", [c.actor.role !== "customer"]);
  return ok(rows.map(whOut));
});
export const warehousesPost = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  await authorize(c.tx, "warehouse.admin");
  const b = (await readJson(c.request)) as Record<string, unknown>;
  const s = (k: string) => (typeof b?.[k] === "string" ? (b[k] as string).trim() : "");
  if (!s("name") || !s("address")) throw bad("Name and address are required");
  const r = (await c.tx.query("INSERT INTO warehouses (name, address, country, phone) VALUES ($1,$2,$3,$4) RETURNING *", [s("name"), s("address"), s("country") || null, s("phone") || null])).rows[0];
  await recordAudit(c.tx, { action: "warehouse.create", entityType: "warehouse", entityId: r.id });
  return ok(whOut(r), {}, 201);
});
export const warehousePatch = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  await authorize(c.tx, "warehouse.admin");
  const b = parseInput(z.object({ name: z.string().trim().min(1).max(200).optional(), address: z.string().trim().max(500).optional(), country: z.string().trim().max(100).optional(), phone: z.string().trim().max(50).optional(), isActive: z.boolean().optional() }), await readJson(c.request));
  if (!isUuid(c.params.id)) throw notFound("Warehouse");
  const m: Record<string, unknown> = { name: b.name, address: b.address, country: b.country, phone: b.phone, is_active: b.isActive };
  const sets: string[] = []; const vals: unknown[] = [c.params.id];
  for (const [col, v] of Object.entries(m)) if (v !== undefined) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  if (!sets.length) throw bad("Nothing to update");
  const r = (await c.tx.query(`UPDATE warehouses SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals)).rows[0];
  if (!r) throw notFound("Warehouse");
  await recordAudit(c.tx, { action: "warehouse.update", entityType: "warehouse", entityId: r.id, after: { fields: Object.keys(b) } });
  return ok(whOut(r));
});
export const warehouseDelete = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  await authorize(c.tx, "warehouse.admin");
  if (!isUuid(c.params.id)) throw notFound("Warehouse");
  const r = await c.tx.query("UPDATE warehouses SET is_active = false WHERE id = $1 RETURNING id", [c.params.id]);   // containers and customers reference it: retire, never delete
  if (!r.rows[0]) throw notFound("Warehouse");
  await recordAudit(c.tx, { action: "warehouse.retire", entityType: "warehouse", entityId: c.params.id });
  return { body: { success: true } };
});

// ---------------------------------------------------------------- suppliers
const supOut = (r: Record<string, unknown>) => ({ id: r.id, supplierId: r.supplier_ref, name: r.name, category: r.category ?? undefined, platform: r.platform ?? undefined, platformLink: r.platform_link ?? undefined,
  contact: r.contact ?? undefined, contactMethod: r.contact_method ?? undefined, rating: r.rating === null ? undefined : Number(r.rating), notes: r.notes ?? undefined, createdAt: (r.created_at as Date).toISOString(), createdBy: r.created_by ?? undefined });
const SupplierIn = z.object({ name: z.string().min(1, "Name is required"), category: z.string().max(100).optional(), platform: z.string().max(100).optional(), platformLink: z.string().max(500).optional(),
  contact: z.string().max(200).optional(), contactMethod: z.string().max(100).optional(), rating: z.number().int().min(1).max(5).optional(), notes: z.string().max(2000).optional() });
const supCols = (d: z.infer<typeof SupplierIn> | Partial<z.infer<typeof SupplierIn>>) => ({ name: d.name, category: d.category, platform: d.platform, platform_link: d.platformLink, contact: d.contact, contact_method: d.contactMethod, rating: d.rating, notes: d.notes });
export const suppliersGet = (request: NextRequest) => pgRoute(request, undefined, [...STAFF], async (c) => {
  const sp = new URL(c.request.url).searchParams; const s = (sp.get("search") ?? "").trim().toLowerCase().replace(/[%_\\]/g, "");
  const pg = Math.max(1, parseInt(sp.get("page") ?? "1") || 1); const limit = 50;
  const where = "archived_at IS NULL AND ($1 = '' OR lower(name) LIKE '%'||$1||'%' OR lower(supplier_ref) LIKE '%'||$1||'%' OR lower(COALESCE(contact,'')) LIKE '%'||$1||'%')";
  const total = Number((await c.tx.query(`SELECT count(*) AS n FROM suppliers WHERE ${where}`, [s])).rows[0].n);
  const { rows } = await c.tx.query(`SELECT * FROM suppliers WHERE ${where} ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [s, limit, (pg - 1) * limit]);
  return ok(rows.map(supOut), { total, totalPages: Math.max(1, Math.ceil(total / limit)), page: pg });
});
export const suppliersPost = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  await authorize(c.tx, "supplier.admin");
  const d = parseInput(SupplierIn, await readJson(c.request));
  const ref = await allocateReference(c.tx, "supplier");
  const x = supCols(d);
  const r = (await c.tx.query(`INSERT INTO suppliers (supplier_ref, name, category, platform, platform_link, contact, contact_method, rating, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ref, x.name, x.category ?? null, x.platform ?? null, x.platform_link ?? null, x.contact ?? null, x.contact_method ?? null, x.rating ?? null, x.notes ?? null, await actorEmail(c.tx, c) ?? null])).rows[0];
  await recordAudit(c.tx, { action: "supplier.create", entityType: "supplier", entityId: r.id });
  return ok(supOut(r), {}, 201);
});
export const supplierGet = (request: NextRequest, p: P) => pgRoute(request, p.params, [...STAFF], async (c) => {
  const r = isUuid(c.params.id) ? (await c.tx.query("SELECT * FROM suppliers WHERE id = $1 AND archived_at IS NULL", [c.params.id])).rows[0] : null;
  if (!r) throw notFound("Supplier");
  return ok(supOut(r));
});
export const supplierPatch = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  await authorize(c.tx, "supplier.admin");
  const d = parseInput(SupplierIn.partial(), await readJson(c.request));
  if (!isUuid(c.params.id)) throw notFound("Supplier");
  const sets: string[] = []; const vals: unknown[] = [c.params.id];
  for (const [col, v] of Object.entries(supCols(d))) if (v !== undefined) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  if (!sets.length) throw bad("Nothing to update");
  const r = (await c.tx.query(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = $1 AND archived_at IS NULL RETURNING *`, vals)).rows[0];
  if (!r) throw notFound("Supplier");
  await recordAudit(c.tx, { action: "supplier.update", entityType: "supplier", entityId: r.id, after: { fields: Object.keys(d) } });
  return ok(supOut(r));
});
export const supplierDelete = (request: NextRequest, p: P) => pgRoute(request, p.params, ["super_admin"], async (c) => {
  await authorize(c.tx, "supplier.admin");
  if (!isUuid(c.params.id)) throw notFound("Supplier");
  const r = await c.tx.query("UPDATE suppliers SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id", [c.params.id]);
  if (!r.rows[0]) throw notFound("Supplier");
  await recordAudit(c.tx, { action: "supplier.archive", entityType: "supplier", entityId: c.params.id });
  return { body: { success: true } };
});
