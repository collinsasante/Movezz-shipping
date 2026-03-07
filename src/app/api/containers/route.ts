// GET  /api/containers  — list containers
// POST /api/containers  — create container (admin only)
import { NextRequest } from "next/server";
import { containersApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const CreateContainerSchema = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  eta: z.string().max(50).optional(),
  trackingNumber: z.string().min(1, "Container number is required").max(100),
  notes: z.string().max(2000).optional(),
});

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const { searchParams } = new URL(request.url);
    const params = {
      status: searchParams.get("status") as
        | import("@/types").ContainerStatus
        | undefined,
      search: searchParams.get("search") ?? undefined,
    };

    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    const limit = 50;

    const allContainers = await containersApi.list(params);
    const total = allContainers.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const data = allContainers.slice((page - 1) * limit, page * limit);

    return Response.json({ success: true, data, total, totalPages, page });
  } catch (err) {
    console.error("[GET /containers] Error:", err);
    return serverErrorResponse("Failed to fetch containers");
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = CreateContainerSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const container = await containersApi.create(parsed.data, user.email);

    return Response.json(
      {
        success: true,
        data: container,
        message: `Container ${container.containerId} created`,
      },
      { status: 201 }
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[POST /containers] Error:", err);
    return serverErrorResponse(`Failed to create container: ${errMsg}`);
  }
}
