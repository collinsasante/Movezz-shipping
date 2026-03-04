// PATCH /api/items/[id]/status — update item status
// Triggers WhatsApp notification and logs history
import { NextRequest } from "next/server";
import { itemsApi, BusinessError } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { ITEM_STATUS_STEPS } from "@/lib/utils";
import { z } from "zod";
import type { ItemStatus } from "@/types";

const UpdateStatusSchema = z.object({
  status: z.enum([
    "Arrived at Transit Warehouse",
    "Shipped to Ghana",
    "Arrived in Ghana",
    "Sorting",
    "Ready for Pickup",
    "Completed",
  ]),
  notes: z.string().optional(),
  sendWhatsApp: z.boolean().optional().default(false),
});

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
    const parsed = UpdateStatusSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const { status, notes, sendWhatsApp } = parsed.data;

    // Validate forward-only status progression
    const existing = await itemsApi.getById(id);
    const currentIndex = ITEM_STATUS_STEPS.indexOf(
      existing.status as ItemStatus
    );
    const newIndex = ITEM_STATUS_STEPS.indexOf(status as ItemStatus);

    // Admin can skip steps; staff must go in order
    if (user.role === "warehouse_staff" && newIndex < currentIndex) {
      return badRequestResponse(
        "Status can only move forward in the pipeline"
      );
    }

    const item = await itemsApi.updateStatus(
      id,
      status as ItemStatus,
      user.email,
      user.role,
      notes,
      sendWhatsApp
    );

    return Response.json({
      success: true,
      data: item,
      message: `Item status updated to: ${status}`,
    });
  } catch (err: unknown) {
    if (err instanceof BusinessError) {
      return badRequestResponse(err.message);
    }
    console.error("[PATCH /items/[id]/status] Error:", err);
    return serverErrorResponse("Failed to update item status");
  }
}
