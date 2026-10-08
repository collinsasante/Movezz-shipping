// Which Keepup gateway the PostgreSQL-mode worker may use, decided from configuration alone (no network, no secrets returned).
//
//   MOVEZZ_KEEPUP_MODE   disabled (default) | mock | sandbox | live
//   KEEPUP_API_KEY       required for sandbox and live
//   KEEPUP_BASE_URL      required for sandbox (a local stub or a host named sandbox/staging/test); ignored for live (the production base is fixed)
//   MOVEZZ_KEEPUP_ALLOW_PRODUCTION=true   second, explicit switch required for live (the gateway also demands it)
//
// "live" here means CONFIGURED to talk to the production Keepup API. It never means verified or operational: nothing in this repository has
// ever called the real Keepup API from the PostgreSQL path (docs/CUTOVER-RUNBOOK.md G9). A mock or sandbox gateway is never "live-capable".
import { HttpKeepupGateway, MockKeepupGateway, assertSafeKeepupBaseUrl, type KeepupGateway } from "./keepup-gateway";

export type KeepupMode = "disabled" | "mock" | "sandbox" | "live";
export const KEEPUP_PRODUCTION_BASE = "https://api.keepup.store/v2.0";
export interface KeepupRuntimeStatus { mode: KeepupMode; configured: boolean; liveCapable: boolean; problems: string[] }
type Env = (key: string) => string | undefined;
const fromRecord = (r: Record<string, string | undefined>): Env => (k) => r[k];

export function describeKeepup(env: Env | Record<string, string | undefined>): KeepupRuntimeStatus {
  const get: Env = typeof env === "function" ? env : fromRecord(env);
  const raw = (get("MOVEZZ_KEEPUP_MODE") ?? "").trim().toLowerCase();
  const problems: string[] = [];
  const mode: KeepupMode = raw === "" ? "disabled" : (["disabled", "mock", "sandbox", "live"] as const).find((m) => m === raw) ?? "disabled";
  if (raw !== "" && mode === "disabled" && raw !== "disabled") problems.push("MOVEZZ_KEEPUP_MODE is not one of disabled|mock|sandbox|live");
  const key = get("KEEPUP_API_KEY") ?? "";
  if (mode === "sandbox" || mode === "live") if (key.length < 8) problems.push("KEEPUP_API_KEY is missing or too short");
  if (mode === "sandbox") {
    try { assertSafeKeepupBaseUrl(get("KEEPUP_BASE_URL") ?? "", "sandbox", false); } catch (e) { problems.push(`KEEPUP_BASE_URL: ${(e as Error).message}`); }
  }
  if (mode === "live" && get("MOVEZZ_KEEPUP_ALLOW_PRODUCTION") !== "true") problems.push("live mode needs MOVEZZ_KEEPUP_ALLOW_PRODUCTION=true");
  const configured = mode !== "disabled" && problems.length === 0;
  return { mode, configured, liveCapable: mode === "live" && configured, problems };
}

/** Builds the gateway for the configured mode. Throws for disabled or misconfigured modes: there is no silent fallback to the mock. */
export function createKeepupGateway(env: Env | Record<string, string | undefined>, fetchImpl?: typeof fetch): KeepupGateway {
  const get: Env = typeof env === "function" ? env : fromRecord(env);
  const s = describeKeepup(get);
  if (!s.configured) throw new Error(`Keepup is not usable: mode=${s.mode}${s.problems.length ? `; ${s.problems.join("; ")}` : ""}`);
  if (s.mode === "mock") return new MockKeepupGateway();
  if (s.mode === "sandbox") return new HttpKeepupGateway({ baseUrl: get("KEEPUP_BASE_URL")!, apiKey: get("KEEPUP_API_KEY")!, environment: "sandbox", fetchImpl });
  return new HttpKeepupGateway({ baseUrl: KEEPUP_PRODUCTION_BASE, apiKey: get("KEEPUP_API_KEY")!, environment: "production", allowProduction: true, fetchImpl });
}
