// ============================================================
// AUTH UTILITIES - Server-side token extraction and validation
// ============================================================
import { isCrossSiteCookieRequest } from "./csrf";
import { NextRequest } from "next/server";
import { verifyIdToken } from "./firebase-admin";
import { usersApi, customersApi } from "./airtable";
import type { AppUser, UserRole } from "@/types";

// ── In-memory auth cache ──────────────────────────────────────────────────────
// Caches the AppUser per token for 5 minutes to avoid an Airtable round-trip
// on every polling request. The cache is cleared automatically when entries expire.
// (Known limitation, tracked in docs/SECURITY-BASELINE.md: role/status changes take up to
// 5 minutes to apply. The PostgreSQL phase replaces this with a per-request users.is_active check.)
const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * State of the customer profile behind a customer login.
 *  - ok:        linked to an existing, active customer record
 *  - unlinked:  the Users row has no customer record, or it points at a record that no longer exists
 *  - inactive:  the customer record exists but an administrator deactivated it
 * Non-customer roles are always "ok".
 */
export type CustomerLinkState = "ok" | "unlinked" | "inactive";

const authCache = new Map<string, { user: AppUser; link: CustomerLinkState; expiresAt: number }>();

/** Resolves the link state of a customer user. Throws on transient errors so they are never cached as a verdict. */
export async function resolveCustomerLink(user: AppUser): Promise<CustomerLinkState> {
  if (user.role !== "customer") return "ok";
  if (!user.customerId) return "unlinked";
  let customer;
  try {
    customer = await customersApi.getById(user.customerId);
  } catch (err) {
    const status = (err as { statusCode?: number } | null)?.statusCode;
    if (status === 404) return "unlinked"; // dangling link: the customer record was deleted
    throw err; // network / rate limit: do not guess
  }
  return customer.status === "inactive" ? "inactive" : "ok";
}

try {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of authCache.entries()) {
      if (val.expiresAt <= now) authCache.delete(key);
    }
  }, 60 * 1000);
} catch {
  // setInterval not available in this runtime
}

// ---- Extract and verify token from request ----
export async function getAuthContext(
  request: NextRequest
): Promise<{ user: AppUser; link: CustomerLinkState } | null> {
  try {
    const authHeader = request.headers.get("authorization");
    const cookieToken = request.cookies.get("auth-token")?.value;

    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : cookieToken;

    if (!token) return null;

    // Return cached user if still valid
    const cached = authCache.get(token);
    if (cached && cached.expiresAt > Date.now()) return { user: cached.user, link: cached.link };

    const decoded = await verifyIdToken(token);
    const user = await usersApi.getByFirebaseUid(decoded.uid);

    if (!user) return null;

    const link = await resolveCustomerLink(user);
    authCache.set(token, { user, link, expiresAt: Date.now() + AUTH_CACHE_TTL });

    // Update last login (fire-and-forget, only on cache miss)
    usersApi.updateLastLogin(user.id).catch(() => {});

    return { user, link };
  } catch {
    return null;
  }
}

export async function getAuthUser(request: NextRequest): Promise<AppUser | null> {
  return (await getAuthContext(request))?.user ?? null;
}

// ---- Role-based access guards ----
export function isAdmin(user: AppUser): boolean {
  return user.role === "super_admin";
}

export function isStaff(user: AppUser): boolean {
  return user.role === "super_admin" || user.role === "warehouse_staff";
}

export function isCustomer(user: AppUser): boolean {
  return user.role === "customer";
}

export function hasRole(user: AppUser, roles: UserRole[]): boolean {
  return roles.includes(user.role);
}

// ---- Unauthorized response helpers ----
export function unauthorizedResponse(message: string = "Unauthorized") {
  return Response.json({ success: false, error: message }, { status: 401 });
}

export function forbiddenResponse(message: string = "Forbidden") {
  return Response.json({ success: false, error: message }, { status: 403 });
}

export function notFoundResponse(message: string = "Not found") {
  return Response.json({ success: false, error: message }, { status: 404 });
}

export function serverErrorResponse(message: string = "Internal server error") {
  return Response.json({ success: false, error: message }, { status: 500 });
}

export function badRequestResponse(message: string) {
  return Response.json({ success: false, error: message }, { status: 400 });
}

// ---- Require authentication middleware helper ----
export async function requireAuth(
  request: NextRequest,
  roles?: UserRole[]
): Promise<{ user: AppUser } | Response> {
  if (isCrossSiteCookieRequest(request)) {
    return forbiddenResponse("Cross-site request refused");
  }

  const ctx = await getAuthContext(request);

  if (!ctx) {
    return unauthorizedResponse("Authentication required");
  }
  const { user, link } = ctx;

  if (roles && !hasRole(user, roles)) {
    return forbiddenResponse(
      `Access denied. Required role: ${roles.join(" or ")}`
    );
  }

  // Fail closed for customers: every customer-scoped query is filtered by user.customerId, so a
  // customer login without a valid, active customer record must not reach ANY route.
  if (user.role === "customer" && link !== "ok") {
    return customerAccessDenied(link);
  }

  return { user };
}

/** 403 for a customer login that has no usable customer profile. */
export function customerAccessDenied(link: Exclude<CustomerLinkState, "ok">) {
  return Response.json(
    link === "inactive"
      ? { success: false, error: "This account has been deactivated. Contact support.", code: "ACCOUNT_INACTIVE" }
      : { success: false, error: "Your login is not linked to a customer profile. Contact support.", code: "CUSTOMER_NOT_LINKED" },
    { status: 403 }
  );
}
