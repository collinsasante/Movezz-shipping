// POST /api/orders/[id]/create-invoice — create Keepup invoice for an existing order
// DELETE /api/orders/[id]/create-invoice — cancel Keepup invoice and clear from order
import { NextRequest } from "next/server";
import { ordersApi, customersApi, itemsApi, settingsApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";
import { createKeepupSale, cancelKeepupSale } from "@/lib/keepup";
import { groupItemsForBilling } from "@/lib/cbm";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { itemPriceMap?: Record<string, number> };
    const { itemPriceMap } = body;
    const [order, appSettings] = await Promise.all([
      ordersApi.getById(id),
      settingsApi.get(),
    ]);
    const usdToGhs = appSettings?.usdToGhs && appSettings.usdToGhs > 0 ? appSettings.usdToGhs : 1;
    const discountUsd = order.discount && order.discount > 0 ? order.discount : 0;
    // Invoice amount in GHS — use pre-discount base so we can add a visible discount line item
    const invoiceAmountGhs = Math.round(order.invoiceAmount * usdToGhs * 100) / 100;
    const discountGhs = Math.round(discountUsd * usdToGhs * 100) / 100;
    const netAmountGhs = Math.max(0, Math.round((invoiceAmountGhs - discountGhs) * 100) / 100);

    if (order.status === "Paid") {
      return Response.json(
        { success: false, error: "Cannot create invoice for a paid order" },
        { status: 400 }
      );
    }

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

      // Use client-provided per-item prices if available (from calcItemPrice with customer tier rates),
      // aggregated up to a per-group total so consolidated cartons still get one line item.
      const hasClientPrices = itemPriceMap && validItems.every((item) => itemPriceMap[item.id] != null);

      let groupPrices: number[];
      if (hasClientPrices) {
        // Use client prices but adjust last group so sum matches net total (avoids rounding drift)
        const rawSums = groups.map((g) => g.items.reduce((s, item) => s + itemPriceMap![item.id], 0));
        const rawTotal = rawSums.reduce((s, p) => s + p, 0);
        groupPrices = rawSums.map((p, i) =>
          i < rawSums.length - 1
            ? Math.round(freightTotal * (p / rawTotal) * 100) / 100
            : 0
        );
        let running = groupPrices.reduce((s, p) => s + p, 0);
        groupPrices[groupPrices.length - 1] = Math.round((freightTotal - running) * 100) / 100;
      } else {
        // Fallback: split proportionally by CBM (or equally if no CBM)
        const cbms = groups.map((g) => g.cbm);
        const totalCbm = cbms.reduce((s, c) => s + c, 0);
        const useCbm = totalCbm > 0;
        groupPrices = [];
        let runningSum = 0;
        for (let i = 0; i < groups.length; i++) {
          if (i < groups.length - 1) {
            const proportion = useCbm ? cbms[i] / totalCbm : 1 / groups.length;
            const p = Math.round(freightTotal * proportion * 100) / 100;
            groupPrices.push(p);
            runningSum += p;
          } else {
            groupPrices.push(Math.round((freightTotal - runningSum) * 100) / 100);
          }
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

    return Response.json({
      success: true,
      data: { saleId: keepupResult.saleId, link: keepupResult.link },
      message: "Invoice created in Keepup",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: msg }, { status: 500 });
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
