// GET  /api/customers  — list customers (admin/staff only)
// POST /api/customers  — create customer (admin only)
import { NextRequest } from "next/server";
import { customersApi, usersApi, whatsAppApi } from "@/lib/airtable";
import {
  createFirebaseUser,
  deleteFirebaseUser,
  generateAccountActivationLink,
  generateUnusablePassword,
} from "@/lib/firebase-admin";
import { sendAccountActivationEmail } from "@/lib/email";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { checkRateLimit, rateLimitedResponse, getClientIp } from "@/lib/rate-limit";
import { z } from "zod";

const CreateCustomerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(200),
  phone: z.string().min(7, "Phone number is required").max(30),
  email: z.string().email("Invalid email address").max(254),
  notes: z.string().max(2000).optional(),
  shippingAddress: z.string().max(500).optional(),
});

// GET /api/customers
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") as
      | "active"
      | "inactive"
      | undefined;
    const search = searchParams.get("search") ?? undefined;

    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    const requestedLimit = parseInt(searchParams.get("limit") ?? "0");
    const limit = requestedLimit > 0 ? Math.min(requestedLimit, 1000) : 50;

    const allCustomers = await customersApi.list({ status, search });
    const total = allCustomers.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const data = allCustomers.slice((page - 1) * limit, page * limit);

    return Response.json({ success: true, data, total, totalPages, page });
  } catch {
    return serverErrorResponse("Failed to fetch customers");
  }
}

// POST /api/customers
// The admin never learns the customer's password: the login gets a random
// password nobody is told, and the customer sets their own through a one-time
// activation link.
export async function POST(request: NextRequest) {
  // Rate limit: max 20 customer creations per IP per hour (prevents Firebase account spam)
  const ip = getClientIp(request);
  if (!checkRateLimit(`create-customer:${ip}`, 20, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = CreateCustomerSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const { name, phone, notes, shippingAddress } = parsed.data;
    const email = parsed.data.email.trim().toLowerCase();

    // Check for duplicate phone / email
    const [existingByPhone, existingByEmail] = await Promise.all([
      customersApi.getByPhone(phone),
      customersApi.getByEmail(email),
    ]);
    if (existingByPhone) {
      return badRequestResponse("A customer with this phone number already exists");
    }
    if (existingByEmail) {
      return badRequestResponse(
        "A customer with this email already exists. Open their profile and use \"Send activation link\" to give them a login."
      );
    }

    // 1. Create Firebase login with a password nobody knows
    let firebaseUser: { uid: string };
    try {
      firebaseUser = await createFirebaseUser(email, generateUnusablePassword());
    } catch (fbErr: unknown) {
      const msg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      if (msg.includes("EMAIL_EXISTS") || msg.includes("email-already-in-use") || msg.includes("already exists")) {
        return badRequestResponse("A user with this email already exists");
      }
      console.error("[POST /api/customers] Firebase create failed:", msg);
      return Response.json({ success: false, error: "Failed to create login account. Please try again." }, { status: 500 });
    }

    // 2. Create customer in Airtable, linked to the login in the same write
    let customer: Awaited<ReturnType<typeof customersApi.create>>;
    try {
      customer = await customersApi.create(
        { name, phone, email, notes, shippingAddress, firebaseUid: firebaseUser.uid },
        user.email
      );
    } catch (atErr) {
      console.error("[POST /api/customers] Customer create failed:", atErr);
      await deleteFirebaseUser(firebaseUser.uid).catch(() => {});
      return Response.json({ success: false, error: "Failed to save customer record. Please try again." }, { status: 500 });
    }

    // 3. Create user record linking Firebase UID → Airtable customer
    try {
      await usersApi.create(firebaseUser.uid, email, "customer", customer.id);
    } catch (atErr) {
      // Non-fatal — the customer is linked by UID, so sign-in recreates this row
      console.error("[POST /api/customers] Users create failed (will repair at sign-in):", atErr);
    }

    // 4. Send activation link by email + WhatsApp (non-fatal; admin can resend)
    let emailSent = false;
    let whatsAppSent = false;
    try {
      const activationUrl = await generateAccountActivationLink(email);
      const [emailResult, waResult] = await Promise.allSettled([
        sendAccountActivationEmail(email, name, customer.shippingMark, activationUrl),
        whatsAppApi.sendWelcome(phone, name, customer.shippingMark, activationUrl, "activate"),
      ]);
      emailSent = emailResult.status === "fulfilled";
      whatsAppSent = waResult.status === "fulfilled";
    } catch (linkErr) {
      console.error("[POST /api/customers] activation link failed:", linkErr);
    }

    return Response.json(
      {
        success: true,
        data: { customer, emailSent, whatsAppSent },
        message: `Customer ${customer.shippingMark} created successfully`,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/customers] unhandled error:", err);
    return Response.json(
      { success: false, error: "Failed to create customer" },
      { status: 500 }
    );
  }
}
