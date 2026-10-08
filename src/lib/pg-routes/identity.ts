// Group A: sign-in, staff users and customers on PostgreSQL. Same URLs, envelopes and status codes as the Airtable routes.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { verifyIdToken, createFirebaseUser, deleteFirebaseUser, setCustomClaims, generatePasswordResetLink } from "@/lib/firebase-admin";
import { sendPasswordResetEmail, sendWelcomeEmail } from "@/lib/email";
import { generateUnusedInitialPassword } from "@/lib/initial-password";
import { checkRateLimit, rateLimitedResponse, getClientIp, checkBodySize } from "@/lib/rate-limit";
import { generateShippingMark, generateShippingAddress } from "@/lib/utils";
import { getPool } from "@/lib/db/client";
import { authorize } from "@/lib/db/authz";
import { recordAudit } from "@/lib/db/audit";
import { DomainError } from "@/lib/db/errors";
import { appUserOut, customerOut, APP_USER_SQL } from "@/lib/db/mappers";
import { isUuid, ownerScope, selectItems, selectOrders } from "@/lib/db/app-queries";
import { updateCustomerSelf, updateCustomerAdmin } from "@/lib/db/ownership";
import { isAllowed } from "@/lib/db/authz";
import { pgRoute, ok, parseInput, readJson, apiError } from "@/lib/pg-api";

type Params = Promise<{ id: string }>;
const COOKIE_AGE = 3600;

// ---------------------------------------------------------------- auth
async function loadUserByUid(uid: string) {
  const { rows } = await getPool().query(`${APP_USER_SQL} WHERE u.auth_uid = $1`, [uid]);
  return rows[0] ?? null;
}
const denied = (code: "ACCOUNT_INACTIVE" | "CUSTOMER_NOT_LINKED") => Response.json(
  code === "ACCOUNT_INACTIVE" ? { success: false, error: "This account has been deactivated. Contact support.", code } : { success: false, error: "Your login is not linked to a customer profile. Contact support.", code },
  { status: 403 });

export async function verifyPost(request: NextRequest): Promise<Response> {
  const sizeErr = checkBodySize(request, 16_384); if (sizeErr) return sizeErr;
  if (!checkRateLimit(`verify:${getClientIp(request)}`, 20, 60_000)) return rateLimitedResponse(60);
  try {
    const { idToken } = (await request.json().catch(() => ({}))) as { idToken?: string };
    if (!idToken) return Response.json({ success: false, error: "idToken is required" }, { status: 400 });
    let decoded: { uid: string; email?: string };
    try { decoded = await verifyIdToken(idToken); } catch { return Response.json({ success: false, error: "Invalid or expired token" }, { status: 401 }); }
    const row = await loadUserByUid(decoded.uid);
    // No auto-registration, no e-mail claiming, no "first user becomes admin": an unknown identity is simply not registered.
    if (!row) return Response.json({ success: false, error: "You are not registered in this system. Ask an administrator to add you.", code: "NOT_REGISTERED" }, { status: 404 });
    if (!row.is_active) return denied("ACCOUNT_INACTIVE");
    if (row.role === "customer") {
      if (!row.customer_id) return denied("CUSTOMER_NOT_LINKED");
      if (row.customer_status !== "active") return denied("ACCOUNT_INACTIVE");
    }
    await getPool().query("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]).catch(() => {});
    return Response.json({ success: true, data: { user: appUserOut(row), uid: decoded.uid, email: decoded.email } },
      { status: 200, headers: { "Set-Cookie": `auth-token=${idToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_AGE}` } });
  } catch (err) {
    return apiError(err);
  }
}

export function verifyDelete(): Response {
  return Response.json({ success: true, message: "Signed out" }, { status: 200, headers: { "Set-Cookie": "auth-token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" } });
}

export async function verifyCookie(request: NextRequest): Promise<Response> {
  try {
    const token = request.cookies.get("auth-token")?.value;
    if (!token) return Response.json({ success: false }, { status: 401 });
    const decoded = await verifyIdToken(token);
    const row = await loadUserByUid(decoded.uid);
    if (!row || !row.is_active || (row.role === "customer" && (!row.customer_id || row.customer_status !== "active"))) return Response.json({ success: false }, { status: 401 });
    return Response.json({ success: true, data: appUserOut(row) });
  } catch { return Response.json({ success: false }, { status: 401 }); }
}

// ---------------------------------------------------------------- staff users
const CreateUser = z.object({ email: z.string().email("Invalid email address"), role: z.enum(["warehouse_staff"], { errorMap: () => ({ message: "Role must be warehouse_staff (administrators are created only by the bootstrap procedure)" }) }) });

export const usersGet = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async ({ tx }) => {
  await authorize(tx, "user.admin");
  const { rows } = await tx.query(`${APP_USER_SQL} WHERE u.is_active ORDER BY u.created_at, u.id`);
  return ok(rows.map(appUserOut));
});

