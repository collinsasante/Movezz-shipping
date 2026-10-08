// GET    /api/items/[id]  — get single item
// PATCH  /api/items/[id]  — update item fields
// DELETE /api/items/[id]  — delete item
import { NextRequest } from "next/server";
import { itemsApi, containersApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  notFoundResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";
import { PhotoUrlSchema } from "@/lib/schemas";

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
  photoUrls: z.array(PhotoUrlSchema).max(20).optional(),
  estPrice: z.number().min(0).max(500_000).optional(),
  estShippingPrice: z.number().min(0).max(500_000).optional(),
  pkgEstShipping: z.number().min(0).max(500_000).optional(),
  pkgShippingRate: z.number().min(0).max(500_000).optional(),
  shippingType: z.enum(["air", "sea"]).optional(),
  dimensionUnit: z.enum(["cm", "inches"]).optional(),
  quantity: z.number().int().positive().max(10_000).optional(),
  status: z.string().max(100).optional(),
  dateReceived: z.string().max(50).optional(),
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

    // Customers can only access their own items. Someone else's item and a non-existent item
    // are indistinguishable (404) so ids cannot be probed for existence.
    if (user.role === "customer" && item.customerId !== user.customerId) {
      return notFoundResponse("Item not found");
    }

    // Attach container ETA
    if (item.containerId) {
      try {
        const container = await containersApi.getById(item.containerId);
        item.containerEta = container.eta;
      } catch { /* ignore — item still returns without ETA */ }
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

    // Prices on an item that is already on an invoice are frozen: changing them would silently
    // disagree with what the customer was billed.
    const touchesPrice = ["estPrice", "estShippingPrice", "pkgEstShipping", "pkgShippingRate"].some(
      (k) => (parsed.data as Record<string, unknown>)[k] !== undefined
    );
    if (touchesPrice) {
      const existing = await itemsApi.getById(id).catch(() => null);
      if (!existing) return notFoundResponse("Item not found");
      if (existing.orderId) {
        return Response.json(
          { success: false, error: "This item is already on an invoice; its prices can no longer be changed" },
          { status: 409 }
        );
      }
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
