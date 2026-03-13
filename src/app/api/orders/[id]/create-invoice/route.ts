// POST /api/orders/[id]/create-invoice — create Keepup invoice for an existing order
// DELETE /api/orders/[id]/create-invoice — cancel Keepup invoice and clear from order
import { NextRequest } from "next/server";
import { ordersApi, customersApi, itemsApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";
import { createKeepupSale, cancelKeepupSale } from "@/lib/keepup";

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
    const order = await ordersApi.getById(id);

    // If invoice already exists, cancel it first then recreate (update flow)
    if (order.keepupSaleId) {
      await cancelKeepupSale(order.keepupSaleId).catch(() => {});
      await ordersApi.clearKeepupIds(order.id);
    }

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

    const validItems = items.filter(Boolean);

    function getItemCbm(item: NonNullable<typeof validItems[0]>): number {
      if (!item!.length || !item!.width || !item!.height) return 0;
      const factor = item!.dimensionUnit === "inches" ? 16.387064 : 1;
      const qty = item!.quantity ?? 1;
      return (item!.length * item!.width * item!.height * factor * qty) / 1_000_000;
    }

    let lineItems: { item_name: string; quantity: number; price: number; item_type: string }[];

    if (validItems.length === 0) {
      lineItems = [{
        item_name: `Freight - ${order.orderRef}`,
        quantity: 1,
        price: Math.round(order.invoiceAmount * 100) / 100,
        item_type: "product",
      }];
    } else {
      // Use client-provided per-item prices if available (from calcItemPrice with customer tier rates)
      const hasClientPrices = itemPriceMap && validItems.every((item) => itemPriceMap[item!.id] != null);

      let prices: number[];
      if (hasClientPrices) {
        // Use client prices but adjust last item so sum matches invoice total (avoids rounding drift)
        const rawPrices = validItems.map((item) => itemPriceMap![item!.id]);
        const rawSum = rawPrices.reduce((s, p) => s + p, 0);
        // Scale prices proportionally to match invoice amount
        prices = rawPrices.map((p, i) =>
          i < rawPrices.length - 1
            ? Math.round(order.invoiceAmount * (p / rawSum) * 100) / 100
            : 0
        );
        let running = prices.reduce((s, p) => s + p, 0);
        prices[prices.length - 1] = Math.round((order.invoiceAmount - running) * 100) / 100;
      } else {
        // Fallback: split proportionally by CBM (or equally if no CBM)
        const cbms = validItems.map((item) => getItemCbm(item!));
        const totalCbm = cbms.reduce((s, c) => s + c, 0);
        const useCbm = totalCbm > 0;
        prices = [];
        let runningSum = 0;
        for (let i = 0; i < validItems.length; i++) {
          if (i < validItems.length - 1) {
            const proportion = useCbm ? cbms[i] / totalCbm : 1 / validItems.length;
            const p = Math.round(order.invoiceAmount * proportion * 100) / 100;
            prices.push(p);
            runningSum += p;
          } else {
            prices.push(Math.round((order.invoiceAmount - runningSum) * 100) / 100);
          }
        }
      }

      lineItems = validItems.map((item, i) => {
        const trk = item!.trackingNumber ? ` [TRK: ${item!.trackingNumber}]` : "";
        const cbm = getItemCbm(item!);
        const cbmStr = cbm > 0 ? ` [CBM: ${cbm.toFixed(4)}m3]` : "";
        const name = (item!.description || item!.itemRef) + trk + cbmStr;
        return {
          item_name: name.replace(/[^\x20-\x7E]/g, "").slice(0, 200),
          quantity: 1,
          price: prices[i],
          item_type: "product",
        };
      });
    }

    const keepupResult = await createKeepupSale({
      customerName: customer?.name,
      customerEmail: customer?.email,
      customerPhone: customer?.phone,
      invoiceDate: order.invoiceDate,
      items: lineItems,
    });

    await ordersApi.storeKeepupIds(order.id, keepupResult.saleId, keepupResult.link);

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
