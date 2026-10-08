// Defence in depth against cross-site request forgery for cookie-authenticated API calls.
// The session cookie is already HttpOnly + Secure + SameSite=Strict. On top of that, a state-changing
// request that authenticates with the COOKIE (not an Authorization header, which a foreign site cannot
// attach) and carries an Origin header for another host is refused. Requests without an Origin header
// (non-browser clients, same-origin GET-like navigations) are not affected.
import type { NextRequest } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isCrossSiteCookieRequest(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return false;
  if (!request.cookies.get("auth-token")?.value) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true; // "null" or malformed origins are never same-site
  }
  const hosts = [request.headers.get("host"), request.headers.get("x-forwarded-host"), request.nextUrl.host]
    .filter((h): h is string => !!h)
    .flatMap((h) => h.split(",").map((x) => x.trim()));
  return !hosts.includes(originHost);
}
