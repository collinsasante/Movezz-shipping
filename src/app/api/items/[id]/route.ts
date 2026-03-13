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
  weight: z.number().positive().max(10_000).optional(),
  length: z.number().positive().max(10_000).optional(),
  width: z.number().positive().max(10_000).optional(),
  height: z.number().positive().max(10_000).optional(),
  description: z.string().max(1000).optional(),
  trackingNumber: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  orderId: z.string().max(50).optional(),
  containerId: z.string().max(50).optional(),
  customerId: z.string().max(50).optional(),
  isMissing: z.boolean().optional(),
  photoUrls: z.array(z.string().url().max(500)).max(20).optional(),
  estPrice: z.number().min(0).max(500_000).optional(),
  estShippingPrice: z.number().min(0).max(500_000).optional(),
  shippingType: z.enum(["air", "sea"]).optional(),
  dimensionUnit: z.enum(["cm", "inches"]).optional(),
  quantity: z.number().int().positive().max(10_000).optional(),
  status: z.string().max(100).optional(),
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
