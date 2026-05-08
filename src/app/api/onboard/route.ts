// POST /api/onboard — public endpoint, no auth required
// Saves a customer self-registration to the PendingRegistrations table
import { NextRequest } from "next/server";
import { pendingRegistrationsApi } from "@/lib/airtable";
import { checkRateLimit, rateLimitedResponse, getClientIp } from "@/lib/rate-limit";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(2).max(200),
  phone: z.string().min(7).max(30),
  phone2: z.string().max(30).optional(),
  email: z.string().email().max(254),
  existingMark: z.string().max(100).optional().default(""),
  location: z.string().min(2).max(500),
  notes: z.string().max(1000).optional(),
});

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`onboard:${ip}`, 5, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  try {
    const body = await request.json();
    const parsed = Schema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { success: false, error: parsed.error.errors.map((e) => e.message).join(", ") },
        { status: 400 }
      );
    }

    const reg = await pendingRegistrationsApi.create(parsed.data);
    return Response.json({ success: true, data: { id: reg.id } }, { status: 201 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/onboard]", detail);
    return Response.json({ success: false, error: "Failed to save registration. Please try again.", detail }, { status: 500 });
  }
}
