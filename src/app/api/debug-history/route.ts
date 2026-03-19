// Temporary debug endpoint — remove after diagnosing history issue
import { NextRequest } from "next/server";
import { statusHistoryApi, TABLES } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";
import Airtable from "airtable";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  const results: Record<string, unknown> = {};

  // 1. Read existing records
  try {
    const all = await statusHistoryApi.getAll();
    results.count = all.length;
    results.sample = all.slice(0, 3);
  } catch (e) {
    results.readError = String(e);
  }

  // 2. Try writing a test record and report what happens
  try {
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID!);
    const rec = await base(TABLES.STATUS_HISTORY).create({
      RecordType: "Item",
      RecordID: "TEST-debug",
      RecordRef: "TEST-debug",
      PreviousStatus: "Arrived at Transit Warehouse",
      NewStatus: "Shipped to Ghana",
      ChangedByRole: "super_admin",
      ChangedAt: new Date().toISOString(),
      Notes: "debug test — delete me",
    });
    results.writeSuccess = true;
    results.createdId = rec.id;
  } catch (e) {
    results.writeError = String(e);
  }

  return Response.json(results);
}
