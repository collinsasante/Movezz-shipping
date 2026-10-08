// GET  /api/settings  — get app settings
// PUT  /api/settings  — save app settings (super_admin only)
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/config";
import { settingsApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { z } from "zod";

const SaveSettingsSchema = z.object({
  // Sanity bounds: catches a typo (0.0001, 1200000) that would silently reprice every GHS invoice and payment.
  usdToGhs: z.number().min(0.1, "USD → GHS rate looks too low").max(1000, "USD → GHS rate looks too high"),
  shippingRatePerCbm: z.number().positive("Shipping rate must be positive"),
});

export async function GET(request: NextRequest) {
  if (isPostgresBackend()) return pg.settingsGet(request);
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const settings = await settingsApi.get();
    return Response.json({ success: true, data: settings });
  } catch {
    return serverErrorResponse("Failed to fetch settings");
  }
}

export async function PUT(request: NextRequest) {
  if (isPostgresBackend()) return pg.settingsPut(request);
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await request.json();
    const parsed = SaveSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return badRequestResponse(parsed.error.errors.map((e) => e.message).join(", "));
    }

    await settingsApi.save(parsed.data);
    return Response.json({ success: true, message: "Settings saved" });
  } catch {
    return serverErrorResponse("Failed to save settings");
  }
}
