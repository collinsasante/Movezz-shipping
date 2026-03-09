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

    const [customer, items] = await Promise.all([
      customersApi.getById(order.customerId).catch(() => null),
      Promise.all(order.itemIds.map((itemId) => itemsApi.getById(itemId).catch(() => null))),
    ]);

    const validItems = items.filter(Boolean);
    const pricePerItem = validItems.length > 0
      ? order.invoiceAmount / validItems.length
      : order.invoiceAmount;

    const lineItems = validItems.length > 0
      ? validItems.map((item) => {
          const qty = item!.quantity ?? 1;
          let cbmNote = "";
          if (item!.length && item!.width && item!.height) {
            const factor = item!.dimensionUnit === "inches" ? 16.387064 : 1;
            const cbm = (item!.length * item!.width * item!.height * factor * qty) / 1_000_000;
            cbmNote = ` [CBM: ${cbm.toFixed(4)} m³]`;
          }
          const trackingNote = item!.trackingNumber ? ` [TRK: ${item!.trackingNumber}]` : "";
          return {
            item_name: (item!.description ? `Freight: ${item!.description}` : `Freight Item (${item!.itemRef})`) + trackingNote + cbmNote,
            quantity: 1,
            price: Math.round(pricePerItem * 100) / 100,
            item_type: "service",
          };
        })
      : [{ item_name: `Freight — ${order.orderRef}`, quantity: 1, price: Math.round(order.invoiceAmount * 100) / 100, item_type: "service" }];

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
