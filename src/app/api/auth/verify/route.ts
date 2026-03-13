// POST /api/auth/verify — verify Firebase ID token and return app user
// DELETE /api/auth/verify — sign out (clear cookie)
import { NextRequest } from "next/server";
import { verifyIdToken } from "@/lib/firebase-admin";
import { usersApi, customersApi } from "@/lib/airtable";
import { badRequestResponse } from "@/lib/auth";

const IS_DEV = process.env.NODE_ENV === "development";

export async function POST(request: NextRequest) {
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
    } catch {
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
      // Bootstrap: first Firebase login auto-creates super_admin if the Users table is empty.
      let userCount = 0;
      try {
        userCount = await usersApi.countAll();
      } catch (countErr) {
        const msg = countErr instanceof Error ? countErr.message : String(countErr);
        return Response.json(
          {
            success: false,
            error: "Cannot count users in database. Check Airtable setup.",
            step: "count_users",
            ...(IS_DEV && { detail: msg }),
          },
          { status: 503 }
        );
      }

      if (userCount === 0) {
        try {
          appUser = await usersApi.create(decoded.uid, decoded.email ?? "", "super_admin");
        } catch (createErr) {
          const msg = createErr instanceof Error ? createErr.message : String(createErr);
          return Response.json(
            {
              success: false,
              error: "Failed to create your account in the database.",
              step: "create_user",
              ...(IS_DEV && { detail: msg }),
            },
            { status: 500 }
          );
        }
      } else {
        // Check if this Firebase user was created by an admin (email exists in Customers table)
        const existingCustomer = await customersApi.getByEmail(decoded.email ?? "").catch(() => null);
        if (existingCustomer) {
          try {
            appUser = await usersApi.create(decoded.uid, decoded.email ?? "", "customer", existingCustomer.id);
            // Link Firebase UID to customer record (non-fatal)
            customersApi.linkFirebaseUid(existingCustomer.id, decoded.uid).catch(() => {});
          } catch (createErr) {
            const msg = createErr instanceof Error ? createErr.message : String(createErr);
            return Response.json(
              { success: false, error: "Failed to set up your account.", detail: msg, step: "auto_create_customer" },
              { status: 500 }
            );
          }
        } else {
          return Response.json(
            {
              success: false,
              error: "You are not registered in this system. Ask an administrator to add you.",
              code: "NOT_REGISTERED",
            },
            { status: 404 }
          );
        }
      }
    }

    // Enrich customer users with shippingMark + customerName (login-time only, not per-request)
    appUser = await usersApi.enrichCustomerUser(appUser).catch(() => appUser!);

    // updateLastLogin is non-fatal — don't block login if this fails
    usersApi.updateLastLogin(appUser.id).catch(() => {});

    return Response.json(
      { success: true, data: { user: appUser, uid: decoded.uid, email: decoded.email } },
      {
        status: 200,
        headers: { "Set-Cookie": `auth-token=${idToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800` },
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
  return Response.json(
    { success: true, message: "Signed out" },
    {
      status: 200,
      headers: { "Set-Cookie": `auth-token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
    }
  );
}
