import { NextRequest, NextResponse } from "next/server";

// ============================================================
// ROUTE PROTECTION MIDDLEWARE
// ============================================================

const PUBLIC_PATHS = ["/login", "/reset-password", "/auth", "/api/auth"];

const ROLE_ROUTES: Record<string, string[]> = {
  "/admin": ["super_admin", "warehouse_staff"],
  "/customer": ["customer"],
};

// Security headers applied to every response
function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Next.js requires unsafe-inline/eval in dev; tighten in prod with nonces
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://res.cloudinary.com https://lh3.googleusercontent.com",
      "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths without auth
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return applySecurityHeaders(NextResponse.next());
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
    return applySecurityHeaders(NextResponse.next());
  }

  // Cookie exists — allow through.
  // Full token verification + role enforcement happens in API routes and
  // client-side AuthContext (which redirects on role mismatch).
  // We avoid calling verify-cookie in middleware because any transient
  // Airtable/JWKS error would incorrectly redirect the user to login.
  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg).*)",
  ],
};
