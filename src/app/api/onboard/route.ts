// POST /api/onboard — public self-signup, no auth required
// The customer chooses their password here. Creates the Firebase login, the
// Airtable Customer (linked by UID) and the Users row, then sends a welcome
// email and a verification email. The client then signs in with the same
// email + password through the normal /api/auth/verify flow.
//
// Security: an existing Customer is never claimed by matching its email. If
// the email belongs to a Customer with no login yet (created by staff), the
// signup is refused and that customer is pointed to an activation link
// instead (POST /api/customers/[id]/invite).
import { NextRequest } from "next/server";
import {
  customersApi,
  usersApi,
  pendingRegistrationsApi,
  whatsAppApi,
} from "@/lib/airtable";
import {
  createFirebaseUser,
  deleteFirebaseUser,
  verifyPassword,
  generateEmailVerificationLink,
  getAppUrl,
} from "@/lib/firebase-admin";
import { findOrRepairAppUser } from "@/lib/accounts";
import { sendWelcomeEmail, sendEmailVerificationEmail } from "@/lib/email";
import { checkRateLimit, rateLimitedResponse, getClientIp, checkBodySize } from "@/lib/rate-limit";
import { passwordPolicyError, PASSWORD_MAX_LENGTH } from "@/lib/password-policy";
import { z } from "zod";

const Schema = z.object({
  name: z.string().trim().min(2, "Full name must be at least 2 characters").max(200),
  phone: z.string().trim().min(7, "Valid phone number is required").max(30),
  phone2: z.string().trim().max(30).optional(),
  email: z.string().trim().toLowerCase().email("Invalid email address").max(254),
  password: z.string().min(1, "Password is required").max(PASSWORD_MAX_LENGTH),
  existingMark: z.string().max(100).optional().default(""),
  location: z.string().trim().min(2, "Location is required").max(500),
  notes: z.string().max(1000).optional(),
});

// Per-isolate guard against double-submits racing each other
const signupsInFlight = new Set<string>();

function fail(status: number, code: string, error: string) {
  return Response.json({ success: false, code, error }, { status });
}

