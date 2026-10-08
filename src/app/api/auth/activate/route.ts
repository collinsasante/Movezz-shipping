// POST /api/auth/activate — the applicant activates their APPROVED registration (Phase 7G, D9).
// Identity comes ONLY from the verified Firebase ID token (Authorization: Bearer ...): uid and e-mail are what Firebase says, and the
// e-mail must be VERIFIED. The body is ignored entirely, so nothing in it (uid, email, role, customerId, status) can influence the result.
// There is no password here: the applicant created their own Firebase login (own password or Google) and verified their e-mail.
import { NextRequest } from "next/server";
import { verifyIdToken } from "@/lib/firebase-admin";
import { getPool } from "@/lib/db/client";
import { activateRegistration } from "@/lib/db/registration";
import { errorResponse } from "@/lib/pg-auth";
import { checkRateLimit, rateLimitedResponse, getClientIp } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`activate:${ip}`, 20, 60 * 60_000)) return rateLimitedResponse(3600);
  const h = request.headers.get("authorization");
  const token = h?.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return Response.json({ success: false, error: "Authentication required" }, { status: 401 });

  let decoded: { uid: string; email?: string; emailVerified: boolean };
  try { decoded = await verifyIdToken(token); } catch { return Response.json({ success: false, error: "Authentication required" }, { status: 401 }); }
  if (decoded.emailVerified !== true) {
    return Response.json({ success: false, error: "Please verify your e-mail address first, then try again.", code: "EMAIL_NOT_VERIFIED" }, { status: 403 });
  }
  if (!checkRateLimit(`activate-uid:${decoded.uid}`, 10, 60 * 60_000)) return rateLimitedResponse(3600);

  try {
    const r = await activateRegistration(getPool(), { uid: decoded.uid, email: decoded.email ?? null, emailVerified: decoded.emailVerified });
    return Response.json({ success: true, data: { activated: true, alreadyActive: r.alreadyActive } }, { status: r.alreadyActive ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
