// POST /api/orders/keepup-sync — sync payment status from Keepup for all pending orders
import { NextRequest } from "next/server";
import { ordersApi } from "@/lib/airtable";
import { getKeepupSale } from "@/lib/keepup";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    // Fetch all orders that are Pending or Partial and have a Keepup sale ID
    const allOrders = await ordersApi.list();
    const toSync = allOrders.filter(
      (o) => o.keepupSaleId && (o.status === "Pending" || o.status === "Partial")
    );

    let updated = 0;
    let errors = 0;

    await Promise.allSettled(
      toSync.map(async (order) => {
        try {
          const saleStatus = await getKeepupSale(order.keepupSaleId!);
          let newStatus: "Pending" | "Partial" | "Paid" | null = null;

          if (saleStatus.balanceDue <= 0) {
            newStatus = "Paid";
          } else if (saleStatus.amountPaid > 0) {
            newStatus = "Partial";
          }

          if (newStatus && newStatus !== order.status) {
            await ordersApi.update(order.id, { status: newStatus }, user.email);
            updated++;
          }
        } catch {
          errors++;
        }
      })
    );

    return Response.json({ success: true, synced: toSync.length, updated, errors });
  } catch {
    return serverErrorResponse("Failed to sync Keepup statuses");
  }
}
