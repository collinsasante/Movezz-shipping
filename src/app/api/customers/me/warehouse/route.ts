// PATCH /api/customers/me/warehouse — DISABLED for every role (Phase 7F, decision D7).
// A customer may edit only their address and notes; warehouse assignment is an administrative operation and no live
// administrative endpoint for it exists yet (in the PostgreSQL layer it is customers.preferred_warehouse_id, writable only by a
// super_admin through updateCustomerAdmin). The route stays so existing clients get a clear 403 instead of a 404.
import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";

export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth(request, []);   // no role is accepted: 401 when anonymous, 403 for everyone else
  return authResult instanceof Response ? authResult : Response.json({ success: false, error: "Forbidden" }, { status: 403 });
}
