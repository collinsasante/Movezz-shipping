// POST /api/onboard — PUBLIC registration REQUEST (Phase 7G, D9).
// It creates a `pending` registration request in PostgreSQL and nothing else: no Firebase account, no customer, no user, no password,
// no role. A super_admin reviews it; after approval the applicant activates their own login (POST /api/auth/activate).
// The response is identical whether the request was stored, ignored because the person already has an account, or ignored because
// an identical request is open - the endpoint cannot be used to discover who is registered.
import { NextRequest } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db/client";
import { submitRegistration, clientKeyFor } from "@/lib/db/registration";
import { errorResponse } from "@/lib/pg-auth";
import { checkRateLimit, rateLimitedResponse, getClientIp, checkBodySize } from "@/lib/rate-limit";

// Explicit allow-list. `.strict()` REJECTS role, status, customerId, authUid, isActive, actor ... instead of silently dropping them.
const Schema = z.object({
  name: z.string().trim().min(2).max(200),
  phone: z.string().trim().min(7).max(30),
  phone2: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().max(254),
  existingMark: z.string().trim().max(100).optional().nullable(),
  location: z.string().trim().min(2).max(500),
  notes: z.string().trim().max(1000).optional().nullable(),
}).strict();

const RECEIVED = { success: true, message: "Your registration request has been received." };

export async function POST(request: NextRequest) {
  const sizeErr = checkBodySize(request, 16_384);
  if (sizeErr) return sizeErr;
  const ip = getClientIp(request);
  // first line of defence (per server instance); the database enforces the real, cross-instance limits
  if (!checkRateLimit(`onboard:${ip}`, 5, 60 * 60_000)) return rateLimitedResponse(3600);

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ success: false, error: "Invalid request" }, { status: 400 }); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return Response.json({ success: false, error: "Please check the form and try again." }, { status: 400 });
  // second per-source limit on the normalized e-mail, so rotating IPs does not help
  if (!checkRateLimit(`onboard-email:${parsed.data.email.toLowerCase()}`, 3, 24 * 60 * 60_000)) return rateLimitedResponse(3600);

  try {
    await submitRegistration(getPool(), parsed.data, clientKeyFor(ip));
    return Response.json(RECEIVED, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
