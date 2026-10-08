// POST /api/customers/[id]/link-login — a super_admin links an existing customer to a verified Firebase identity (PostgreSQL backend only).
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/identity";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isPostgresBackend()) return pg.customerLinkLogin(request, { params });
  return Response.json({ success: false, error: "Login linking is available only on the PostgreSQL backend" }, { status: 501 });
}
