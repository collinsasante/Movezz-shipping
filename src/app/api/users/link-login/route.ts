// POST /api/users/link-login — a super_admin activates an existing Firebase login as warehouse staff (PostgreSQL backend only).
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import * as pg from "@/lib/pg-routes/identity";

export async function POST(request: NextRequest) {
  if (isPostgresBackend()) return pg.staffLinkLogin(request);
  return Response.json({ success: false, error: "Login linking is available only on the PostgreSQL backend" }, { status: 501 });
}
