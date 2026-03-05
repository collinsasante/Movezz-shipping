// GET  /api/support  — list tickets (customer: own, admin: all)
// POST /api/support  — create ticket (customer)
import { NextRequest } from "next/server";
import { supportApi, customersApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { z } from "zod";

const CreateTicketSchema = z.object({
  subject: z.string().min(3, "Subject is required").max(200),
  content: z.string().min(5, "Message is required").max(5000),
});

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff", "customer"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const customerId = user.role === "customer" ? user.customerId : undefined;
    const tickets = await supportApi.list(customerId);
    return Response.json({ success: true, data: tickets });
  } catch (err) {
    console.error("[GET /support] Error:", err);
    return serverErrorResponse("Failed to fetch support tickets");
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["customer"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    if (!user.customerId) return badRequestResponse("Customer account required");

    const body = await request.json();
    const parsed = CreateTicketSchema.safeParse(body);
    if (!parsed.success) {
      return badRequestResponse(parsed.error.errors.map((e) => e.message).join(", "));
    }

    const customer = await customersApi.getById(user.customerId);
    const ticket = await supportApi.create(
      user.customerId,
      customer.name,
      parsed.data.subject,
      parsed.data.content
    );

    return Response.json({ success: true, data: ticket }, { status: 201 });
  } catch (err) {
    console.error("[POST /support] Error:", err);
    return serverErrorResponse("Failed to create support ticket");
  }
}
