// GET  /api/suppliers  — list suppliers
// POST /api/suppliers  — create supplier (admin only)
import { NextRequest } from "next/server";
import { suppliersApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse, badRequestResponse } from "@/lib/auth";
import { z } from "zod";

const CreateSupplierSchema = z.object({
  name: z.string().min(1, "Name is required"),
  category: z.string().optional(),
  platform: z.string().optional(),
  platformLink: z.string().optional(),
  contact: z.string().optional(),
  contactMethod: z.string().optional(),
  rating: z.number().min(1).max(5).optional(),
  notes: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? undefined;
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    const limit = 50;

    const all = await suppliersApi.list(search);
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const data = all.slice((page - 1) * limit, page * limit);

    return Response.json({ success: true, data, total, totalPages, page });
  } catch (err) {
    console.error("[GET /suppliers]", err);
    return serverErrorResponse("Failed to fetch suppliers");
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = CreateSupplierSchema.safeParse(body);
    if (!parsed.success) {
      return badRequestResponse(parsed.error.errors[0].message);
    }

    const supplier = await suppliersApi.create(parsed.data as Parameters<typeof suppliersApi.create>[0], user.email);
    return Response.json({ success: true, data: supplier }, { status: 201 });
  } catch (err) {
    console.error("[POST /suppliers]", err);
    return serverErrorResponse("Failed to create supplier");
  }
}
