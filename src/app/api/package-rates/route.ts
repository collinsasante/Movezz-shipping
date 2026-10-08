// GET /api/package-rates  — get all package tier rates (all roles; customers see the full rate card - decision Q9)
// PUT /api/package-rates  — save all package tier rates (super_admin ONLY: it drives every price)
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/config";
import { packageRatesApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { PackageRatesSchema } from "@/lib/schemas";

export async function GET(request: NextRequest) {
  if (isPostgresBackend()) return pg.packageRatesGet(request);
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
  if (isPostgresBackend()) return pg.packageRatesPut(request);
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await request.json().catch(() => null);
    const parsed = PackageRatesSchema.safeParse(body);
    if (!parsed.success) {
      return badRequestResponse(parsed.error.errors.map((e) => `${e.path.join(".") || "body"}: ${e.message}`).join(", "));
    }
    await packageRatesApi.saveAll(parsed.data);
    const rates = await packageRatesApi.getAll();
    return Response.json({ success: true, data: rates });
  } catch {
    return serverErrorResponse("Failed to save package rates");
  }
}
