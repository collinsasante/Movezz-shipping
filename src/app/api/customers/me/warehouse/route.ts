// PATCH /api/customers/me/warehouse — save preferred warehouse for the logged-in customer
import { NextRequest } from "next/server";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { customersApi } from "@/lib/airtable";

export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth(request, ["customer"]);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await request.json();
    const { warehouseId } = body;
    if (!warehouseId) return badRequestResponse("warehouseId is required");

    const customerId = authResult.customerId;
    if (!customerId) return badRequestResponse("No customer record linked to this account");

    await customersApi.setPreferredWarehouse(customerId, warehouseId);
    return Response.json({ success: true });
  } catch {
    return serverErrorResponse("Failed to save warehouse preference");
  }
}
