// GET  /api/items  — list items
// POST /api/items  — create item (warehouse staff / admin)
import { NextRequest } from "next/server";
import { itemsApi, containersApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const CreateItemSchema = z.object({
  weight: z.number().positive("Weight must be positive").max(10000).optional(),
  shippingType: z.enum(["air", "sea"]).optional(),
  length: z.number().positive().max(10000).optional(),
  width: z.number().positive().max(10000).optional(),
  height: z.number().positive().max(10000).optional(),
  dimensionUnit: z.enum(["cm", "inches"]).default("cm"),
  description: z.string().max(1000).optional().default(""),
  dateReceived: z.string().max(50),
  trackingNumber: z.string().max(100).optional(),
  customerId: z.string().min(1, "Customer ID is required").max(50),
  quantity: z.number().int().positive().max(10000).optional(),
  notes: z.string().max(2000).optional(),
  photoUrls: z.array(z.string().url().max(500)).max(20).optional(),
  estPrice: z.number().min(0).max(500_000).optional(),
  estShippingPrice: z.number().min(0).max(500_000).optional(),
  pkgEstShipping: z.number().min(0).max(500_000).optional(),
  pkgShippingRate: z.number().min(0).max(500_000).optional(),
  specialShippingRate: z.number().min(0).max(500_000).optional(),
  isSpecialItem: z.boolean().optional(),
  specialRateName: z.string().max(100).optional(),
});

// GET /api/items
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
    "customer",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { searchParams } = new URL(request.url);

    const params = {
      status: searchParams.get("status") as
        | import("@/types").ItemStatus
        | undefined,
      customerId: searchParams.get("customerId") ?? undefined,
      containerId: searchParams.get("containerId") ?? undefined,
      orderId: searchParams.get("orderId") ?? undefined,
      isMissing: searchParams.has("isMissing")
        ? searchParams.get("isMissing") === "true"
        : undefined,
      search: searchParams.get("search") ?? undefined,
    };

    // Customers can only see their own items
    if (user.role === "customer") {
      params.customerId = user.customerId;
    }

    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    // When fetching all items for a specific customer (e.g. new invoice flow),
    // skip pagination so uninvoiced items aren't cut off by the 50-item page limit.
    const requestedLimit = parseInt(searchParams.get("limit") ?? "0");
    const limit = requestedLimit > 0 ? Math.min(requestedLimit, 500) : 50;

    const allItems = await itemsApi.list(params);

    // Attach container ETA to items
    const containerIds = [...new Set(allItems.map((i) => i.containerId).filter(Boolean) as string[])];
    if (containerIds.length > 0) {
      const containers = await containersApi.getMany(containerIds);
      const etaMap = new Map(containers.map((c) => [c.id, c.eta] as [string, string | undefined]));
      for (const item of allItems) {
        if (item.containerId) item.containerEta = etaMap.get(item.containerId);
      }
    }

    const total = allItems.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const data = allItems.slice((page - 1) * limit, page * limit);

    return Response.json({ success: true, data, total, totalPages, page });
  } catch {
    return serverErrorResponse("Failed to fetch items");
  }
}

// POST /api/items
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = CreateItemSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const item = await itemsApi.create(parsed.data, user.email);

    return Response.json(
      {
        success: true,
        data: item,
        message: `Item ${item.itemRef} received and assigned to customer`,
      },
      { status: 201 }
    );
  } catch {
    return serverErrorResponse("Failed to create item");
  }
}
