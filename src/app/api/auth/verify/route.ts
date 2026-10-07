// POST /api/auth/verify — verify Firebase ID token and return app user
// DELETE /api/auth/verify — sign out (clear cookie)
import { NextRequest } from "next/server";
import { verifyIdToken, isDisabledAccountError } from "@/lib/firebase-admin";
import { usersApi } from "@/lib/airtable";
import { findOrRepairAppUser } from "@/lib/accounts";
import { badRequestResponse } from "@/lib/auth";
import { checkRateLimit, rateLimitedResponse, getClientIp, checkBodySize } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  // Body size guard — Firebase ID tokens are ~1KB; reject anything over 16KB
  const sizeErr = checkBodySize(request, 16_384);
  if (sizeErr) return sizeErr;

  // Rate limit: max 20 verify attempts per IP per minute (handles token refresh)
  const ip = getClientIp(request);
  if (!checkRateLimit(`verify:${ip}`, 20, 60_000)) {
    return rateLimitedResponse(60);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const idToken = typeof body?.idToken === "string" ? body.idToken : "";

    if (!idToken || idToken.length > 8192) {
      return badRequestResponse("idToken is required");
    }

    // Verify Firebase token
    let decoded;
    try {
      decoded = await verifyIdToken(idToken);
    } catch (verifyErr) {
      if (isDisabledAccountError(verifyErr)) {
        return Response.json(
          { success: false, error: "This account has been disabled. Contact support.", code: "ACCOUNT_DISABLED" },
          { status: 403 }
        );
      }
      console.warn("[verify] token rejected:", verifyErr instanceof Error ? verifyErr.message : verifyErr);
      return Response.json(
        { success: false, error: "Your session has expired. Please sign in again.", code: "INVALID_TOKEN" },
        { status: 401 }
      );
    }

    // Look up the Users row by UID, repairing it from a UID-linked Customer if it's missing.
    // There is deliberately no email-based fallback and no "first login becomes
    // super_admin" bootstrap: the first admin is provisioned with
    // scripts/create-superadmin.mjs, and existing customers claim their account
    // through an activation link (POST /api/customers/[id]/invite).
    let appUser: import("@/types").AppUser | null = null;
    try {
      appUser = await findOrRepairAppUser(decoded.uid, decoded.email);
    } catch (dbErr) {
      console.error("[verify] Airtable lookup failed:", dbErr);
      return Response.json(
        { success: false, error: "We couldn't load your account right now. Please try again shortly.", code: "DB_UNAVAILABLE" },
        { status: 503 }
      );
    }

    if (!appUser) {
      return Response.json(
        {
          success: false,
          error: "We couldn't find a De-MOVEZZ account for this login. Create an account, or contact support if you were invited.",
          code: "NOT_REGISTERED",
        },
        { status: 404 }
      );
    }

    // Enrich customer users with shippingMark + customerName (login-time only, not per-request)
    appUser = await usersApi.enrichCustomerUser(appUser).catch(() => appUser!);

    // updateLastLogin is non-fatal — don't block login if this fails
    usersApi.updateLastLogin(appUser.id).catch(() => {});

    return Response.json(
      {
        success: true,
        data: { user: appUser, uid: decoded.uid, email: decoded.email, emailVerified: decoded.emailVerified },
      },
      {
        status: 200,
        headers: { "Set-Cookie": `auth-token=${idToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600` },
      }
    );
  } catch (err: unknown) {
    console.error("[verify] unexpected error:", err);
    return Response.json(
      { success: false, error: "Sign-in failed. Please try again." },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  return Response.json(
    { success: true, message: "Signed out" },
    {
      status: 200,
      headers: { "Set-Cookie": `auth-token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
    }
  );
}
