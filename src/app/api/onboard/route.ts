// POST /api/onboard — public endpoint, no auth required
// Creates customer account + sends password setup email immediately on submission
import { NextRequest } from "next/server";
import {
  customersApi,
  usersApi,
  pendingRegistrationsApi,
  whatsAppApi,
} from "@/lib/airtable";
import {
  createFirebaseUser,
  setCustomClaims,
  generatePasswordResetLink,
  deleteFirebaseUser,
} from "@/lib/firebase-admin";
import { sendWelcomeEmail, sendPasswordResetEmail } from "@/lib/email";
import { checkRateLimit, rateLimitedResponse, getClientIp } from "@/lib/rate-limit";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(2).max(200),
  phone: z.string().min(7).max(30),
  phone2: z.string().max(30).optional(),
  email: z.string().email().max(254),
  existingMark: z.string().max(100).optional().default(""),
  location: z.string().min(2).max(500),
  notes: z.string().max(1000).optional(),
});

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let p = "PAKK-";
  for (let i = 0; i < 8; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`onboard:${ip}`, 5, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  try {
    const body = await request.json();
    const parsed = Schema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { success: false, error: parsed.error.errors.map((e) => e.message).join(", ") },
        { status: 400 }
      );
    }

    const { name, phone, phone2, email, existingMark, location, notes } = parsed.data;

    // Check for duplicate email/phone
    const existingByPhone = await customersApi.getByPhone(phone);
    if (existingByPhone) {
      return Response.json(
        { success: false, error: "An account with this phone number already exists. Try logging in or contact support." },
        { status: 400 }
      );
    }

    const tempPassword = generateTempPassword();

    // 1. Create Firebase user
    let firebaseUser: { uid: string };
    try {
      firebaseUser = await createFirebaseUser(email, tempPassword);
    } catch (fbErr: unknown) {
      const msg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      if (msg.includes("EMAIL_EXISTS") || msg.includes("email-already-in-use") || msg.includes("already exists")) {
        return Response.json(
          { success: false, error: "An account with this email already exists. Try logging in or use Forgot Password." },
          { status: 400 }
        );
      }
      return Response.json(
        { success: false, error: "Failed to create account. Please try again." },
        { status: 500 }
      );
    }

    // 2. Create customer in Airtable
    let customer: Awaited<ReturnType<typeof customersApi.create>>;
    try {
      customer = await customersApi.create(
        { name, phone, email, notes, shippingAddress: location },
        "onboard-form"
      );
    } catch {
      await deleteFirebaseUser(firebaseUser.uid).catch(() => {});
      return Response.json(
        { success: false, error: "Failed to save your details. Please try again." },
        { status: 500 }
      );
    }

    // 3. Link accounts
    await usersApi.create(firebaseUser.uid, email, "customer", customer.id).catch(() => {});
    await customersApi.linkFirebaseUid(customer.id, firebaseUser.uid).catch(() => {});
    setCustomClaims(firebaseUser.uid, { role: "customer", customerId: customer.id }).catch(() => {});

    // 4. Send password setup email + WhatsApp
    try {
      await sendWelcomeEmail(email, name, customer.shippingMark);
      const resetUrl = await generatePasswordResetLink(email);
      await Promise.allSettled([
        sendPasswordResetEmail(email, resetUrl),
        whatsAppApi.sendWelcome(phone, name, customer.shippingMark, resetUrl),
      ]);
    } catch {
      // non-fatal — account exists, customer can use Forgot Password
    }

    // 5. Log to PendingRegistrations as Created (admin record)
    pendingRegistrationsApi
      .create({ name, phone, phone2, email, existingMark, location, notes })
      .then((reg) => pendingRegistrationsApi.markCreated(reg.id))
      .catch(() => {});

    return Response.json({ success: true }, { status: 201 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/onboard]", detail);
    return Response.json(
      { success: false, error: "Something went wrong. Please try again.", detail },
      { status: 500 }
    );
  }
}
