// POST /api/admin/migrate-shipping-marks
// One-time migration: regenerates shipping marks for all customers
// using the new MOVEZZ-{initials}{last4phone} format.
import { NextRequest } from "next/server";
import { customersApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const customers = await customersApi.list();
    const results: { id: string; name: string; oldMark: string; newMark: string }[] = [];

    for (const customer of customers) {
      try {
        const updated = await customersApi.update(customer.id, { name: customer.name }, user.email);
        results.push({
          id: customer.id,
          name: customer.name,
          oldMark: customer.shippingMark,
          newMark: updated.shippingMark,
        });
      } catch {
        results.push({ id: customer.id, name: customer.name, oldMark: customer.shippingMark, newMark: "ERROR" });
      }
    }

    return Response.json({ success: true, updated: results.length, results });
  } catch {
    return serverErrorResponse("Migration failed");
  }
}
