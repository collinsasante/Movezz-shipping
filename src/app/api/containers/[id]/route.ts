// GET    /api/containers/[id]         — get single container with items
// PATCH  /api/containers/[id]         — update container
// DELETE /api/containers/[id]         — delete container
// POST  /api/containers/[id]/items    — add item to container
// DELETE /api/containers/[id]/items   — remove item from container
import { NextRequest } from "next/server";
import { containersApi, itemsApi } from "@/lib/airtable";
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

    // Hydrate items — log failures but return partial data
    const items = container.itemIds.length
      ? (
          await Promise.all(
            container.itemIds.map((itemId) =>
              itemsApi.getById(itemId).catch((err) => {
                console.error(`[containers/${id}] Failed to fetch item ${itemId}:`, err);
                return null;
              })
            )
          )
        ).filter(Boolean)
      : [];

    return Response.json({
      success: true,
      data: { ...container, items },
    });
  } catch (err) {
    console.error("[GET /containers/[id]] Error:", err);
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
  } catch (err) {
    console.error("[PATCH /containers/[id]] Error:", err);
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
  } catch (err) {
    console.error("[DELETE /containers/[id]] Error:", err);
    return serverErrorResponse("Failed to delete container");
  }
}
