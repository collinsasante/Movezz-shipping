// Shared plumbing for the PostgreSQL implementations of the API routes (src/lib/pg-routes/*).
// One request = authenticate (Firebase token -> users row) -> ONE actor transaction (role / customer / active flags re-read from
// PostgreSQL) -> handler -> JSON in the same envelope the Airtable routes use ({ success, data, ... }).
import { checkRateLimit } from "@/lib/rate-limit";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import type { ZodTypeAny, z } from "zod";
import { pgActorFromRequest, errorResponse } from "@/lib/pg-auth";
import { getPool } from "@/lib/db/client";
import { withActorTransaction, type ActorAssertion } from "@/lib/db/actor";
import { getActorContext, type ActorContext, type Role } from "@/lib/db/authz";
import { DomainError } from "@/lib/db/errors";

export interface Reply { status?: number; body: Record<string, unknown>; headers?: Record<string, string> }
export interface RouteCtx { tx: PoolClient; actor: ActorContext; request: NextRequest; params: Record<string, string>; requestId: string; after: (fn: () => Promise<unknown>) => void }

const LEGACY = new Set(["ACTOR_INVALID", "NOT_AUTHORIZED", "REGISTRATION_NOT_ELIGIBLE", "NOT_FOUND", "INVALID_STATE", "REGISTRATION_CONFLICT", "RATE_LIMITED"]);
const STATUS: Record<string, number> = {
  INVALID_INPUT: 400, DUPLICATE: 409, INTEGRITY: 409, IMMUTABLE_RECORD: 409, ITEM_ALREADY_INVOICED: 409, ACTIVE_PAYMENT_EXISTS: 409, IDEMPOTENCY_CONFLICT: 409,
  CANCELLATION_CONFLICT: 409, INVOICE_ALREADY_CANCELLED: 409, ITEM_NOT_RELEASABLE: 409, CARTON_NOT_RELEASABLE: 409, INVOICE_NOT_FOUND: 404, SPECIAL_RATE_NOT_FOUND: 404,
  OVERPAYMENT: 422, FX_RATE_MISSING: 422, FX_RATE_INVALID: 422, ITEM_UNPRICED: 422, PRICING_NOT_FOUND: 422, PRICING_INVALID: 422, SPECIAL_RATE_NOT_APPLICABLE: 422,
  DISCOUNT_INVALID: 422, DISCOUNT_NOT_AUTHORIZED: 403,
};

/** Stable API error for any failure: no SQL, constraint names, stack traces or actor internals. */
export function apiError(err: unknown, requestId?: string): Response {
  const code = err instanceof DomainError ? err.code : undefined;
  if (!code || LEGACY.has(code) || !(code in STATUS)) return errorResponse(err, requestId);
  const status = STATUS[code];
  const message = code === "INTEGRITY" ? "This change conflicts with existing data" : (err as DomainError).message;
  return Response.json({ success: false, error: message, code }, { status });
}

export const ok = (data: unknown, extra: Record<string, unknown> = {}, status = 200): Reply => ({ status, body: { success: true, data, ...extra } });

export function requireRole(a: ActorContext, roles: readonly Role[]): void {
  if (a.type !== "user" || !a.role || !roles.includes(a.role)) throw new DomainError("NOT_AUTHORIZED", "Forbidden");
}

export function parseInput<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new DomainError("INVALID_INPUT", r.error.errors.map((e: { message: string }) => e.message).join(", ") || "Invalid request");
  return r.data;
}

const MAX_BODY_BYTES = 256 * 1024;
const bodyCache = new WeakMap<object, string>();

/** Reads the request body as a stream and aborts as soon as it exceeds the cap, whatever Content-Length says (or omits). */
async function readCapped(request: NextRequest): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new DomainError("INVALID_INPUT", "Request body is too large");
  if (!request.body) return "";
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new DomainError("INVALID_INPUT", "Request body is too large"); }
      chunks.push(value);
    }
  } catch (e) { if (e instanceof DomainError) throw e; throw new DomainError("INVALID_INPUT", "Request body could not be read"); }
  const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Called by pgRoute/pgServiceRoute AFTER authentication and BEFORE a database transaction is opened: a slow or huge body never holds a connection. */
async function preloadBody(request: NextRequest): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD") return;
  bodyCache.set(request, await readCapped(request));
}

/** Parses the (already size-capped) JSON body. */
export async function readJson(request: NextRequest): Promise<unknown> {
  const text = bodyCache.get(request) ?? await readCapped(request);
  try { return JSON.parse(text); } catch { throw new DomainError("INVALID_INPUT", "Request body must be valid JSON"); }
}

/** Like readJson, but an empty or invalid body is `{}` (routes whose body is optional). Oversized bodies are still refused. */
export async function readJsonOptional(request: NextRequest): Promise<Record<string, unknown>> {
  const text = bodyCache.get(request) ?? await readCapped(request);
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
}

/** Per-user throttle for expensive operations (same limits the Airtable routes had). Throws RATE_LIMITED -> 429. */
export function throttle(userId: string | null, name: string, max: number, windowMs = 60_000): void {
  if (!checkRateLimit(`user:${userId ?? "anon"}:${name}`, max, windowMs)) throw new DomainError("RATE_LIMITED", "Too many requests");
}

/** Runs `fn` as the authenticated actor. `roles` is an early gate only; the database remains the authority. */
export async function pgRoute(
  request: NextRequest, params: Record<string, string> | Promise<Record<string, string>> | undefined,
  roles: readonly Role[] | null, fn: (c: RouteCtx) => Promise<Reply>,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const a = await pgActorFromRequest(request);
    if (!a) return Response.json({ success: false, error: "Authentication required" }, { status: 401 });
    const actor: ActorAssertion = { ...a, requestId };
    await preloadBody(request);
    const p = (await params) ?? {};
    const later: Array<() => Promise<unknown>> = [];
    const reply = await withActorTransaction(getPool(), actor, async (tx) => {
      const ctx = await getActorContext(tx);
      if (roles) requireRole(ctx, roles);
      return fn({ tx, actor: ctx, request, params: p, requestId, after: (f) => { later.push(f); } });
    });
    for (const f of later) await f().catch(() => {});   // best-effort side effects (e-mail) only after COMMIT
    return Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers });
  } catch (err) {
    return apiError(err, requestId);
  }
}

export interface ServiceCtx { actor: ActorAssertion; request: NextRequest; params: Record<string, string>; requestId: string; idempotencyKey: string }

/** For the invoice/payment services, which open their own actor transaction: authenticate, then hand over the verified assertion. */
export async function pgServiceRoute(request: NextRequest, params: Record<string, string> | Promise<Record<string, string>> | undefined, fn: (c: ServiceCtx) => Promise<Reply>): Promise<Response> {
  const requestId = randomUUID();
  try {
    const a = await pgActorFromRequest(request);
    if (!a) return Response.json({ success: false, error: "Authentication required" }, { status: 401 });
    await preloadBody(request);
    const given = request.headers.get("idempotency-key");
    const reply = await fn({ actor: { ...a, requestId }, request, params: (await params) ?? {}, requestId, idempotencyKey: given && given.length >= 8 ? given : `ui-${randomUUID()}` });
    return Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers });
  } catch (err) {
    return apiError(err, requestId);
  }
}

/** Runs a read-only block as the verified actor (row-level security and the actor's role apply). */
export function readAs<T>(actor: ActorAssertion, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  return withActorTransaction(getPool(), actor, fn);
}
