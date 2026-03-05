import { NextRequest, NextResponse } from "next/server";

// ============================================================
// ROUTE PROTECTION MIDDLEWARE
// ============================================================

const PUBLIC_PATHS = ["/login", "/reset-password", "/auth", "/api/auth"];

const ROLE_ROUTES: Record<string, string[]> = {
  "/admin": ["super_admin", "warehouse_staff"],
  "/customer": ["customer"],
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths without auth
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  const authToken = request.cookies.get("auth-token")?.value;

  // If no token at all, redirect to login
  if (!authToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // For API routes, token validation happens in individual route handlers
  if (pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  // Cookie exists — allow through.
  // Full token verification + role enforcement happens in API routes and
  // client-side AuthContext (which redirects on role mismatch).
  // We avoid calling verify-cookie in middleware because any transient
  // Airtable/JWKS error would incorrectly redirect the user to login.
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg).*)",
  ],
};
