// GET /api/items/[id]/history — status history for an item
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/operations";
import { itemsApi, statusHistoryApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, notFoundResponse } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (isPostgresBackend()) return pg.itemHistoryGet(request, { params });
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
    "customer",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;

    // Customers can only access history for their own items. Ownership is established BEFORE any
    // history is read, and "not yours" looks exactly like "does not exist" (404).
    if (user.role === "customer") {
      const item = await itemsApi.getById(id).catch(() => null);
      if (!item || item.customerId !== user.customerId) {
        return notFoundResponse("Item not found");
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
