// GET  /api/sorting  — items in Sorting stage
// PATCH /api/sorting/[action] — mark found or missing
import { NextRequest } from "next/server";
import { itemsApi, BusinessError } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { z } from "zod";

// GET /api/sorting — get all items in Sorting status
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? undefined;
    const showMissing = searchParams.get("missing") === "true";

    const [sortingItems, missingItems] = await Promise.all([
      itemsApi.list({ status: "Sorting", search }),
      showMissing || searchParams.has("missing")
        ? itemsApi.list({ isMissing: true, search })
        : Promise.resolve([]),
    ]);

    return Response.json({
      success: true,
      data: {
        sorting: sortingItems,
        missing: showMissing ? missingItems : undefined,
        sortingCount: sortingItems.length,
        missingCount: missingItems.length,
      },
    });
  } catch {
    return serverErrorResponse("Failed to fetch sorting items");
  }
}

const SortingActionSchema = z.object({
  itemId: z.string().min(1),
  action: z.enum(["found", "missing"]),
  notes: z.string().optional(),
});

// POST /api/sorting — mark item as found or missing
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = SortingActionSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const { itemId, action, notes } = parsed.data;

    if (action === "found") {
      const item = await itemsApi.markFound(itemId, user.email, user.role);
      return Response.json({
        success: true,
        data: item,
        message: `Item ${item.itemRef} marked as found → Ready for Pickup`,
      });
    } else {
      const item = await itemsApi.markMissing(itemId, user.email, user.role);
      return Response.json({
        success: true,
        data: item,
        message: `Item ${item.itemRef} flagged as missing`,
      });
    }
  } catch (err: unknown) {
    if (err instanceof BusinessError) return badRequestResponse(err.message);
    return serverErrorResponse("Sorting action failed");
  }
}
