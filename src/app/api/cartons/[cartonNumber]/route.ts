// PATCH  /api/cartons/[cartonNumber] — edit carton dimensions / add / remove items
// DELETE /api/cartons/[cartonNumber] — dissolve a carton
import { NextRequest } from "next/server";
import { cartonsApi, BusinessError } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const UpdateCartonSchema = z.object({
  length: z.number().positive().max(10000).optional(),
  width: z.number().positive().max(10000).optional(),
  height: z.number().positive().max(10000).optional(),
  weight: z.number().positive().max(10000).optional(),
  dimensionUnit: z.enum(["cm", "inches"]).optional(),
  addItemIds: z.array(z.string().min(1)).optional(),
  removeItemIds: z.array(z.string().min(1)).optional(),
});

// PATCH /api/cartons/[cartonNumber]
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ cartonNumber: string }> }
) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const { cartonNumber } = await params;
    const body = await request.json();
    const parsed = UpdateCartonSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const carton = await cartonsApi.update(cartonNumber, parsed.data);

    return Response.json({
      success: true,
      data: carton,
      message: `Carton ${carton.cartonNumber} updated`,
    });
  } catch (err) {
    if (err instanceof BusinessError) return badRequestResponse(err.message);
    return serverErrorResponse("Failed to update carton");
  }
}

// DELETE /api/cartons/[cartonNumber]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ cartonNumber: string }> }
) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const { cartonNumber } = await params;
    await cartonsApi.dissolve(cartonNumber);
    return Response.json({ success: true, message: "Carton dissolved" });
  } catch (err) {
    if (err instanceof BusinessError) return badRequestResponse(err.message);
    return serverErrorResponse("Failed to dissolve carton");
  }
}
