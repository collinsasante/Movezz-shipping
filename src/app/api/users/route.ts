// GET  /api/users  — list all users (super_admin only)
// POST /api/users  — create user account (super_admin only)
import { NextRequest } from "next/server";
import { usersApi } from "@/lib/airtable";
import { createFirebaseUser, deleteFirebaseUser, setCustomClaims, sendPasswordResetEmail } from "@/lib/firebase-admin";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const CreateUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["super_admin", "warehouse_staff"], {
    errorMap: () => ({ message: "Role must be super_admin or warehouse_staff" }),
  }),
});

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let p = "PAKK-";
  for (let i = 0; i < 8; i++) p += chars[bytes[i] % chars.length];
  return p;
}

// GET /api/users
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const users = await usersApi.listAll();
    return Response.json({ success: true, data: users });
  } catch {
    return serverErrorResponse("Failed to fetch users");
  }
}

// POST /api/users
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await request.json();
    const parsed = CreateUserSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const { email, role } = parsed.data;
    const tempPassword = generateTempPassword();

    // 1. Create Firebase user
    let firebaseUid: string;
    try {
      const firebaseUser = await createFirebaseUser(email, tempPassword);
      firebaseUid = firebaseUser.uid;
    } catch (fbErr: unknown) {
      const msg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      if (msg.includes("already in use") || msg.includes("email-already-exists") || msg.includes("email-already-in-use")) {
        return badRequestResponse("A user with this email already exists");
      }
      throw fbErr;
    }

    // 2. Create user record in Airtable (rollback Firebase user if this fails)
    let appUser;
    try {
      appUser = await usersApi.create(firebaseUid, email, role);
    } catch (atErr: unknown) {
      await deleteFirebaseUser(firebaseUid).catch(() => {});
      throw atErr;
    }

    // 3. Set Firebase custom claims (non-fatal)
    try {
      await setCustomClaims(firebaseUid, { role });
    } catch {
      // setCustomClaims failed (non-fatal)
    }

    // 4. Send password-setup email (non-fatal)
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
        data: { user: appUser, emailSent, tempPassword },
        message: `Account created for ${email}`,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        success: false,
        error: "Failed to create staff account",
        ...(process.env.NODE_ENV === "development" && { detail: msg }),
      },
      { status: 500 }
    );
  }
}
