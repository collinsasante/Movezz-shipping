// GET /api/auth/verify-cookie — lightweight cookie validation for middleware
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/identity";
import { verifyIdToken } from "@/lib/firebase-admin";
import { usersApi } from "@/lib/airtable";

export async function GET(request: NextRequest) {
  if (isPostgresBackend()) return pg.verifyCookie(request);
  try {
    const token = request.cookies.get("auth-token")?.value;
    if (!token) {
      return Response.json({ success: false }, { status: 401 });
    }

    const decoded = await verifyIdToken(token);
    let user = await usersApi.getByFirebaseUid(decoded.uid);

    if (!user) {
      return Response.json({ success: false }, { status: 401 });
    }

    // Enrich customer users with name/phone/shippingMark from Customers table
    user = await usersApi.enrichCustomerUser(user).catch(() => user!);

    return Response.json({
      success: true,
      data: user,
    });
  } catch {
    return Response.json({ success: false }, { status: 401 });
  }
}
