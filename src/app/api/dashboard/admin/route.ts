// GET /api/dashboard/admin — admin dashboard stats
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/reports";
import { dashboardApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (isPostgresBackend()) return pg.adminDashboardGet(request);
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const stats = await dashboardApi.getAdminStats();
    // D6: warehouse staff get the operational counts only. Revenue, outstanding amounts and invoice lists are removed
    // server-side (hiding them in the UI is not authorization).
    if (user.role !== "super_admin") {
      return Response.json({
        success: true,
        data: { ...stats, totalRevenue: 0, pendingRevenue: 0, pendingOrders: [], recentOrders: [], ordersThisMonth: 0 },
      });
    }
    return Response.json({ success: true, data: stats });
  } catch {
    return serverErrorResponse("Failed to fetch dashboard stats");
  }
}
