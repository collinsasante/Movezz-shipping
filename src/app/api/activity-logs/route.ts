// GET /api/activity-logs — audit log (admin only)
import { NextRequest } from "next/server";
import { activityLogsApi, statusHistoryApi, customersApi, itemsApi } from "@/lib/airtable";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

const REC_ID = /rec[A-Za-z0-9]{14}/g;

// Resolve raw Airtable record IDs that were stored in old log details strings.
// Tries customers first (most common), then items.
async function resolveRecordIds(details: string, idMap: Map<string, string>): Promise<string> {
  return details.replace(REC_ID, (id) => idMap.get(id) ?? id);
}

async function buildIdMap(logs: { details: string }[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const log of logs) {
    for (const match of log.details.matchAll(new RegExp(REC_ID.source, "g"))) {
      ids.add(match[0]);
    }
  }
  if (ids.size === 0) return new Map();

  const map = new Map<string, string>();
  await Promise.all([...ids].map(async (id) => {
    // Try customers
    try {
      const c = await customersApi.getById(id);
      map.set(id, c.shippingMark || c.name);
      return;
    } catch { /* not a customer */ }
    // Try items
    try {
      const item = await itemsApi.getById(id);
      map.set(id, item.itemRef || id);
    } catch { /* leave as-is */ }
  }));
  return map;
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type"); // "activity" | "status"
    const limitParam = parseInt(searchParams.get("limit") ?? "100");
    const limit = isNaN(limitParam) || limitParam < 1 ? 100 : limitParam;

    if (type === "status") {
      const history = await statusHistoryApi.getAll();
      return Response.json({ success: true, data: history });
    }

    const logs = await activityLogsApi.getAll(limit);

    // Resolve any legacy record IDs still in old details strings
    const idMap = await buildIdMap(logs);
    if (idMap.size > 0) {
      for (const log of logs) {
        log.details = await resolveRecordIds(log.details, idMap);
      }
    }

    return Response.json({ success: true, data: logs });
  } catch (err) {
    console.error("[GET /activity-logs] Error:", err);
    return serverErrorResponse("Failed to fetch activity logs");
  }
}
