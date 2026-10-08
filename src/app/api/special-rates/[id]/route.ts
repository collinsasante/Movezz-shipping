// PATCH  /api/special-rates/[id]  — update a special rate   (super_admin ONLY)
// DELETE /api/special-rates/[id]  — delete a special rate   (super_admin ONLY)
import { NextRequest } from "next/server";
import { specialRatesApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { SpecialRateSchema } from "@/lib/schemas";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    const parsed = SpecialRateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return badRequestResponse(parsed.error.errors.map((e) => e.message).join(", "));
    const rate = await specialRatesApi.update(id, parsed.data);
    return Response.json({ success: true, data: rate });
  } catch {
    return serverErrorResponse("Failed to update special rate");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    await specialRatesApi.delete(id);
    return Response.json({ success: true });
  } catch {
    return serverErrorResponse("Failed to delete special rate");
  }
}
