// POST /api/orders/[id]/create-invoice — create Keepup invoice for an existing order
import { NextRequest } from "next/server";
import { ordersApi, customersApi, itemsApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";
import { createKeepupSale } from "@/lib/keepup";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;
    const order = await ordersApi.getById(id);

    if (order.keepupSaleId) {
      return Response.json(
        { success: false, error: "Invoice already exists in Keepup" },
        { status: 400 }
      );
    }

    console.log("[create-invoice] ===== DATA CONSISTENCY CHECK =====");
    console.log("[create-invoice] order id:", order.id);
    console.log("[create-invoice] order ref:", order.orderRef);
    console.log("[create-invoice] invoice amount (app):", order.invoiceAmount, "GHS");
    console.log("[create-invoice] invoice date (app):", order.invoiceDate);
    console.log("[create-invoice] customer id:", order.customerId);
    console.log("[create-invoice] item ids:", order.itemIds);
    console.log("[create-invoice] status:", order.status);

    const [customer, items] = await Promise.all([
      customersApi.getById(order.customerId).catch(() => null),
      Promise.all(order.itemIds.map((itemId) => itemsApi.getById(itemId).catch(() => null))),
    ]);

    console.log("[create-invoice] customer name (app):", customer?.name);
    console.log("[create-invoice] customer email (app):", customer?.email);
    console.log("[create-invoice] customer phone (app):", customer?.phone);
    console.log("[create-invoice] items fetched:", items.length, "valid:", items.filter(Boolean).length);
    items.forEach((item, i) => {
      if (item) console.log(`[create-invoice]   item[${i}]: ref=${item.itemRef} desc="${item.description}" weight=${item.weight}kg dims=${item.length}x${item.width}x${item.height}${item.dimensionUnit}`);
      else console.log(`[create-invoice]   item[${i}]: FETCH FAILED`);
    });

    const validItems = items.filter(Boolean);

    // Per-item line items, split proportionally by CBM (or equally if no CBM data)
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
      const cbms = validItems.map((item) => getItemCbm(item!));
      const totalCbm = cbms.reduce((s, c) => s + c, 0);
      const useCbm = totalCbm > 0;

      const prices: number[] = [];
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

      lineItems = validItems.map((item, i) => {
        const trk = item!.trackingNumber ? ` [TRK: ${item!.trackingNumber}]` : "";
        const name = (item!.description || item!.itemRef) + trk;
        return {
          item_name: name.replace(/[^\x20-\x7E]/g, "").slice(0, 200),
          quantity: 1,
          price: prices[i],
          item_type: "product",
        };
      });
    }

    console.log("[create-invoice] lineItems:", JSON.stringify(lineItems));

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
    console.error("[POST /orders/[id]/create-invoice] Error:", msg);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
}
