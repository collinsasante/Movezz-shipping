// GET    /api/containers/[id]         — get single container with items
// PATCH  /api/containers/[id]         — update container
// DELETE /api/containers/[id]         — delete container
// POST  /api/containers/[id]/items    — add item to container
// DELETE /api/containers/[id]/items   — remove item from container
import { NextRequest } from "next/server";
import { containersApi, itemsApi, customersApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  notFoundResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const UpdateContainerSchema = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  eta: z.string().max(50).optional(),
  arrivalDate: z.string().max(50).optional(),
  trackingNumber: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  createdAt: z.string().max(50).optional(),
});

const ManageItemSchema = z.object({
  itemId: z.string().min(1, "Item ID is required").max(50),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;
    const container = await containersApi.getById(id);

    // Deduplicate itemIds — Airtable linked fields can contain the same ID twice
    const uniqueItemIds = [...new Set(container.itemIds)];

    // Hydrate items
    const rawItems = uniqueItemIds.length
      ? (await Promise.all(uniqueItemIds.map((itemId) => itemsApi.getById(itemId).catch(() => null)))).filter(Boolean)
      : [];

    // Collect customerIds that are missing name or shippingMark
    const missingIds = new Set(
      rawItems
        .filter((item) => item.customerId && (!item.customerName || !item.customerShippingMark))
        .map((item) => item.customerId)
    );

    // Batch-fetch those customers and build a lookup map
    const customerMap = new Map<string, { name: string; shippingMark: string }>();
    if (missingIds.size > 0) {
      const fetched = await Promise.all(
        [...missingIds].map((cid) => customersApi.getById(cid).catch(() => null))
      );
      for (const c of fetched) {
        if (c) customerMap.set(c.id, { name: c.name, shippingMark: c.shippingMark });
      }
    }

    // Merge customer data into every item that needs it
    const items = rawItems.map((item) => {
      const cust = item.customerId ? customerMap.get(item.customerId) : undefined;
      return {
        ...item,
        customerName: item.customerName || cust?.name || undefined,
        customerShippingMark: item.customerShippingMark || cust?.shippingMark || undefined,
      };
    });

    return Response.json({
      success: true,
      data: { ...container, items },
    });
  } catch {
    return notFoundResponse("Container not found");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = UpdateContainerSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const container = await containersApi.update(id, parsed.data, user.email);

    return Response.json({
      success: true,
      data: container,
      message: "Container updated",
    });
  } catch {
    return serverErrorResponse("Failed to update container");
  }
}

// DELETE /api/containers/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    await containersApi.delete(id);
    return Response.json({ success: true, message: "Container deleted" });
  } catch {
    return serverErrorResponse("Failed to delete container");
  }
}
