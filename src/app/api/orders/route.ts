// GET  /api/orders  — list orders
// POST /api/orders  — create order (admin only). Does not touch Keepup; see create-invoice.
import { NextRequest } from "next/server";
import { ordersApi, itemsApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
  forbiddenResponse,
} from "@/lib/auth";
import { invoiceTotalUsd } from "@/lib/pricing";
import { z } from "zod";

const CreateOrderSchema = z.object({
  customerId: z.string().min(1, "Customer ID is required"),
  itemIds: z.array(z.string()).min(1, "At least one item is required"),
  invoiceAmount: z.number().positive("Invoice amount must be positive").max(1_000_000, "Invoice amount cannot exceed $1,000,000"),
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

    // The customer id comes from the authenticated identity only; a customer without one gets nothing.
    if (user.role === "customer") {
      if (!user.customerId) return forbiddenResponse("Your login is not linked to a customer profile");
      params.customerId = user.customerId;
    }

    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    const limit = 50;

    const allOrders = await ordersApi.list(params);
    const total = allOrders.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const data = allOrders.slice((page - 1) * limit, page * limit);

    return Response.json({ success: true, data, total, totalPages, page });
  } catch {
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

    // The invoice total is derived from the stored item prices (special price for special-rate items,
    // tier price otherwise). The client's number must agree; it cannot choose the billing basis.
    const stored = await Promise.all(parsed.data.itemIds.map((id) => itemsApi.getById(id).catch(() => null)));
    if (stored.some((i) => i === null)) return badRequestResponse("One or more items do not exist");
    const found = stored.filter((i): i is NonNullable<typeof i> => i !== null);
    if (found.some((i) => i.customerId !== parsed.data.customerId)) {
      return badRequestResponse("All items must belong to the invoiced customer");
    }
    if (found.some((i) => i.orderId)) return badRequestResponse("One or more items are already on an invoice");
    const serverTotal = invoiceTotalUsd(found);
    if (serverTotal > 0 && Math.abs(serverTotal - parsed.data.invoiceAmount) > 0.01) {
      return badRequestResponse(`Invoice amount does not match the item prices (expected ${serverTotal.toFixed(2)})`);
    }

    const order = await ordersApi.create(parsed.data, user.email);

    // No Keepup sale is created here. The one authoritative creation is POST /api/orders/[id]/create-invoice
    // (GHS at the current rate, discount applied, carton grouping, idempotent). Creating one here as well
    // produced two sales for every order, the first in raw USD numbers.

    return Response.json(
      {
        success: true,
        data: order,
        message: `Order ${order.orderRef} created successfully`,
      },
      { status: 201 }
    );
  } catch {
    return serverErrorResponse("Failed to create order");
  }
}
