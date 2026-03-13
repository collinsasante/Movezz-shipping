// GET    /api/items/[id]  — get single item
// PATCH  /api/items/[id]  — update item fields
// DELETE /api/items/[id]  — delete item
import { NextRequest } from "next/server";
import { itemsApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  notFoundResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const UpdateItemSchema = z.object({
  weight: z.number().positive().optional(),
  length: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  description: z.string().optional(),
  trackingNumber: z.string().optional(),
  notes: z.string().optional(),
  orderId: z.string().optional(),
  containerId: z.string().optional(),
  customerId: z.string().optional(),
  isMissing: z.boolean().optional(),
  photoUrls: z.array(z.string().url()).optional(),
});

// GET /api/items/[id]
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
    const item = await itemsApi.getById(id);

    // Customers can only access their own items
    if (user.role === "customer" && item.customerId !== user.customerId) {
      return Response.json(
        { success: false, error: "Access denied" },
        { status: 403 }
      );
    }

    return Response.json({
      success: true,
      data: item,
    });
  } catch {
    return notFoundResponse("Item not found");
  }
}

// PATCH /api/items/[id]
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = UpdateItemSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const item = await itemsApi.update(id, parsed.data, user.email);

    return Response.json({
      success: true,
      data: item,
      message: "Item updated successfully",
    });
  } catch {
    return serverErrorResponse("Failed to update item");
  }
}

// DELETE /api/items/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    await itemsApi.delete(id);
    return Response.json({ success: true, message: "Item deleted" });
  } catch {
    return serverErrorResponse("Failed to delete item");
  }
}
