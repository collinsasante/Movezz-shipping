// GET  /api/cartons?customerId=  — list cartons (optionally scoped to a customer)
// POST /api/cartons              — repack items into a new carton
import { NextRequest } from "next/server";
import { cartonsApi, BusinessError } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

// GET /api/cartons
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get("customerId") ?? undefined;
    const cartons = await cartonsApi.list(customerId);
    return Response.json({ success: true, data: cartons });
  } catch {
    return serverErrorResponse("Failed to fetch cartons");
  }
}

const CreateCartonSchema = z.object({
  customerId: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1, "Select at least one item"),
  length: z.number().positive().max(10000),
  width: z.number().positive().max(10000),
  height: z.number().positive().max(10000),
  weight: z.number().positive().max(10000).optional(),
  dimensionUnit: z.enum(["cm", "inches"]).default("cm"),
});

// POST /api/cartons
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await request.json();
    const parsed = CreateCartonSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const carton = await cartonsApi.create(parsed.data);

    return Response.json(
      {
        success: true,
        data: carton,
        message: `Carton ${carton.cartonNumber} created from ${carton.items.length} item(s)`,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof BusinessError) return badRequestResponse(err.message);
    return serverErrorResponse("Failed to create carton");
  }
}