export async function usersPost(request: NextRequest): Promise<Response> {
  let firebaseUid: string | null = null;
  const res = await pgRoute(request, undefined, ["super_admin"], async ({ tx }) => {
    await authorize(tx, "user.admin");
    const { email, role } = parseInput(CreateUser, await readJson(request));
    try { firebaseUid = (await createFirebaseUser(email, generateUnusedInitialPassword())).uid; }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already in use|email-already-exists|email-already-in-use|EMAIL_EXISTS/.test(msg)) throw new DomainError("INVALID_INPUT", "A user with this email already exists");
      throw e;
    }
    const { rows } = await tx.query<{ id: string }>("SELECT movezz_sec.admin_create_user($1::text, $2::text, NULL::text, $3::text, NULL::uuid) AS id", [firebaseUid, email, role]);
    const user = (await tx.query(`${APP_USER_SQL} WHERE u.id = $1`, [rows[0].id])).rows[0];
    return { status: 201, body: { success: true, data: { user: appUserOut(user), emailSent: false }, message: `Account created for ${email}`, _email: email, _role: role } };
  });
  if (res.status !== 201) {
    if (firebaseUid) await deleteFirebaseUser(firebaseUid).catch(() => {});   // never leave a login without a Movezz user
    return res;
  }
  // after commit: claims and the password-setup e-mail are best effort, exactly as before
  const body = await res.json() as { data: { emailSent: boolean }; _email: string; _role: string };
  await setCustomClaims(firebaseUid!, { role: body._role as "super_admin" }).catch(() => {});
  try { await sendPasswordResetEmail(body._email, await generatePasswordResetLink(body._email)); body.data.emailSent = true; } catch { /* the admin can resend */ }
  const { _email, _role, ...rest } = body; void _email; void _role;
  return Response.json(rest, { status: 201 });
}

export const usersDelete = (request: NextRequest, { params }: { params: Params }) => pgRoute(request, params, ["super_admin"], async ({ tx, params: p }) => {
  await authorize(tx, "user.admin");
  if (!isUuid(p.id)) throw new DomainError("NOT_FOUND", "User not found");
  const t = (await tx.query("SELECT id, role FROM users WHERE id = $1 AND is_active", [p.id])).rows[0];
  if (!t) throw new DomainError("NOT_FOUND", "User not found");
  try { await tx.query("SELECT movezz_sec.admin_set_user_active($1::uuid, false, $2::text)", [p.id, "account deleted by administrator"]); }
  catch (e) { // the database refuses to remove the last active super_admin
    if ((e as { code?: string }).code === "MV005") throw new DomainError("INVALID_INPUT", "The last super admin cannot be deleted");
    throw e;
  }
  return { body: { success: true, message: "Account deleted" } };
});

