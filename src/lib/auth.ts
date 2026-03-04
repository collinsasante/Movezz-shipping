// ============================================================
// AUTH UTILITIES - Server-side token extraction and validation
// ============================================================
import { NextRequest } from "next/server";
import { verifyIdToken } from "./firebase-admin";
import { usersApi } from "./airtable";
import type { AppUser, UserRole } from "@/types";

const IS_DEV = process.env.NODE_ENV === "development";
const DEV_TOKEN = "DEV_ADMIN_TEST_TOKEN";
const DEV_USER: AppUser = {
  id: "dev-user-id",
  firebaseUid: "dev-uid",
  email: "dev@pakkmaxx.com",
  role: "super_admin",
  createdAt: new Date().toISOString(),
};

// ── In-memory auth cache ──────────────────────────────────────────────────────
// Caches the AppUser per token for 5 minutes to avoid an Airtable round-trip
// on every polling request. The cache is cleared automatically when entries expire.
const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const authCache = new Map<string, { user: AppUser; expiresAt: number }>();

try {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of authCache.entries()) {
      if (val.expiresAt <= now) authCache.delete(key);
    }
  }, 60 * 1000);
} catch (e) {
  console.warn("[auth] setInterval not available in this runtime:", e);
}

// ---- Extract and verify token from request ----
export async function getAuthUser(
  request: NextRequest
): Promise<AppUser | null> {
  try {
    const authHeader = request.headers.get("authorization");
    const cookieToken = request.cookies.get("auth-token")?.value;

    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : cookieToken;

    if (!token) return null;

    // DEV-ONLY: bypass Firebase verification for test token
    if (IS_DEV && token === DEV_TOKEN) return DEV_USER;

    // Return cached user if still valid
    const cached = authCache.get(token);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    const decoded = await verifyIdToken(token);
    const user = await usersApi.getByFirebaseUid(decoded.uid);

    if (!user) return null;

    authCache.set(token, { user, expiresAt: Date.now() + AUTH_CACHE_TTL });

    // Update last login (fire-and-forget, only on cache miss)
    usersApi.updateLastLogin(user.id).catch(console.error);

    return user;
  } catch (err) {
    console.error("Auth verification failed:", err);
    return null;
  }
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
  const user = await getAuthUser(request);

  if (!user) {
    return unauthorizedResponse("Authentication required");
  }

  if (roles && !hasRole(user, roles)) {
    return forbiddenResponse(
      `Access denied. Required role: ${roles.join(" or ")}`
    );
  }

  return { user };
}
