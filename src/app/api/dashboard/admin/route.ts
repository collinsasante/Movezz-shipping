// GET /api/dashboard/admin — admin dashboard stats
import { NextRequest } from "next/server";
import { dashboardApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;

  try {
    const stats = await dashboardApi.getAdminStats();
    return Response.json({ success: true, data: stats });
  } catch {
    return serverErrorResponse("Failed to fetch dashboard stats");
  }
}
