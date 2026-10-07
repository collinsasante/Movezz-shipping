// POST /api/customers/[id]/invite — send a customer a one-time account activation link (super_admin only)
//
// This is how a customer that already exists in Airtable gets (or regains) a
// login. The admin chooses the customer explicitly; the server makes sure a
// Firebase login exists and is linked to *this* Customer by UID, then emails a
// single-use link where the customer sets their own password. Public signup
// never does this linking by email.
import { NextRequest } from "next/server";
import { customersApi, usersApi, activityLogsApi } from "@/lib/airtable";
import {
  createFirebaseUser,
  getFirebaseUser,
  getFirebaseUserByEmail,
  generateAccountActivationLink,
  generateUnusablePassword,
} from "@/lib/firebase-admin";
import { findOrRepairAppUser } from "@/lib/accounts";
import { sendAccountActivationEmail } from "@/lib/email";
import { requireAuth, notFoundResponse, badRequestResponse, invalidateAuthCache } from "@/lib/auth";
import { checkRateLimit, rateLimitedResponse, getClientIp } from "@/lib/rate-limit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`invite:${ip}`, 30, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  const { id } = await params;
  if (!checkRateLimit(`invite-customer:${id}`, 5, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  const customer = await customersApi.getById(id).catch(() => null);
  if (!customer) return notFoundResponse("Customer not found");
  if (!customer.email) return badRequestResponse("Add an email address to this customer first");

  try {
    // ── Make sure a Firebase login exists and is linked to this customer ────
    let uid = customer.firebaseUid;
    const linkedLogin = uid ? await getFirebaseUser(uid).catch(() => null) : null;

    if (!linkedLogin) {
      const existingLogin = await getFirebaseUserByEmail(customer.email);
      if (existingLogin) {
        // A login with this email exists but isn't linked to this customer.
        // Only adopt it if its owner has proven they control the inbox;
        // otherwise anyone could have registered that email with Firebase.
        if (!existingLogin.emailVerified) {
          return Response.json(
            {
              success: false,
              error:
                "A login with this email already exists but isn't linked to this customer and its email isn't verified, so it can't be safely attached. Contact support to remove that login, then try again.",
            },
            { status: 409 }
          );
        }
        const owner = await usersApi.getByFirebaseUid(existingLogin.localId);
        if (owner && owner.customerId !== customer.id) {
          return Response.json(
            { success: false, error: "That email's login already belongs to another account." },
            { status: 409 }
          );
        }
        uid = existingLogin.localId;
      } else {
        uid = (await createFirebaseUser(customer.email, generateUnusablePassword())).uid;
      }
      await customersApi.linkFirebaseUid(customer.id, uid);
      invalidateAuthCache({ customerId: customer.id });
    }

    // The link must go to the address the login itself uses (it can differ if
    // staff edited the customer's email after the login was created).
    const loginEmail = linkedLogin?.email ?? customer.email;

    // Creates or re-points the Users row from the UID link written above
    await findOrRepairAppUser(uid!, loginEmail);

    // ── Send the activation link ────────────────────────────────────────────
    const activationUrl = await generateAccountActivationLink(loginEmail);
    await sendAccountActivationEmail(loginEmail, customer.name, customer.shippingMark, activationUrl);

    activityLogsApi
      .log({
        action: "customer_activation_sent",
        userEmail: user.email,
        userRole: user.role,
        details: `Activation link sent to ${loginEmail}`,
        entityType: "customer",
        entityId: customer.id,
      })
      .catch(() => {});

    return Response.json({ success: true, message: `Activation link sent to ${loginEmail}` });
  } catch (err) {
    console.error("[POST /api/customers/[id]/invite] failed:", err);
    return Response.json(
      { success: false, error: "Couldn't send the activation link. Please try again." },
      { status: 500 }
    );
  }
}
