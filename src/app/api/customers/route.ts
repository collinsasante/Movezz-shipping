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
import { z } from "zod";

const CreateCustomerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  phone: z.string().min(7, "Phone number is required"),
  email: z.string().email("Invalid email address"),
  notes: z.string().optional(),
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

    const customers = await customersApi.list({ status, search });

    return Response.json({ success: true, data: customers });
  } catch (err) {
    console.error("[GET /customers] Error:", err);
    return serverErrorResponse("Failed to fetch customers");
  }
}

// POST /api/customers
export async function POST(request: NextRequest) {
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

    const { name, phone, email, notes } = parsed.data;
    const tempPassword = generateTempPassword();

    // 1. Create Firebase user
    const firebaseUser = await createFirebaseUser(email, tempPassword);

    // 2. Create customer in Airtable
    const customer = await customersApi.create(
      { name, phone, email, notes },
      user.email
    );

    // 3. Create user record linking Firebase UID → Airtable customer
    const appUser = await usersApi.create(
      firebaseUser.uid,
      email,
      "customer",
      customer.id
    );

    // 4. Link Firebase UID to customer record
    await customersApi.linkFirebaseUid(customer.id, firebaseUser.uid);

    // 5. Set Firebase custom claims (non-fatal — user can still log in without them)
    try {
      await setCustomClaims(firebaseUser.uid, {
        role: "customer",
        customerId: customer.id,
      });
    } catch (claimsErr) {
      console.error("[POST /customers] setCustomClaims failed (non-fatal):", claimsErr);
    }

    // 6. Send password-setup email (non-fatal)
    let emailSent = false;
    try {
      await sendPasswordResetEmail(email);
      emailSent = true;
    } catch (emailErr) {
      console.error("[POST /customers] sendPasswordResetEmail failed (non-fatal):", emailErr);
    }

    return Response.json(
      {
        success: true,
        data: { customer, user: appUser, tempPassword, emailSent },
        message: `Customer ${customer.shippingMark} created successfully`,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /customers] Error:", msg);
    // Firebase duplicate email errors
    if (msg.includes("email-already-in-use") || msg.includes("already-exists") || msg.includes("already exists")) {
      return badRequestResponse("A user with this email already exists");
    }
    return Response.json(
      {
        success: false,
        error: "Failed to create customer",
        ...(process.env.NODE_ENV === "development" && { detail: msg }),
      },
      { status: 500 }
    );
  }
}
