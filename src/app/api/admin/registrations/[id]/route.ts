// PATCH /api/admin/registrations/[id] — mark registration as Created
import { NextRequest } from "next/server";
import { pendingRegistrationsApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;
    await pendingRegistrationsApi.markCreated(id);
    return Response.json({ success: true });
  } catch {
    return serverErrorResponse("Failed to update registration");
  }
}
