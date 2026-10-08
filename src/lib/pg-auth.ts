// Authentication for PostgreSQL-backed routes. The chain is:
//   Firebase ID token (verified by Firebase, never trusted from the client) -> users.auth_uid -> trusted actor (movezz_sec.begin_actor)
// The role and account state are NOT read here: every service call opens its own actor transaction, which re-reads the user, the
// customer link and the active flags from PostgreSQL (no cache), and then authorizes the operation. A token whose user is unknown,
// inactive or whose customer is inactive therefore fails with ACTOR_INVALID on the very next request.
import type { NextRequest } from "next/server";
import { verifyIdToken } from "@/lib/firebase-admin";
import { isCrossSiteCookieRequest } from "@/lib/csrf";
import { getPool } from "@/lib/db/client";
import { DomainError } from "@/lib/db/errors";
import { user, type ActorAssertion } from "@/lib/db/actor";
import { describeError, logEvent } from "@/lib/db/log";

function tokenOf(request: NextRequest): string | null {
  const h = request.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7) || null;
  return request.cookies.get("auth-token")?.value || null;
}

/** Returns the trusted-actor assertion for the authenticated user, or null (-> 401). Never takes an id from the request body. */
export async function pgActorFromRequest(request: NextRequest): Promise<ActorAssertion | null> {
  if (isCrossSiteCookieRequest(request)) throw new DomainError("NOT_AUTHORIZED", "Cross-site request refused");
  const token = tokenOf(request);
  if (!token) return null;
  let decoded: { uid: string };
  try { decoded = await verifyIdToken(token); } catch { return null; }
  const { rows } = await getPool().query<{ id: string }>("SELECT id FROM users WHERE auth_uid = $1", [decoded.uid]);
  return rows[0] ? user(rows[0].id) : null;
}

/** Maps a service error to an HTTP response without leaking SQL, stack traces or internal detail. */
export function errorResponse(err: unknown, requestId?: string): Response {
  const code = err instanceof DomainError ? err.code : undefined;
  if (!code || !(code in { ACTOR_INVALID: 1, NOT_AUTHORIZED: 1 })) logEvent(code ? "warn" : "error", code ? "route.rejected" : "route.failed", describeError(err), requestId); // (auth failures are already logged by the actor transaction)
  const map: Record<string, [number, string]> = {
    ACTOR_INVALID: [401, "Authentication required"],
    NOT_AUTHORIZED: [403, "Forbidden"],
    INVALID_INPUT: [400, "Invalid request"],
    REGISTRATION_NOT_ELIGIBLE: [404, "Not found"],
    NOT_FOUND: [404, "Not found"],
    INVALID_STATE: [409, "This request is no longer in a state that allows this action"],
    REGISTRATION_CONFLICT: [409, "This registration needs administrator attention"],
    RATE_LIMITED: [429, "Too many requests. Please try again later."],
  };
  const [status, message] = (code && map[code]) || [500, "Something went wrong"];
  return Response.json({ success: false, error: message, ...(code && status < 500 ? { code } : {}) }, { status, headers: status === 429 ? { "Retry-After": "3600" } : undefined });
}
