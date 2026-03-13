// POST /api/auth/signup
// Public self-registration endpoint for new customers.
// Supports two flows:
//   1. Email/password  — creates Firebase user + Airtable records
//   2. Google          — Firebase user already exists, just creates Airtable records
import { NextRequest } from "next/server";
import { customersApi, usersApi } from "@/lib/airtable";
import { createFirebaseUser, verifyIdToken, setCustomClaims } from "@/lib/firebase-admin";
import { serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { sendWelcomeEmail } from "@/lib/email";
import { checkRateLimit, rateLimitedResponse, getClientIp, checkBodySize } from "@/lib/rate-limit";
import { z } from "zod";

const EmailSignupSchema = z.object({
  flow: z.literal("email"),
  name: z.string().min(2, "Full name must be at least 2 characters").max(200),
  phone: z.string().min(7, "Valid phone number is required").max(30),
  email: z.string().email("Invalid email address").max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

const GoogleSignupSchema = z.object({
  flow: z.literal("google"),
  name: z.string().min(2, "Full name must be at least 2 characters").max(200),
  phone: z.string().min(7, "Valid phone number is required").max(30),
  idToken: z.string().min(1, "Google ID token is required").max(4096),
});

const SignupSchema = z.discriminatedUnion("flow", [
  EmailSignupSchema,
  GoogleSignupSchema,
]);

export async function POST(request: NextRequest) {
  // Body size guard — reject oversized payloads (max 32KB)
  const sizeErr = checkBodySize(request, 32_768);
  if (sizeErr) return sizeErr;

  // Rate limit: max 5 signups per IP per 10 minutes
  const ip = getClientIp(request);
  if (!checkRateLimit(`signup:${ip}`, 5, 10 * 60_000)) {
    return rateLimitedResponse(600);
  }

  try {
    const body = await request.json();
    const parsed = SignupSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const data = parsed.data;
    let firebaseUid: string;
    let email: string;

    if (data.flow === "email") {
      // ---- FLOW 1: Email/Password ----
      const [existingByEmail, existingByPhone] = await Promise.all([
        customersApi.getByEmail(data.email),
        customersApi.getByPhone(data.phone),
      ]);
      if (existingByEmail) {
        return badRequestResponse("An account with this email already exists");
      }
      if (existingByPhone) {
        return badRequestResponse("An account with this phone number already exists");
      }

      // Create Firebase user
      const fbUser = await createFirebaseUser(data.email, data.password);
      firebaseUid = fbUser.uid;
      email = data.email;
    } else {
      // ---- FLOW 2: Google ----
      // Firebase user already created by Google sign-in on the client
      const decoded = await verifyIdToken(data.idToken);
      firebaseUid = decoded.uid;
      email = decoded.email ?? "";

      if (!email) {
        return badRequestResponse("Could not retrieve email from Google account");
      }

      // Check if they already have an Airtable record (shouldn't, but guard)
      const existingUser = await usersApi.getByFirebaseUid(firebaseUid);
      if (existingUser) {
        return Response.json(
          {
            success: true,
            data: { user: existingUser },
            message: "Account already exists",
            alreadyExists: true,
          },
          { status: 200 }
        );
      }

      // Check for duplicate email or phone in Customers table
      const [existingByEmail, existingByPhone] = await Promise.all([
        customersApi.getByEmail(email),
        customersApi.getByPhone(data.phone),
      ]);
      if (existingByEmail) {
        return badRequestResponse("An account with this email already exists");
      }
      if (existingByPhone) {
        return badRequestResponse("An account with this phone number already exists");
      }
    }

    // ---- Create Airtable customer record ----
    const customer = await customersApi.create(
      { name: data.name, phone: data.phone, email },
      email
    );

    // ---- Link Firebase UID to customer ----
    await customersApi.linkFirebaseUid(customer.id, firebaseUid);

    // ---- Create Airtable user record ----
    const appUser = await usersApi.create(
      firebaseUid,
      email,
      "customer",
      customer.id
    );

    // ---- Set Firebase custom claims (non-fatal — user can still log in without them) ----
    try {
      await setCustomClaims(firebaseUid, {
        role: "customer",
        customerId: customer.id,
      });
    } catch {
      // setCustomClaims failed (non-fatal)
    }

    // Send welcome email (non-fatal)
    sendWelcomeEmail(email, customer.name, customer.shippingMark).catch(() => {});

    return Response.json(
      {
        success: true,
        data: { customer, user: appUser },
        message: `Welcome to PAKKmax! Your shipping mark is ${customer.shippingMark}`,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error) {
      if (msg.includes("email-already-in-use") || msg.includes("already-exists")) {
        return badRequestResponse("An account with this email already exists");
      }
    }
    return Response.json(
      {
        success: false,
        error: "Signup failed. Please try again.",
        ...(process.env.NODE_ENV === "development" && { detail: msg }),
      },
      { status: 500 }
    );
  }
}
