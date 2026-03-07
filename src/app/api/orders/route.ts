// GET  /api/orders  — list orders
// POST /api/orders  — create order (admin only)
import { NextRequest } from "next/server";
import { ordersApi, customersApi, itemsApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
} from "@/lib/auth";
import { createKeepupSale } from "@/lib/keepup";
import { z } from "zod";

const CreateOrderSchema = z.object({
  customerId: z.string().min(1, "Customer ID is required"),
  itemIds: z.array(z.string()).min(1, "At least one item is required"),
  invoiceAmount: z.number().positive("Invoice amount must be positive"),
  invoiceDate: z.string(),
  notes: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, [
    "super_admin",
    "warehouse_staff",
    "customer",
  ]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { searchParams } = new URL(request.url);
    const params = {
      status: searchParams.get("status") as
        | import("@/types").OrderStatus
        | undefined,
      customerId: searchParams.get("customerId") ?? undefined,
      search: searchParams.get("search") ?? undefined,
    };

    if (user.role === "customer") {
      params.customerId = user.customerId;
    }

    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    const limit = 50;

    const allOrders = await ordersApi.list(params);
    const total = allOrders.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const data = allOrders.slice((page - 1) * limit, page * limit);

    return Response.json({ success: true, data, total, totalPages, page });
  } catch (err) {
    console.error("[GET /orders] Error:", err);
    return serverErrorResponse("Failed to fetch orders");
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = CreateOrderSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const order = await ordersApi.create(parsed.data, user.email);

    // Create invoice in Keepup (non-fatal — don't block if it fails)
    try {
      const [customer, items] = await Promise.all([
        customersApi.getById(parsed.data.customerId).catch(() => null),
        Promise.all(
          parsed.data.itemIds.map((id) =>
            itemsApi.getById(id).catch(() => null)
          )
        ),
      ]);

      const validItems = items.filter(Boolean);
      const pricePerItem =
        validItems.length > 0
          ? parsed.data.invoiceAmount / validItems.length
          : parsed.data.invoiceAmount;

      const keepupResult = await createKeepupSale({
        customerName: customer?.name,
        customerEmail: customer?.email,
        customerPhone: customer?.phone,
        invoiceDate: parsed.data.invoiceDate,
        items: validItems.map((item) => ({
          item_name: item!.description
            ? `Freight: ${item!.description}`
            : `Freight Item (${item!.itemRef})`,
          quantity: 1,
          price: Math.round(pricePerItem * 100) / 100,
          item_type: "service",
        })),
        reference: order.orderRef,
        notes: parsed.data.notes,
      });

      // Store the keepup sale ID back on the order
      await ordersApi.storeKeepupIds(
        order.id,
        keepupResult.saleId,
        keepupResult.link
      );
      order.keepupSaleId = keepupResult.saleId;
      order.keepupLink = keepupResult.link;
    } catch (keepupErr) {
      console.error("[POST /orders] Keepup sale creation failed (non-fatal):", keepupErr);
    }

    return Response.json(
      {
        success: true,
        data: order,
        message: `Order ${order.orderRef} created successfully`,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /orders] Error:", err);
    return serverErrorResponse("Failed to create order");
  }
}
