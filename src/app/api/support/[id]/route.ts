// GET   /api/support/[id]  — get ticket with messages
// POST  /api/support/[id]  — add message to ticket
// PATCH /api/support/[id]  — update status (admin)
import { NextRequest } from "next/server";
import { supportApi, customersApi } from "@/lib/airtable";
import {
  requireAuth,
  serverErrorResponse,
  badRequestResponse,
  forbiddenResponse,
} from "@/lib/auth";
import { z } from "zod";

const AddMessageSchema = z
  .object({
    content: z.string().default(""),
    type: z.enum(["text", "image", "voice", "document"]).optional(),
    fileUrl: z.string().url().optional(),
    fileName: z.string().optional(),
    fileSize: z.number().optional(),
    duration: z.number().optional(),
    mimeType: z.string().optional(),
  })
  .refine((d) => d.content.trim().length > 0 || d.fileUrl, {
    message: "Message content or file attachment is required",
  });

const UpdateStatusSchema = z.object({
  status: z.enum(["open", "resolved"]),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff", "customer"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    const ticket = await supportApi.getById(id);
    // Customers can only view their own tickets
    if (user.role === "customer" && ticket.customerId !== user.customerId) {
      return forbiddenResponse("Access denied");
    }
    return Response.json({ success: true, data: ticket });
  } catch (err) {
    console.error("[GET /support/[id]] Error:", err);
    return serverErrorResponse("Failed to fetch ticket");
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff", "customer"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { id } = await params;
    const ticket = await supportApi.getById(id);
    if (user.role === "customer" && ticket.customerId !== user.customerId) {
      return forbiddenResponse("Access denied");
    }

    const body = await request.json();
    const parsed = AddMessageSchema.safeParse(body);
    if (!parsed.success) {
      return badRequestResponse(parsed.error.errors.map((e) => e.message).join(", "));
    }

    let senderName: string;
    if (user.role === "customer" && user.customerId) {
      const customer = await customersApi.getById(user.customerId).catch(() => null);
      senderName = customer?.name ?? user.email;
    } else {
      senderName = "Support Team";
    }

    const { content, type, fileUrl, fileName, fileSize, duration, mimeType } = parsed.data;
    const attachment = fileUrl
      ? { type: (type ?? "document") as "image" | "voice" | "document", fileUrl, fileName: fileName ?? "file", fileSize: fileSize ?? 0, duration, mimeType }
      : undefined;

    const updated = await supportApi.addMessage(
      id,
      user.role === "customer" ? "customer" : "admin",
      senderName,
      content,
      attachment
    );

    return Response.json({ success: true, data: updated });
  } catch (err) {
    console.error("[POST /support/[id]] Error:", err);
    return serverErrorResponse("Failed to send message");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = UpdateStatusSchema.safeParse(body);
    if (!parsed.success) {
      return badRequestResponse(parsed.error.errors.map((e) => e.message).join(", "));
    }

    const ticket = await supportApi.updateStatus(id, parsed.data.status);
    return Response.json({ success: true, data: ticket });
  } catch (err) {
    console.error("[PATCH /support/[id]] Error:", err);
    return serverErrorResponse("Failed to update ticket");
  }
}
