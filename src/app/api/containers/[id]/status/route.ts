// PATCH /api/containers/[id]/status
// Updates container status and cascades to items on "Arrived in Ghana"
import { NextRequest } from "next/server";
import { containersApi, BusinessError } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const UpdateStatusSchema = z.object({
  status: z.enum(["Loading", "Shipped to Ghana", "Arrived in Ghana", "Completed"]),
  notes: z.string().optional(),
  arrivalDate: z.string().optional(),
});

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
    const parsed = UpdateStatusSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const { status, notes, arrivalDate } = parsed.data;

    // Update arrival date if provided or if arriving in Ghana
    if (arrivalDate || status === "Arrived in Ghana") {
      await containersApi.update(
        id,
        { arrivalDate: arrivalDate ?? new Date().toISOString().split("T")[0] },
        user.email
      );
    }

    // updateStatus handles cascade logic
    const container = await containersApi.updateStatus(
      id,
      status,
      user.email,
      user.role,
      notes
    );

    const message =
      status === "Arrived in Ghana"
        ? `Container ${container.containerId} arrived in Ghana. All ${container.itemIds.length} items updated automatically.`
        : `Container ${container.containerId} status updated to: ${status}`;

    return Response.json({
      success: true,
      data: container,
      message,
    });
  } catch (err: unknown) {
    if (err instanceof BusinessError) {
      return badRequestResponse(err.message);
    }
    console.error("[PATCH /containers/[id]/status] Error:", err);
    return serverErrorResponse("Failed to update container status");
  }
}
