// GET  /api/warehouses  — list warehouses (public for customers)
// POST /api/warehouses  — create warehouse (admin only)
import { NextRequest } from "next/server";
import { warehousesApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  // Customers can also access this to see warehouse shipping addresses
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff", "customer"]);
  if (authResult instanceof Response) return authResult;

  try {
    const warehouses = await warehousesApi.listActive();
    return Response.json({ success: true, data: warehouses });
  } catch (err) {
    console.error("[GET /warehouses]", err);
    return serverErrorResponse("Failed to fetch warehouses");
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await request.json();
    if (!body.name?.trim() || !body.address?.trim()) {
      return badRequestResponse("Name and address are required");
    }
    const warehouse = await warehousesApi.create({
      name: body.name.trim(),
      address: body.address.trim(),
      country: body.country?.trim() || undefined,
      phone: body.phone?.trim() || undefined,
    });
    return Response.json({ success: true, data: warehouse }, { status: 201 });
  } catch (err) {
    console.error("[POST /warehouses]", err);
    return serverErrorResponse("Failed to create warehouse");
  }
}
