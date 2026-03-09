// GET    /api/suppliers/[id]
// PATCH  /api/suppliers/[id]
// DELETE /api/suppliers/[id]
import { NextRequest } from "next/server";
import { suppliersApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { z } from "zod";

const UpdateSupplierSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.string().optional(),
  platform: z.string().optional(),
  platformLink: z.string().optional(),
  contact: z.string().optional(),
  contactMethod: z.string().optional(),
  rating: z.number().min(1).max(5).optional(),
  notes: z.string().optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    const supplier = await suppliersApi.getById(id);
    return Response.json({ success: true, data: supplier });
  } catch {
    return serverErrorResponse("Supplier not found");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    const body = await request.json();
    const parsed = UpdateSupplierSchema.safeParse(body);
    if (!parsed.success) {
      return badRequestResponse(parsed.error.errors[0].message);
    }

    const supplier = await suppliersApi.update(id, parsed.data as Parameters<typeof suppliersApi.update>[1]);
    return Response.json({ success: true, data: supplier });
  } catch (err) {
    console.error("[PATCH /suppliers/:id]", err);
    return serverErrorResponse("Failed to update supplier");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;
  const { id } = await params;

  try {
    await suppliersApi.delete(id);
    return Response.json({ success: true });
  } catch (err) {
    console.error("[DELETE /suppliers/:id]", err);
    return serverErrorResponse("Failed to delete supplier");
  }
}
