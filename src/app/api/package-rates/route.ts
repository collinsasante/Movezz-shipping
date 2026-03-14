// GET /api/package-rates  — get all package tier rates
// PUT /api/package-rates  — save all package tier rates
import { NextRequest } from "next/server";
import { packageRatesApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff", "customer"]);
  if (authResult instanceof Response) return authResult;

  try {
    const rates = await packageRatesApi.getAll();
    return Response.json({ success: true, data: rates });
  } catch {
    return serverErrorResponse("Failed to fetch package rates");
  }
}

export async function PUT(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await request.json();
    await packageRatesApi.saveAll(body);
    const rates = await packageRatesApi.getAll();
    return Response.json({ success: true, data: rates });
  } catch {
    return serverErrorResponse("Failed to save package rates");
  }
}