// ---------------------------------------------------------------- customers
const CreateCustomer = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(200), phone: z.string().min(7, "Phone number is required").max(30),
  email: z.string().email("Invalid email address").max(254), notes: z.string().max(2000).optional(), shippingAddress: z.string().max(500).optional(),
});
const UpdateCustomer = z.object({
  name: z.string().min(2).max(200).optional(), phone: z.string().min(7).max(30).optional(), email: z.string().email().max(254).optional(), notes: z.string().max(2000).optional(),
  status: z.enum(["active", "inactive"]).optional(), shippingType: z.enum(["air", "sea"]).optional(), package: z.enum(["basic", "business", "enterprise", "special"]).optional(),
  exchangeRate: z.number().positive().optional().nullable(), shippingAddress: z.string().max(500).optional(), shippingMark: z.string().min(1).max(50).optional(),
  preferredWarehouseId: z.string().uuid().optional(),
});
const SelfUpdate = z.object({ notes: z.string().max(2000).optional(), shippingAddress: z.string().max(500).optional() }).strict();

const CUSTOMER_COLS = "id, name, phone, email, shipping_mark, shipping_address, shipping_type, package_tier, preferred_warehouse_id, notes, status, created_at";

export const customersGet = (request: NextRequest) => pgRoute(request, undefined, ["super_admin", "warehouse_staff"], async ({ tx, request: r }) => {
  await authorize(tx, "customer.read.any");
  const sp = new URL(r.url).searchParams;
  const status = sp.get("status"), search = (sp.get("search") ?? "").trim().toLowerCase();
  const page = Math.max(1, parseInt(sp.get("page") ?? "1") || 1);
  const rl = parseInt(sp.get("limit") ?? "0"); const limit = rl > 0 ? Math.min(rl, 1000) : 50;
  const digits = search.replace(/\D/g, "");
  const where = `archived_at IS NULL AND ($1::text IS NULL OR status = $1) AND ($2 = '' OR lower(name) LIKE '%'||$2||'%' OR lower(email) LIKE '%'||$2||'%' OR lower(shipping_mark) LIKE '%'||$2||'%' OR ($3 <> '' AND phone_digits LIKE '%'||$3||'%'))`;
  const vals = [status === "active" || status === "inactive" ? status : null, search.replace(/[%_\\]/g, ""), digits];
  const total = Number((await tx.query(`SELECT count(*) AS n FROM customers WHERE ${where}`, vals)).rows[0].n);
  const { rows } = await tx.query(`SELECT ${CUSTOMER_COLS} FROM customers WHERE ${where} ORDER BY created_at DESC, id LIMIT $4 OFFSET $5`, [...vals, limit, (page - 1) * limit]);
  return ok(rows.map(customerOut), { total, totalPages: Math.max(1, Math.ceil(total / limit)), page });
});

export async function customersPost(request: NextRequest): Promise<Response> {
  if (!checkRateLimit(`create-customer:${getClientIp(request)}`, 20, 60 * 60_000)) return rateLimitedResponse(3600);
  let firebaseUid: string | null = null;
  const res = await pgRoute(request, undefined, ["super_admin"], async ({ tx }) => {
    await authorize(tx, "customer.admin");
    const { name, phone, email, notes, shippingAddress } = parseInput(CreateCustomer, await readJson(request));
    const digits = phone.replace(/\D/g, "");
    if ((await tx.query("SELECT 1 FROM customers WHERE phone_digits = $1 AND archived_at IS NULL", [digits])).rows[0]) throw new DomainError("INVALID_INPUT", "A customer with this phone number already exists");
    try { firebaseUid = (await createFirebaseUser(email, generateUnusedInitialPassword())).uid; }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/EMAIL_EXISTS|email-already-in-use|already exists/.test(msg)) throw new DomainError("INVALID_INPUT", "A user with this email already exists");
      throw new DomainError("INTEGRITY", "Failed to create login account. Please try again.");
    }
    // shipping mark: generated, then made unique (the database unique index is the final arbiter)
    const base = generateShippingMark(name, phone); let mark = base;
    for (let n = 2; (await tx.query("SELECT 1 FROM customers WHERE shipping_mark = $1", [mark])).rows[0] && n < 100; n++) mark = `${base}-${n}`;
    const created = (await tx.query(
      `INSERT INTO customers (name, phone, email, shipping_mark, shipping_address, notes, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING ${CUSTOMER_COLS}`,
      [name, phone, email, mark, shippingAddress || generateShippingAddress(mark), notes ?? null, "api"])).rows[0];
    await tx.query("SELECT movezz_sec.admin_create_user($1::text, $2::text, $3::text, 'customer', $4::uuid)", [firebaseUid, email, name, created.id]);
    await recordAudit(tx, { action: "customer.create", entityType: "customer", entityId: created.id, after: { shippingMark: mark } });
    return { status: 201, body: { success: true, data: { customer: customerOut(created), emailSent: false, whatsAppSent: false }, message: `Customer ${mark} created successfully`, _c: { email, name, mark } } };
  });
  if (res.status !== 201) { if (firebaseUid) await deleteFirebaseUser(firebaseUid).catch(() => {}); return res; }
  const body = await res.json() as { data: { emailSent: boolean }; _c: { email: string; name: string; mark: string } };
  await setCustomClaims(firebaseUid!, { role: "customer" }).catch(() => {});
  try { await sendWelcomeEmail(body._c.email, body._c.name, body._c.mark); await sendPasswordResetEmail(body._c.email, await generatePasswordResetLink(body._c.email)); body.data.emailSent = true; } catch { /* best effort */ }
  const { _c, ...rest } = body; void _c;
  return Response.json(rest, { status: 201 });
}

