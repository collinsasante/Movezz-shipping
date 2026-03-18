// PATCH  /api/special-rates/[id]  — update a special rate
// DELETE /api/special-rates/[id]  — delete a special rate
import { NextRequest } from "next/server";
import { specialRatesApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    const body = await request.json();
    const rate = await specialRatesApi.update(id, { name: body.name, sea: body.sea, air: body.air });
    return Response.json({ success: true, data: rate });
  } catch {
    return serverErrorResponse("Failed to update special rate");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    await specialRatesApi.delete(id);
    return Response.json({ success: true });
  } catch {
    return serverErrorResponse("Failed to delete special rate");
  }
}
