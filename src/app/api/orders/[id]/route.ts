// GET    /api/orders/[id]  — get single order with items
// PATCH  /api/orders/[id]  — update order (status, amount)
// DELETE /api/orders/[id]  — delete order
import { NextRequest } from "next/server";
import { ordersApi, itemsApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  notFoundResponse,
  badRequestResponse,
} from "@/lib/auth";
import { recordKeepupPayment, cancelKeepupSale } from "@/lib/keepup";
import { z } from "zod";

const UpdateOrderSchema = z.object({
  invoiceAmount: z.number().positive().optional(),
  status: z.enum(["Pending", "Paid"]).optional(),
  notes: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
    "customer",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    const order = await ordersApi.getById(id);

    if (user.role === "customer" && order.customerId !== user.customerId) {
      return Response.json(
        { success: false, error: "Access denied" },
        { status: 403 }
      );
    }

    // Hydrate items — log failures but return partial data
    const items = order.itemIds.length
      ? (
          await Promise.all(
            order.itemIds.map((itemId) =>
              itemsApi.getById(itemId).catch((err) => {
                console.error(`[orders/${id}] Failed to fetch item ${itemId}:`, err);
                return null;
              })
            )
          )
        ).filter(Boolean)
      : [];

    return Response.json({
      success: true,
      data: { ...order, items },
    });
  } catch (err) {
    console.error("[GET /orders/[id]] Error:", err);
    return notFoundResponse("Order not found");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = UpdateOrderSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const order = await ordersApi.update(id, parsed.data, user.email);

    // Sync payment to Keepup when marked as Paid (non-fatal)
    if (parsed.data.status === "Paid" && order.keepupSaleId) {
      try {
        await recordKeepupPayment(order.keepupSaleId, order.invoiceAmount);
      } catch (keepupErr) {
        console.error("[PATCH /orders] Keepup payment record failed (non-fatal):", keepupErr);
      }
    }

    return Response.json({
      success: true,
      data: order,
      message: "Order updated successfully",
    });
  } catch (err) {
    console.error("[PATCH /orders/[id]] Error:", err);
    return serverErrorResponse("Failed to update order");
  }
}

// DELETE /api/orders/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    const existing = await ordersApi.getById(id);

    await ordersApi.delete(id, user.email);

    // Cancel in Keepup (non-fatal)
    if (existing.keepupSaleId) {
      try {
        await cancelKeepupSale(existing.keepupSaleId);
      } catch (keepupErr) {
        console.error("[DELETE /orders] Keepup cancel failed (non-fatal):", keepupErr);
      }
    }

    return Response.json({ success: true, message: "Order deleted" });
  } catch (err) {
    console.error("[DELETE /orders/[id]] Error:", err);
    return serverErrorResponse("Failed to delete order");
  }
}
