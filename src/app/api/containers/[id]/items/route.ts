// POST   /api/containers/[id]/items  — add item to container
// DELETE /api/containers/[id]/items  — remove item from container
import { NextRequest } from "next/server";
import { containersApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const ManageItemSchema = z.object({
  itemId: z.string().min(1, "Item ID is required"),
});

export async function POST(
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
    const body = await request.json();
    const parsed = ManageItemSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const { id } = await params;
    const container = await containersApi.addItem(id, parsed.data.itemId, user.email);

    return Response.json({
      success: true,
      data: container,
      message: "Item added to container",
    });
  } catch (err) {
    console.error("[POST /containers/[id]/items] Error:", err);
    return serverErrorResponse("Failed to add item to container");
  }
}

export async function DELETE(
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
    const body = await request.json();
    const parsed = ManageItemSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const { id } = await params;
    const container = await containersApi.removeItem(id, parsed.data.itemId, user.email);

    return Response.json({
      success: true,
      data: container,
      message: "Item removed from container",
    });
  } catch (err) {
    console.error("[DELETE /containers/[id]/items] Error:", err);
    return serverErrorResponse("Failed to remove item from container");
  }
}
