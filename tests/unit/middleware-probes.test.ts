// The cookie-less exemptions for liveness/readiness must be EXACT: no sibling, child or look-alike path may inherit them.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../src/middleware";

const call = async (path: string, cookie?: string) => middleware(new NextRequest(`http://localhost${path}`, { headers: cookie ? { cookie } : {} }));
const redirectsToLogin = (r: Response) => r.status >= 300 && r.status < 400 && (r.headers.get("location") ?? "").includes("/login");

// Observation (pre-existing, unchanged): middleware treats ANY path containing "." as a static asset and skips the cookie redirect; API route handlers verify tokens themselves.
describe("middleware: probe exemptions are exact", () => {
  it("lets exactly /api/health and /api/ready through without a cookie, with the security headers", async () => {
    for (const p of ["/api/health", "/api/ready"]) { const r = await call(p); expect(redirectsToLogin(r), p).toBe(false); expect(r.headers.get("x-frame-options") ?? r.headers.get("content-security-policy"), p).toBeTruthy(); }
  });
  it("everything else still requires the auth cookie (redirect to /login) — siblings, children, case/encoding tricks, other API routes and pages", async () => {
    for (const p of ["/api/healthz", "/api/health/", "/api/health/x", "/api/ready/x", "/api/readyz", "/api/HEALTH", "/api/items", "/api/orders", "/api/users", "/api/reports", "/api/dashboard/admin", "/admin", "/customer", "/x/api/health"])
      expect(redirectsToLogin(await call(p)), p).toBe(true);
  });
  it("public paths that already existed are unchanged and the cookie path still works", async () => {
    expect(redirectsToLogin(await call("/login"))).toBe(false); expect(redirectsToLogin(await call("/api/auth/verify"))).toBe(false);
    expect(redirectsToLogin(await call("/api/items", "auth-token=x"))).toBe(false);     // a cookie lets the API route run its own token verification, exactly as before
  });
});
