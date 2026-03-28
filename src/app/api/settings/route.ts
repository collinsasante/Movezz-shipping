// GET  /api/settings  — get app settings
// PUT  /api/settings  — save app settings (super_admin only)
import { NextRequest } from "next/server";
import { settingsApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { z } from "zod";

const SaveSettingsSchema = z.object({
  usdToGhs: z.number().positive("USD → GHS rate must be positive"),
  shippingRatePerCbm: z.number().positive("Shipping rate must be positive"),
});

export async function GET(request: NextRequest) {
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
