// GET /api/ready — READINESS (PostgreSQL backend only). Liveness stays /api/health. Anonymous callers get only {ready}; the per-check report
// requires `Authorization: Bearer <READINESS_TOKEN>`. 200 = ready, 503 = not ready. Never contains secrets, hosts or connection details.
import { NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/backend";
import { evaluateReadiness, readinessTokenOk } from "@/lib/readiness";
import { checkRateLimit, getClientIp, rateLimitedResponse } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  let postgres = false; try { postgres = isPostgresBackend(); } catch { /* invalid value -> not ready below */ }
  if (!postgres) return Response.json({ success: false, error: "Readiness checks apply to the PostgreSQL backend" }, { status: 501, headers: { "Cache-Control": "no-store" } });
  if (!checkRateLimit(`ready:${getClientIp(request)}`, 60, 60_000)) return rateLimitedResponse(60);
  try {
    const r = await evaluateReadiness();
    const detailed = readinessTokenOk(request.headers.get("authorization"));
    return Response.json(detailed ? r : { ready: r.ready }, { status: r.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ready: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
