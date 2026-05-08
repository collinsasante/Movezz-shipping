// GET /api/admin/registrations — list pending registrations (admin only)
import { NextRequest } from "next/server";
import { pendingRegistrationsApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") as "Pending" | "Created" | null;
    const data = await pendingRegistrationsApi.list(status ?? undefined);
    return Response.json({ success: true, data });
  } catch {
    return serverErrorResponse("Failed to fetch registrations");
  }
}
