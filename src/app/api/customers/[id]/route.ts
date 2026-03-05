// GET    /api/customers/[id]  — get single customer
// PATCH  /api/customers/[id]  — update customer
// DELETE /api/customers/[id]  — deactivate customer
import { NextRequest } from "next/server";
import { customersApi, itemsApi, ordersApi, statusHistoryApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  notFoundResponse,
  badRequestResponse,
} from "@/lib/auth";
import { z } from "zod";

const UpdateCustomerSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  phone: z.string().min(7).max(30).optional(),
  email: z.string().email().max(254).optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  shippingType: z.enum(["air", "sea"]).optional(),
  exchangeRate: z.number().positive().optional().nullable(),
  shippingAddress: z.string().max(500).optional(),
});

// GET /api/customers/[id]
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

    // Customers can only access their own data
    if (user.role === "customer" && user.customerId !== id) {
      return Response.json(
        { success: false, error: "Access denied" },
        { status: 403 }
      );
    }

    const [customer, items, orders] = await Promise.all([
      customersApi.getById(id),
      itemsApi.getByCustomer(id),
      ordersApi.getByCustomer(id),
    ]);

    return Response.json({
      success: true,
      data: {
        ...customer,
        items,
        orders,
        totalItems: items.length,
        totalOrders: orders.length,
      },
    });
  } catch (err) {
    console.error("[GET /customers/[id]] Error:", err);
    return notFoundResponse("Customer not found");
  }
}

// PATCH /api/customers/[id]
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
    const parsed = UpdateCustomerSchema.safeParse(body);

    if (!parsed.success) {
      return badRequestResponse(
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const customer = await customersApi.update(id, parsed.data, user.email);

    return Response.json({
      success: true,
      data: customer,
      message: "Customer updated successfully",
    });
  } catch (err) {
    console.error("[PATCH /customers/[id]] Error:", err);
    return serverErrorResponse("Failed to update customer");
  }
}

// DELETE /api/customers/[id] — hard delete customer record
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    await customersApi.delete(id);

    return Response.json({
      success: true,
      message: "Customer deleted successfully",
    });
  } catch (err) {
    console.error("[DELETE /customers/[id]] Error:", err);
    return serverErrorResponse("Failed to delete customer");
  }
}
