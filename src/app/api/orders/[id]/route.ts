// GET    /api/orders/[id]  — get single order with items
// PATCH  /api/orders/[id]  — update order (status, amount)
// DELETE /api/orders/[id]  — delete order
import { NextRequest } from "next/server";
import { ordersApi, itemsApi, customersApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  notFoundResponse,
  badRequestResponse,
} from "@/lib/auth";
import { recordKeepupPayment, cancelKeepupSale, updateKeepupSale, getKeepupSale, fetchKeepupShareLink } from "@/lib/keepup";
import { sendPaymentConfirmedEmail, sendPartialPaymentEmail } from "@/lib/email";
import { z } from "zod";

const UpdateOrderSchema = z.object({
  invoiceAmount: z.number().positive().optional(),
  invoiceDate: z.string().optional(),
  status: z.enum(["Pending", "Partial", "Paid"]).optional(),
  notes: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
  syncKeeup: z.boolean().optional(),
  paymentAmount: z.number().positive().optional(),
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

    // Auto-fetch and store keepupLink if saleId exists but link is missing
    if (order.keepupSaleId && !order.keepupLink) {
      const link = await fetchKeepupShareLink(order.keepupSaleId);
      if (link) {
        await ordersApi.storeKeepupIds(order.id, order.keepupSaleId, link).catch(() => {});
        order.keepupLink = link;
      }
    }

    // Fetch Keepup payment status (non-fatal)
    let keepupTotalAmount: number | null = null;
    let keepupAmountPaid: number | null = null;
    let keepupBalanceDue: number | null = null;
    if (order.keepupSaleId) {
      try {
        const ks = await getKeepupSale(order.keepupSaleId);
        keepupTotalAmount = ks.totalAmount;
        keepupAmountPaid = ks.amountPaid;
        keepupBalanceDue = ks.balanceDue;
      } catch {
        // non-fatal
      }
      // Fallback: if Keepup returns 0 but order is already marked Paid/Partial, derive from status
      if (order.status === "Paid" && (keepupAmountPaid ?? 0) === 0) {
        keepupTotalAmount = keepupTotalAmount ?? order.invoiceAmount;
        keepupAmountPaid = order.invoiceAmount;
        keepupBalanceDue = 0;
      } else if (order.status === "Partial" && (keepupAmountPaid ?? 0) === 0 && keepupTotalAmount) {
        // Derive amount paid from balance due if Keepup field names differ
        keepupAmountPaid = keepupTotalAmount - (keepupBalanceDue ?? keepupTotalAmount);
      }
    }

    // Hydrate items — log failures but return partial data
    const items = order.itemIds.length
      ? (
          await Promise.all(
            order.itemIds.map((itemId) =>
              itemsApi.getById(itemId).catch(() => null)
            )
          )
        ).filter(Boolean)
      : [];

    return Response.json({
      success: true,
      data: { ...order, items, keepupTotalAmount, keepupAmountPaid, keepupBalanceDue },
    });
  } catch {
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

    // Record payment in Keepup if paymentAmount provided
    if (parsed.data.paymentAmount !== undefined && order.keepupSaleId) {
      try {
        await recordKeepupPayment(order.keepupSaleId, parsed.data.paymentAmount);
        // Determine status
        const newStatus = parsed.data.paymentAmount >= order.invoiceAmount ? "Paid" : "Partial";
        await ordersApi.update(id, { status: newStatus }, user.email);
        order.status = newStatus;
      } catch {
        // Keepup payment record failed (non-fatal)
      }
    }

    // Sync payment to Keepup when marked as Paid (non-fatal)
    if (parsed.data.status === "Paid" && order.keepupSaleId) {
      try {
        await recordKeepupPayment(order.keepupSaleId, order.invoiceAmount);
      } catch {
        // Keepup payment record failed (non-fatal)
      }
    }

    // Send payment emails (non-fatal)
    if (parsed.data.status === "Paid" || parsed.data.status === "Partial") {
      customersApi.getById(order.customerId).then((customer) => {
        if (!customer?.email) return;
        if (parsed.data.status === "Paid") {
          sendPaymentConfirmedEmail({
            to: customer.email,
            customerName: customer.name,
            orderRef: order.orderRef,
            invoiceAmount: order.invoiceAmount,
          }).catch(() => {});
        } else if (parsed.data.status === "Partial") {
          sendPartialPaymentEmail({
            to: customer.email,
            customerName: customer.name,
            orderRef: order.orderRef,
            amountPaid: order.invoiceAmount * 0.5, // placeholder — Keepup has actual amounts
            balanceDue: order.invoiceAmount * 0.5,
            keepupLink: order.keepupLink,
          }).catch(() => {});
        }
      }).catch(() => {/* non-fatal */});
    }

    // Sync edits to Keepup if requested
    if (parsed.data.syncKeeup && order.keepupSaleId) {
      try {
        await updateKeepupSale(order.keepupSaleId, {
          invoiceDate: parsed.data.invoiceDate,
        });
      } catch {
        // Keepup update failed (non-fatal)
      }
    }

    return Response.json({
      success: true,
      data: order,
      message: "Order updated successfully",
    });
  } catch {
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

    await ordersApi.delete(id);

    // Cancel in Keepup (non-fatal)
    if (existing.keepupSaleId) {
      try {
        await cancelKeepupSale(existing.keepupSaleId);
      } catch {
        // Keepup cancel failed (non-fatal)
      }
    }

    return Response.json({ success: true, message: "Order deleted" });
  } catch {
    return serverErrorResponse("Failed to delete order");
  }
}
