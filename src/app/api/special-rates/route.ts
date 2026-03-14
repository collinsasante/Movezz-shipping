// GET  /api/special-rates  — list all special rates
// POST /api/special-rates  — create a special rate
import { NextRequest } from "next/server";
import { specialRatesApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff", "customer"]);
  if (authResult instanceof Response) return authResult;

  try {
    const rates = await specialRatesApi.list();
    return Response.json({ success: true, data: rates });
  } catch {
    return serverErrorResponse("Failed to fetch special rates");
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await request.json();
    if (!body.name?.trim()) return badRequestResponse("Rate name is required");
    const sea = parseFloat(body.sea) || 0;
    const air = parseFloat(body.air) || 0;
    const rate = await specialRatesApi.create({ name: body.name.trim(), sea, air });
    return Response.json({ success: true, data: rate }, { status: 201 });
  } catch {
    return serverErrorResponse("Failed to create special rate");
  }
}
