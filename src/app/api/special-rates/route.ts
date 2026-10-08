// GET  /api/special-rates  — list all special rates
// POST /api/special-rates  — create a special rate (super_admin ONLY: it changes what customers are charged)
import { NextRequest } from "next/server";
import { specialRatesApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { SpecialRateSchema } from "@/lib/schemas";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const rates = await specialRatesApi.list();
    return Response.json({ success: true, data: rates });
  } catch {
    return serverErrorResponse("Failed to fetch special rates");
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const parsed = SpecialRateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return badRequestResponse(parsed.error.errors.map((e) => e.message).join(", "));
    const rate = await specialRatesApi.create(parsed.data);
    return Response.json({ success: true, data: rate }, { status: 201 });
  } catch {
    return serverErrorResponse("Failed to create special rate");
  }
}
