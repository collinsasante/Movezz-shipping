// Shared plumbing for the PostgreSQL implementations of the API routes (src/lib/pg-routes/*).
// One request = authenticate (Firebase token -> users row) -> ONE actor transaction (role / customer / active flags re-read from
// PostgreSQL) -> handler -> JSON in the same envelope the Airtable routes use ({ success, data, ... }).
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

export async function readJson(request: NextRequest): Promise<unknown> {
  try { return await request.json(); } catch { throw new DomainError("INVALID_INPUT", "Request body must be valid JSON"); }
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
