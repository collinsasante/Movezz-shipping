// PATCH  /api/warehouses/[id]  — toggle active
// DELETE /api/warehouses/[id]  — delete
import { NextRequest } from "next/server";
import { warehousesApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    const body = await request.json();
    const warehouse = await warehousesApi.toggleActive(id, body.isActive);
    return Response.json({ success: true, data: warehouse });
  } catch {
    return serverErrorResponse("Failed to update warehouse");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    await warehousesApi.delete(id);
    return Response.json({ success: true });
  } catch {
    return serverErrorResponse("Failed to delete warehouse");
  }
}
