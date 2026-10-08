// GET /api/dashboard/customer — customer dashboard stats
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/reports";
import { dashboardApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (isPostgresBackend()) return pg.customerDashboardGet(request);
  const authResult = await requireAuth(request, ["customer", "super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { searchParams } = new URL(request.url);
    // Admin can query any customer; customer can only query themselves
    const customerId =
      user.role === "super_admin"
        ? (searchParams.get("customerId") ?? user.customerId)
        : user.customerId;

    if (!customerId) {
      return badRequestResponse("Customer ID is required");
    }

    const stats = await dashboardApi.getCustomerStats(customerId);
    return Response.json({ success: true, data: stats });
  } catch {
    return serverErrorResponse("Failed to fetch customer dashboard stats");
  }
}