function firebaseCode(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: NextRequest) {
  const sizeErr = checkBodySize(request, 32_768);
  if (sizeErr) return sizeErr;

  const ip = getClientIp(request);
  if (!checkRateLimit(`onboard:${ip}`, 10, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  const body = await request.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return fail(400, "INVALID_INPUT", parsed.error.errors.map((e) => e.message).join(", "));
  }
  const { name, phone, phone2, email, password, existingMark, location, notes } = parsed.data;

  const policyErr = passwordPolicyError(password);
  if (policyErr) return fail(400, "WEAK_PASSWORD", policyErr);

  // Recovery below checks passwords against Firebase; cap attempts per email so
  // this endpoint can't be used to guess someone's password.
  if (!checkRateLimit(`onboard-email:${email}`, 5, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  if (signupsInFlight.has(email)) {
    return fail(409, "SIGNUP_IN_PROGRESS", "Your account is already being created. Please wait a moment.");
  }
  signupsInFlight.add(email);

  try {
    // ── 1. Conflicts with existing Customers ────────────────────────────────
    const [byEmail, byPhone] = await Promise.all([
      customersApi.getByEmail(email),
      customersApi.getByPhone(phone),
    ]);

    if (byEmail && !byEmail.firebaseUid) {
      // Staff created this customer and they've never activated a login.
      // Matching the email proves nothing, so don't attach a login to it.
      return fail(
        409,
        "CUSTOMER_EXISTS_UNCLAIMED",
        "This email is already registered with De-MOVEZZ LOGISTICS. Contact our team to receive an account activation link."
      );
    }
    if (byPhone && byPhone.id !== byEmail?.id) {
      return fail(
        409,
        "PHONE_IN_USE",
        "An account with this phone number already exists. Sign in instead, or contact support."
      );
    }

    // ── 2. Firebase login ───────────────────────────────────────────────────
    let uid: string;
    let createdLogin = false;
    try {
      uid = (await createFirebaseUser(email, password)).uid;
      createdLogin = true;
    } catch (fbErr) {
      const code = firebaseCode(fbErr);
      if (!code.includes("EMAIL_EXISTS")) {
        console.error("[onboard] Firebase create failed:", code);
        if (code.includes("WEAK_PASSWORD")) return fail(400, "WEAK_PASSWORD", "Please choose a stronger password.");
        if (code.includes("INVALID_EMAIL")) return fail(400, "INVALID_INPUT", "Invalid email address");
        return fail(502, "AUTH_UNAVAILABLE", "We couldn't create your account right now. Please try again.");
      }
      // The email already has a login. If the caller knows its password they
      // own it, which lets us finish a signup that stopped partway (e.g. the
      // browser closed, or Airtable failed after Firebase succeeded).
      try {
        uid = (await verifyPassword(email, password)).uid;
      } catch (pwErr) {
        if (firebaseCode(pwErr).includes("USER_DISABLED")) {
          return fail(403, "ACCOUNT_DISABLED", "This account has been disabled. Contact support.");
        }
        return fail(
          409,
          "EMAIL_IN_USE",
          "An account with this email already exists. Sign in, or use Forgot password to reset it."
        );
      }
    }

    // A linked Customer for this email must be linked to *this* login
    if (byEmail && byEmail.firebaseUid !== uid) {
      if (createdLogin) await deleteFirebaseUser(uid).catch(() => {});
      return fail(409, "EMAIL_IN_USE", "An account with this email already exists. Sign in, or use Forgot password to reset it.");
    }

    // ── 3. Already set up (duplicate submit or retry) ───────────────────────
    const existingUser = await findOrRepairAppUser(uid, email);
    if (existingUser) {
      return Response.json(
        { success: true, data: { email, alreadyRegistered: true, verificationEmailSent: false } },
        { status: 200 }
      );
    }

    // ── 4. Airtable Customer (linked to the login in the same write) ────────
    let customer: Awaited<ReturnType<typeof customersApi.create>>;
    try {
      customer = await customersApi.create(
        { name, phone, email, notes, shippingAddress: location, firebaseUid: uid },
        "onboard-form"
      );
    } catch (atErr) {
      console.error("[onboard] Customer create failed:", atErr);
      // Undo the login we just made so a retry starts clean. If this delete
      // fails too, a retry with the same password recovers via step 2.
      if (createdLogin) await deleteFirebaseUser(uid).catch(() => {});
      return fail(503, "DB_UNAVAILABLE", "We couldn't save your details. Please try again.");
    }

    // ── 5. Users row ────────────────────────────────────────────────────────
    try {
      await usersApi.create(uid, email, "customer", customer.id);
    } catch (atErr) {
      // The Customer is already linked by UID, so /api/auth/verify recreates
      // this row on first sign-in. Not worth failing the signup over.
      console.error("[onboard] Users create failed (will repair at sign-in):", atErr);
    }

    // ── 6. Admin log + emails (none of these block the signup) ──────────────
    const [, , verifyResult] = await Promise.allSettled([
      pendingRegistrationsApi
        .create({ name, phone, phone2, email, existingMark, location, notes })
        .then((reg) => pendingRegistrationsApi.markCreated(reg.id)),
      sendWelcomeEmail(email, name, customer.shippingMark),
      generateEmailVerificationLink(email).then((url) => sendEmailVerificationEmail(email, name, url)),
      whatsAppApi.sendWelcome(phone, name, customer.shippingMark, `${getAppUrl()}/login`, "login"),
    ]);
    if (verifyResult.status === "rejected") {
      console.error("[onboard] verification email failed:", verifyResult.reason);
    }

    return Response.json(
      {
        success: true,
        data: {
          email,
          alreadyRegistered: false,
          verificationEmailSent: verifyResult.status === "fulfilled",
        },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/onboard]", err);
    return fail(500, "SIGNUP_FAILED", "Something went wrong. Please try again.");
  } finally {
    signupsInFlight.delete(email);
  }
}
