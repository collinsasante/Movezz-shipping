// Temporary debug endpoint — remove after diagnosing history issue
import { NextRequest } from "next/server";
import { statusHistoryApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const all = await statusHistoryApi.getAll();
    return Response.json({ count: all.length, sample: all.slice(0, 5) });
  } catch (e) {
    return serverErrorResponse(String(e));
  }
}
