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

  // If no token, redirect to login
  if (!authToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // For API routes, token validation happens in individual route handlers
  if (pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  // For admin routes, verify role via lightweight check
  // (Full verification happens server-side in page components / API routes)
  try {
    const verifyRes = await fetch(new URL("/api/auth/verify-cookie", request.url), {
      headers: { cookie: request.headers.get("cookie") ?? "" },
    });

    if (!verifyRes.ok) {
      const loginUrl = new URL("/login", request.url);
      return NextResponse.redirect(loginUrl);
    }

    const data = await verifyRes.json().catch(() => null);

    if (!data?.success) {
      const loginUrl = new URL("/login", request.url);
      return NextResponse.redirect(loginUrl);
    }

    const userRole: string = data.data?.role ?? "";

    // Check role-based route protection
    for (const [route, allowedRoles] of Object.entries(ROLE_ROUTES)) {
      if (pathname.startsWith(route) && !allowedRoles.includes(userRole)) {
        // Redirect customers to customer dashboard, admins to admin dashboard
        if (userRole === "customer") {
          return NextResponse.redirect(new URL("/customer", request.url));
        }
        if (userRole === "super_admin" || userRole === "warehouse_staff") {
          return NextResponse.redirect(new URL("/admin", request.url));
        }
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.next();
  } catch {
    // On middleware error, allow through (route handlers will enforce auth)
    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg).*)",
  ],
};
