// POST /api/auth/verify — verify Firebase ID token and return app user
// DELETE /api/auth/verify — sign out (clear cookie)
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/identity";
import { verifyIdToken } from "@/lib/firebase-admin";
import { usersApi, customersApi } from "@/lib/airtable";
import { badRequestResponse, customerAccessDenied, resolveCustomerLink } from "@/lib/auth";
import { checkRateLimit, rateLimitedResponse, getClientIp, checkBodySize } from "@/lib/rate-limit";

const IS_DEV = process.env.NODE_ENV === "development";

export async function POST(request: NextRequest) {
  if (isPostgresBackend()) return pg.verifyPost(request);
  // Body size guard — Firebase ID tokens are ~1KB; reject anything over 16KB
  const sizeErr = checkBodySize(request, 16_384);
  if (sizeErr) return sizeErr;

  // Rate limit: max 20 verify attempts per IP per minute (handles token refresh)
  const ip = getClientIp(request);
  if (!checkRateLimit(`verify:${ip}`, 20, 60_000)) {
    return rateLimitedResponse(60);
  }

  try {
    const body = await request.json();
    const { idToken } = body;

    if (!idToken) {
      return badRequestResponse("idToken is required");
    }

    // Verify Firebase token
    let decoded;
    try {
      decoded = await verifyIdToken(idToken);
    } catch (verifyErr) {
      console.warn("[verify] token rejected:", verifyErr instanceof Error ? verifyErr.message : "unknown");
      return Response.json(
        { success: false, error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    // Look up user in Airtable
    let appUser: import("@/types").AppUser | null = null;
    try {
      appUser = await usersApi.getByFirebaseUid(decoded.uid);
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      return Response.json(
        {
          success: false,
          error: "Cannot reach database. Check AIRTABLE_API_KEY and AIRTABLE_BASE_ID, and make sure the Users table exists.",
          step: "airtable_read",
          ...(IS_DEV && { detail: msg }),
        },
        { status: 503 }
      );
    }

    if (!appUser) {
      // SECURITY: there is deliberately NO "first login becomes super_admin" bootstrap. The first
      // administrator is created by an operator with `npm run admin:bootstrap`; every other account is
      // created by an administrator or through the customer onboarding flow.
      //
      // The only automatic registration left is the legacy claim of an admin-created Customers row by
      // e-mail. It requires a VERIFIED e-mail (otherwise anyone could register a Firebase login with a
      // victim's address and inherit the victim's account) and a customer that no other login owns.
      const email = (decoded.email ?? "").trim();
      const candidate =
        email && decoded.emailVerified === true
          ? await customersApi.getByEmail(email).catch(() => null)
          : null;
      const claimable = candidate && (!candidate.firebaseUid || candidate.firebaseUid === decoded.uid);

      if (!candidate || !claimable) {
        return Response.json(
          {
            success: false,
            error: "You are not registered in this system. Ask an administrator to add you.",
            code: "NOT_REGISTERED",
          },
          { status: 404 }
        );
      }

      try {
        appUser = await usersApi.create(decoded.uid, email, "customer", candidate.id);
        // Link Firebase UID to customer record (non-fatal)
        customersApi.linkFirebaseUid(candidate.id, decoded.uid).catch(() => {});
      } catch (createErr) {
        console.error("[verify] could not register customer login:", createErr instanceof Error ? createErr.message : "unknown");
        return Response.json(
          { success: false, error: "Failed to set up your account.", step: "auto_create_customer" },
          { status: 500 }
        );
      }
    }

    // A customer login needs a valid, active customer profile (fail closed).
    if (appUser.role === "customer") {
      let link;
      try {
        link = await resolveCustomerLink(appUser);
      } catch {
        return Response.json({ success: false, error: "Could not verify your account. Please try again.", step: "customer_link" }, { status: 503 });
      }
      if (link !== "ok") return customerAccessDenied(link);
    }

    // Enrich customer users with shippingMark + customerName (login-time only, not per-request)
    appUser = await usersApi.enrichCustomerUser(appUser).catch(() => appUser!);

    // updateLastLogin is non-fatal — don't block login if this fails
    usersApi.updateLastLogin(appUser.id).catch(() => {});

    return Response.json(
      { success: true, data: { user: appUser, uid: decoded.uid, email: decoded.email } },
      {
        status: 200,
        headers: { "Set-Cookie": `auth-token=${idToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600` },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { success: false, error: "Verification failed", ...(IS_DEV && { detail: message }) },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  if (isPostgresBackend()) return pg.verifyDelete();
  return Response.json(
    { success: true, message: "Signed out" },
    {
      status: 200,
      headers: { "Set-Cookie": `auth-token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
    }
  );
}
