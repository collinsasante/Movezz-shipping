// POST /api/containers/[id]/sync-items
// Bulk-syncs all items in a container to the container's current mapped status.
// Uses batch Airtable updates (10 records/call) — much faster than per-item calls.
import { NextRequest } from "next/server";
import { containersApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;
    const { updated, targetStatus } = await containersApi.syncItemStatusesBatch(id);

    if (!targetStatus) {
      return Response.json({
        success: true,
        message: "No status cascade defined for this container status",
        updated: 0,
      });
    }

    return Response.json({
      success: true,
      message: `${updated} item${updated !== 1 ? "s" : ""} synced to "${targetStatus}"`,
      updated,
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/containers/[id]/sync-items]", detail);
    return serverErrorResponse("Failed to sync item statuses");
  }
}
