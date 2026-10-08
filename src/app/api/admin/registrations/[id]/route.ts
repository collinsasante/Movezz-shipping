// GET    /api/admin/registrations/[id]   view one request
// PATCH  /api/admin/registrations/[id]   { action: "approve" } | { action: "reject", reason }
// DELETE /api/admin/registrations/[id]   not allowed: requests are historical records and are never deleted
// All super_admin only; the actor is the verified user, never a body field.
import { NextRequest } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db/client";
import { getRegistration, approveRegistration, rejectRegistration } from "@/lib/db/registration";
import { pgActorFromRequest, errorResponse } from "@/lib/pg-auth";
import { limitUser } from "@/lib/rate-limit";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }).strict(),
  z.object({ action: z.literal("reject"), reason: z.string().max(1000) }).strict(),
]);

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const actor = await pgActorFromRequest(request);
    if (!actor) return Response.json({ success: false, error: "Authentication required" }, { status: 401 });
    const row = await getRegistration(getPool(), actor, (await params).id);
    return row ? Response.json({ success: true, data: row }) : Response.json({ success: false, error: "Not found" }, { status: 404 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const actor = await pgActorFromRequest(request);
    if (!actor) return Response.json({ success: false, error: "Authentication required" }, { status: 401 });
    const limited = limitUser(actor.userId!, "registrations-write", 60);
    if (limited) return limited;
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ success: false, error: "Invalid request" }, { status: 400 });
    const { id } = await params;
    if (parsed.data.action === "approve") {
      await approveRegistration(getPool(), actor, id);
    } else {
      await rejectRegistration(getPool(), actor, id, parsed.data.reason);
    }
    return Response.json({ success: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  return Response.json({ success: false, error: "Registration requests are historical records and cannot be deleted." }, { status: 405 });
}