export const customerGet = (request: NextRequest, { params }: { params: Params }) => pgRoute(request, params, ["super_admin", "warehouse_staff", "customer"], async ({ tx, actor, params: p }) => {
  const scope = ownerScope(actor);
  if (!isUuid(p.id) || (scope && scope !== p.id)) throw new DomainError("NOT_FOUND", "Customer not found");
  const c = (await tx.query(`SELECT ${CUSTOMER_COLS} FROM customers WHERE id = $1`, [p.id])).rows[0];
  if (!c) throw new DomainError("NOT_FOUND", "Customer not found");
  const items = await selectItems(tx, "i.customer_id = $1", [p.id]);
  // staff are operational users and have no financial read access (D6): they see no orders, customers see their own
  const orders = isAllowed(actor, "invoice.read.any") || isAllowed(actor, "invoice.read.own") ? await selectOrders(tx, "v.customer_id = $1", [p.id]) : [];
  return ok({ ...customerOut(c), items, orders, totalItems: items.length, totalOrders: orders.length });
});

export const customerPatch = (request: NextRequest, { params }: { params: Params }) => pgRoute(request, params, ["super_admin", "customer"], async ({ tx, actor, params: p, request: r }) => {
  if (!isUuid(p.id) || (actor.role === "customer" && actor.customerId !== p.id)) throw new DomainError("NOT_FOUND", "Customer not found");
  const body = await readJson(r);
  if (actor.role === "customer") {
    const patch = parseInput(SelfUpdate, body);
    await updateCustomerSelf(tx, patch);
  } else {
    const d = parseInput(UpdateCustomer, body);
    if (d.exchangeRate != null) throw new DomainError("INVALID_INPUT", "A per-customer exchange rate is not supported; exchange rates are managed centrally");
    const { exchangeRate, package: pkg, ...rest } = d; void exchangeRate;
    await updateCustomerAdmin(tx, p.id, { ...rest, ...(pkg ? { packageTier: pkg } : {}) });
  }
  const c = (await tx.query(`SELECT ${CUSTOMER_COLS} FROM customers WHERE id = $1`, [p.id])).rows[0];
  return ok(customerOut(c), { message: "Customer updated successfully" });
});

export const customerDelete = (request: NextRequest, { params }: { params: Params }) => pgRoute(request, params, ["super_admin"], async ({ tx, params: p }) => {
  await authorize(tx, "customer.admin");
  if (!isUuid(p.id)) throw new DomainError("NOT_FOUND", "Customer not found");
  // customers are never physically deleted (their items, invoices and history reference them): archive = inactive + hidden; logins are deactivated by the database
  const r = await tx.query("UPDATE customers SET status = 'inactive', archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id", [p.id]);
  if (!r.rows[0]) throw new DomainError("NOT_FOUND", "Customer not found");
  await recordAudit(tx, { action: "customer.archive", entityType: "customer", entityId: p.id });
  return { body: { success: true, message: "Customer deleted successfully" } };
});
