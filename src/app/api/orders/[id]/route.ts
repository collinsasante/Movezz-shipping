// GET    /api/orders/[id]  — get single order with items
// PATCH  /api/orders/[id]  — update order (status, amount)
// DELETE /api/orders/[id]  — delete order
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/billing";
import { ordersApi, itemsApi, customersApi, settingsApi } from "@/lib/airtable";
import { netInvoiceGhs, round2, isSettled } from "@/lib/money";
import { withLock } from "@/lib/locks";
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
  discount: z.number().min(0).optional(),
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
  if (isPostgresBackend()) return pg.orderGet(request, { params });
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

    // Someone else's order and a non-existent order are indistinguishable (404).
    if (user.role === "customer" && order.customerId !== user.customerId) {
      return notFoundResponse("Order not found");
    }

    // Auto-fetch and store keepupLink if saleId exists but link is missing
    if (order.keepupSaleId && !order.keepupLink) {
      const link = await fetchKeepupShareLink(order.keepupSaleId);
      if (link) {
        await ordersApi.storeKeepupIds(order.id, order.keepupSaleId, link).catch(() => {});
        order.keepupLink = link;
      }
    }

    // Keepup payment status (non-fatal). Keepup amounts are GHS. When Keepup is unavailable we say so
    // (null) rather than substituting the USD invoice amount into a GHS field.
    const rate = await settingsApi.getRate().catch(() => null);
    const invoiceTotalGhs = rate === null ? null : netInvoiceGhs(order.invoiceAmount, order.discount, rate);
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
        // Keepup unavailable: fall back to the GHS payments recorded on the order itself.
        keepupAmountPaid = order.amountPaid ?? null;
        keepupBalanceDue = order.balanceDue ?? null;
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
      data: { ...order, items, invoiceTotalGhs, keepupTotalAmount, keepupAmountPaid, keepupBalanceDue },
    });
  } catch {
    return notFoundResponse("Order not found");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (isPostgresBackend()) return pg.orderPatch(request, { params });
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

    return await withLock(`order:${id}`, async () => {
    const existing = await ordersApi.getById(id);

    // A discount can never exceed the invoice it discounts.
    const effectiveInvoice = parsed.data.invoiceAmount ?? existing.invoiceAmount;
    const effectiveDiscount = parsed.data.discount ?? existing.discount ?? 0;
    if (effectiveDiscount > effectiveInvoice) {
      return badRequestResponse("The discount cannot be larger than the invoice amount");
    }

    // Money movement is in GHS. Without a configured rate we cannot compare a GHS payment with a USD
    // invoice, so refuse before changing anything (never default the rate to 1).
    const movesMoney = parsed.data.paymentAmount !== undefined || (parsed.data.status === "Paid" && existing.status !== "Paid");
    let rate: number | null = null;
    if (movesMoney) {
      rate = await settingsApi.getRate();
      if (rate === null && (parsed.data.paymentAmount !== undefined || existing.keepupSaleId)) {
        return Response.json(
          { success: false, error: "The USD to GHS exchange rate is not configured. Set it in Settings before recording payments." },
          { status: 409 }
        );
      }
    }
    const totalGhs = rate === null ? null : netInvoiceGhs(effectiveInvoice, effectiveDiscount, rate);

    // Payments are GHS amounts. Reject an overpayment instead of silently marking the order Paid.
    if (parsed.data.paymentAmount !== undefined && totalGhs !== null) {
      const balanceGhs = Math.max(0, round2(totalGhs - (existing.amountPaid ?? 0)));
      if (parsed.data.paymentAmount > balanceGhs + 0.005) {
        return badRequestResponse(`Payment exceeds the balance due (GHS ${balanceGhs.toFixed(2)})`);
      }
    }

    const order = await ordersApi.update(id, parsed.data, user.email);
    const warnings: string[] = [];
    let paymentRecordedGhs: number | null = null;

    if (parsed.data.paymentAmount !== undefined && totalGhs !== null) {
      const newPaid = round2((existing.amountPaid ?? 0) + parsed.data.paymentAmount);
      const newBalance = Math.max(0, round2(totalGhs - newPaid));
      const newStatus = isSettled(newPaid, totalGhs) ? "Paid" : "Partial";
      await ordersApi.update(id, { status: newStatus, amountPaid: newPaid, balanceDue: newBalance }, user.email);
      order.status = newStatus;
      order.amountPaid = newPaid;
      order.balanceDue = newBalance;
      paymentRecordedGhs = parsed.data.paymentAmount;
      if (order.keepupSaleId) {
        try { await recordKeepupPayment(order.keepupSaleId, parsed.data.paymentAmount); }
        catch { warnings.push("The payment was saved but could not be recorded in Keepup; record it there manually."); }
      }
    } else if (parsed.data.status === "Paid" && existing.status !== "Paid" && totalGhs !== null) {
      // "Mark Paid": settle whatever is still outstanding, in GHS.
      const outstanding = Math.max(0, round2(totalGhs - (existing.amountPaid ?? 0)));
      await ordersApi.update(id, { amountPaid: totalGhs, balanceDue: 0 }, user.email);
      order.amountPaid = totalGhs;
      order.balanceDue = 0;
      paymentRecordedGhs = outstanding;
      if (order.keepupSaleId && outstanding > 0) {
        try { await recordKeepupPayment(order.keepupSaleId, outstanding); }
        catch { warnings.push("The order was marked Paid but the payment could not be recorded in Keepup; record it there manually."); }
      }
    }

    // Payment emails follow the order's EFFECTIVE status and carry the real GHS amounts.
    const paymentRequested = paymentRecordedGhs !== null || parsed.data.status === "Paid" || parsed.data.status === "Partial";
    if (paymentRequested && (order.status === "Paid" || order.status === "Partial")) {
      customersApi.getById(order.customerId).then((customer) => {
        if (!customer?.email) return;
        if (order.status === "Paid") {
          sendPaymentConfirmedEmail({
            to: customer.email,
            customerName: customer.name,
            orderRef: order.orderRef,
            invoiceAmount: totalGhs ?? order.invoiceAmount,
            currency: totalGhs !== null ? "GHS" : "USD",
          }).catch(() => {});
        } else if (order.amountPaid !== undefined && order.balanceDue !== undefined) {
          // Only sent when the real GHS figures are known - never an invented 50/50 split.
          sendPartialPaymentEmail({
            to: customer.email,
            customerName: customer.name,
            orderRef: order.orderRef,
            amountPaid: order.amountPaid,
            balanceDue: order.balanceDue,
            currency: "GHS",
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
      ...(warnings.length ? { warnings } : {}),
    });
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
  if (isPostgresBackend()) return pg.orderDelete(request, { params });
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
