// GET /api/items/[id]/history — status history for an item
import { NextRequest } from "next/server";
import { itemsApi, statusHistoryApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
    "customer",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;

    // Customers can only access history for their own items
    if (user.role === "customer") {
      const item = await itemsApi.getById(id);
      if (item.customerId !== user.customerId) {
        return Response.json(
          { success: false, error: "Access denied" },
          { status: 403 }
        );
      }
    }

    let history: Awaited<ReturnType<typeof statusHistoryApi.getForRecord>> = [];
    try {
      history = await statusHistoryApi.getForRecord(id);
    } catch {
      // Non-fatal — timeline still renders without timestamps
    }
    return Response.json({ success: true, data: history });
  } catch {
    return serverErrorResponse("Failed to load status history");
  }
}
