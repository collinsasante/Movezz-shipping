// GET /api/admin/registrations?status=  — the registration queue (super_admin only; authorization is enforced by the service).
import { NextRequest } from "next/server";
import { getPool } from "@/lib/db/client";
import { listRegistrations } from "@/lib/db/registration";
import { pgActorFromRequest, errorResponse } from "@/lib/pg-auth";
import { limitUser } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  try {
    const actor = await pgActorFromRequest(request);
    if (!actor) return Response.json({ success: false, error: "Authentication required" }, { status: 401 });
    const limited = limitUser(actor.userId!, "registrations", 120);
    if (limited) return limited;
    const status = new URL(request.url).searchParams.get("status") ?? undefined;
    const rows = await listRegistrations(getPool(), actor, { status: status || undefined });
    return Response.json({ success: true, data: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
