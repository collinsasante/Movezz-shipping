// POST /api/orders/[id]/create-invoice — create the (single) Keepup invoice for an order.
//   Idempotent: if the order already has a Keepup sale this returns it and creates nothing, unless the body
//   says { regenerate: true } (replace the sale: the new one is stored first, then the old one cancelled).
//   Concurrent calls for one order are serialised in-process; see lib/locks.ts for what that does not cover.
// DELETE /api/orders/[id]/create-invoice — cancel Keepup invoice and clear from order
import { NextRequest } from "next/server";
import { ordersApi, customersApi, itemsApi, settingsApi } from "@/lib/airtable";
import { limitUser } from "@/lib/rate-limit";
import { requireAuth } from "@/lib/auth";
import { createKeepupSale, cancelKeepupSale } from "@/lib/keepup";
import { groupItemsForBilling } from "@/lib/cbm";
import { billingFor } from "@/lib/pricing";
import { netInvoiceGhs, round2 } from "@/lib/money";
import { withLock } from "@/lib/locks";
import { sendInvoiceCreatedEmail } from "@/lib/email";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const limited = limitUser(authResult.user.id, "create-invoice", 10);
  if (limited) return limited;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { regenerate?: boolean };
    // Only the operator's intent is taken from the body. Prices, the exchange rate and the split of the
    // total across lines are all derived server-side (a client-supplied price map is ignored).
    return await withLock(`invoice:${id}`, () => createInvoice(id, body.regenerate === true));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
}

async function createInvoice(id: string, regenerate: boolean): Promise<Response> {
  {
    const order = await ordersApi.getById(id);

    if (order.status === "Paid") {
      return Response.json(
        { success: false, error: "Cannot create invoice for a paid order" },
        { status: 400 }
      );
    }

    // Idempotency: one authoritative sale per order.
    if (order.keepupSaleId && !regenerate) {
      return Response.json({
        success: true,
        data: { saleId: order.keepupSaleId, link: order.keepupLink, existing: true },
        message: "Invoice already exists in Keepup",
      });
    }

    // Replacing a sale that already holds payments would cancel the record of those payments.
    if (order.keepupSaleId && (order.status === "Partial" || (order.amountPaid ?? 0) > 0)) {
      return Response.json(
        { success: false, error: "This invoice has payments recorded against it and cannot be regenerated" },
        { status: 409 }
      );
    }

    // The Keepup invoice is in GHS. Without a configured rate we refuse rather than guess (never default to 1).
    const usdToGhs = await settingsApi.getRate();
    if (usdToGhs === null) {
      return Response.json(
        { success: false, error: "The USD to GHS exchange rate is not configured. Set it in Settings before creating an invoice." },
        { status: 409 }
      );
    }
    // Discount is subtracted in USD before the single conversion, so nothing is converted twice.
    const netAmountGhs = netInvoiceGhs(order.invoiceAmount, order.discount, usdToGhs);

    const [customer, items] = await Promise.all([
      customersApi.getById(order.customerId).catch(() => null),
      Promise.all(order.itemIds.map((itemId) => itemsApi.getById(itemId).catch(() => null))),
    ]);

    const validItems = items.filter((item): item is NonNullable<typeof item> => item != null);

    let lineItems: { item_name: string; quantity: number; price: number; item_type: string }[];

    // Freight line items split against the net amount (after discount)
    const freightTotal = netAmountGhs;

    if (validItems.length === 0) {
      lineItems = [{
        item_name: `Freight - ${order.orderRef}`,
        quantity: 1,
        price: freightTotal,
        item_type: "product",
      }];
    } else {
      // Items sharing a carton number are consolidated into one billing group,
      // priced by the carton's own dimensions instead of each item's individually.
      const groups = groupItemsForBilling(validItems);

      // Lines are weighted by the stored item prices (special price for special-rate items, tier price
      // otherwise); if nothing carries a price they are weighted by CBM, then equally. The weights only
      // distribute the total - they never change it.
      const weights = groups.map((g) => g.items.reduce((sum, item) => sum + billingFor(item).priceUsd, 0));
      const weightTotal = weights.reduce((sum, w) => sum + w, 0);
      const cbms = groups.map((g) => g.cbm);
      const totalCbm = cbms.reduce((sum, c) => sum + c, 0);
      const shares = weightTotal > 0
        ? weights.map((x) => x / weightTotal)
        : totalCbm > 0
          ? cbms.map((c) => c / totalCbm)
          : groups.map(() => 1 / groups.length);
      const groupPrices: number[] = [];
      let runningSum = 0;
      for (let i = 0; i < groups.length; i++) {
        if (i < groups.length - 1) {
          const price = round2(freightTotal * shares[i]);
          groupPrices.push(price);
          runningSum += price;
        } else {
          groupPrices.push(round2(freightTotal - runningSum));
        }
      }

      lineItems = groups.map((group, i) => {
        const cbmStr = group.cbm > 0 ? ` [CBM: ${group.cbm.toFixed(4)}m3]` : "";
        let name: string;
        if (group.isCarton) {
          const refs = group.items.map((it) => it.trackingNumber || it.itemRef).join(", ");
          name = `Carton ${group.cartonNumber} (${group.items.length} pkgs: ${refs})${cbmStr}`;
        } else {
          const item = group.items[0];
          const trk = item.trackingNumber ? ` [TRK: ${item.trackingNumber}]` : "";
          name = (item.description || item.itemRef) + trk + cbmStr;
        }
        return {
          item_name: name.replace(/[^\x20-\x7E]/g, "").slice(0, 200),
          quantity: 1,
          price: groupPrices[i],
          item_type: "product",
        };
      });
    }

    // Discount is already baked into freightTotal (= netAmountGhs), so line items
    // naturally sum to the after-discount amount — no separate discount line needed.
    // Keepup does not support negative-price line items.

    const oldSaleId = order.keepupSaleId ?? null;

    const keepupResult = await createKeepupSale({
      customerName: customer?.name,
      customerEmail: customer?.email,
      customerPhone: customer?.phone,
      invoiceDate: order.invoiceDate,
      items: lineItems,
    });

    // Store new IDs first, then cancel old — so a failed cancel never leaves the order invoiceless
    await ordersApi.storeKeepupIds(order.id, keepupResult.saleId, keepupResult.link);
    if (oldSaleId) {
      await cancelKeepupSale(oldSaleId).catch(() => {});
    }

    // The customer is told about a NEW invoice once, with the link of the sale that actually exists and the
    // amount they will pay (GHS). Re-generating an existing invoice does not email again.
    if (!oldSaleId && customer?.email) {
      sendInvoiceCreatedEmail({
        to: customer.email,
        customerName: customer.name,
        orderRef: order.orderRef,
        invoiceAmount: netAmountGhs,
        currency: "GHS",
        invoiceDate: order.invoiceDate,
        itemCount: order.itemIds.length,
        keepupLink: keepupResult.link,
        notes: order.notes,
      }).catch(() => {});
    }

    return Response.json({
      success: true,
      data: { saleId: keepupResult.saleId, link: keepupResult.link },
      message: "Invoice created in Keepup",
    });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;
    const order = await ordersApi.getById(id);

    if (!order.keepupSaleId) {
      return Response.json({ success: false, error: "No Keepup invoice to cancel" }, { status: 400 });
    }

    await cancelKeepupSale(order.keepupSaleId);
    await ordersApi.clearKeepupIds(order.id);

    return Response.json({ success: true, message: "Invoice cancelled" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
}
