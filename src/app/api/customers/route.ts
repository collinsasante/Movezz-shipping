// GET  /api/customers  — list customers (admin/staff only)
// POST /api/customers  — create customer (admin only)
import { NextRequest } from "next/server";
import { customersApi, usersApi } from "@/lib/airtable";
import { createFirebaseUser, setCustomClaims, sendPasswordResetEmail } from "@/lib/firebase-admin";
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

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let p = "PAKK-";
  for (let i = 0; i < 8; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
}

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
    const limit = 50;

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

    const { name, phone, email, notes, shippingAddress } = parsed.data;

    // Check for duplicate phone
    const existingByPhone = await customersApi.getByPhone(phone);
    if (existingByPhone) {
      return badRequestResponse("A customer with this phone number already exists");
    }

    const tempPassword = generateTempPassword();

    // 1. Create Firebase user
    let firebaseUser: { uid: string };
    try {
      firebaseUser = await createFirebaseUser(email, tempPassword);
    } catch (fbErr: unknown) {
      const msg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      if (msg.includes("EMAIL_EXISTS") || msg.includes("email-already-in-use") || msg.includes("already exists")) {
        return badRequestResponse("A user with this email already exists");
      }
      return Response.json({ success: false, error: "Failed to create login account. Please try again." }, { status: 500 });
    }

    // 2. Create customer in Airtable
    let customer: Awaited<ReturnType<typeof customersApi.create>>;
    try {
      customer = await customersApi.create(
        { name, phone, email, notes, shippingAddress },
        user.email
      );
    } catch {
      // Rollback Firebase user
      await import("@/lib/firebase-admin").then(m => m.deleteFirebaseUser(firebaseUser.uid)).catch(() => {});
      return Response.json({ success: false, error: "Failed to save customer record. Please try again." }, { status: 500 });
    }

    // 3. Create user record linking Firebase UID → Airtable customer
    try {
      await usersApi.create(firebaseUser.uid, email, "customer", customer.id);
    } catch {
      // Non-fatal — customer exists, login will auto-create user record on first sign-in
    }

    // 4. Link Firebase UID to customer record
    await customersApi.linkFirebaseUid(customer.id, firebaseUser.uid).catch(() => {});

    // 5. Set Firebase custom claims (no-op, non-fatal)
    setCustomClaims(firebaseUser.uid, { role: "customer", customerId: customer.id }).catch(() => {});

    // 6. Send password-setup email (non-fatal)
    let emailSent = false;
    try {
      await sendPasswordResetEmail(email);
      emailSent = true;
    } catch {
      // sendPasswordResetEmail failed (non-fatal)
    }

    return Response.json(
      {
        success: true,
        data: { customer, emailSent },
        message: `Customer ${customer.shippingMark} created successfully`,
      },
      { status: 201 }
    );
  } catch {
    return Response.json(
      { success: false, error: "Failed to create customer" },
      { status: 500 }
    );
  }
}
