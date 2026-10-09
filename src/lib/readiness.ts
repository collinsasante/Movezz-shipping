// READINESS (is this deployment able to do its job?) as opposed to /api/health, which is LIVENESS (is the Worker answering?).
// PostgreSQL mode only. Every check is read-only apart from one single-use actor assertion (the same thing every request does), cached for a
// minute. Nothing returned contains a secret, a connection string, a host name, a key length or a table row. Callers decide how much to reveal.
//
// What this does NOT establish (and says so in `notes`): that the Cloudflare Worker can reach PostgreSQL from the deployed bundle (needs deployed
// staging evidence), that Keepup/Firebase/Cloudinary/Resend actually accept the credentials (no external call is made), or that a mock works as a provider.
import type { Pool } from "pg";
import { readEnv } from "./env";
import { isPostgresBackend } from "./backend";
import { getPool } from "./db/client";
import { actorKeyFromEnv, withActorTransaction } from "./db/actor";
import { describeKeepup } from "./integrations/keepup-runtime";

export interface ReadinessCheck { name: string; ok: boolean; gating: boolean; detail?: string }
export interface KeepupBacklog { pending: number; creating: number; failed: number; failedExhausted: number; needsReconciliation: number; oldestDueSeconds: number | null }
export interface ReadinessReport {
  ready: boolean; checks: ReadinessCheck[]; waivers: string[];
  /** Keepup work queue, counts only (no ids, no customer data). `null` when it could not be read. Informational: it does not decide `ready`. */
  backlog: KeepupBacklog | null;
  /** `configuredForLive` = settings say live; `providerConnectivityVerified` is ALWAYS false: no provider is contacted by a readiness check. */
  keepup: { mode: string; configured: boolean; configuredForLive: boolean; required: boolean; waived: boolean; providerConnectivityVerified: false }; notes: string[]
}
export const READINESS_TOKEN_MIN = 32;

const NOTES = [
  "Worker-to-PostgreSQL connectivity from the deployed Cloudflare bundle is not proven by this check; it needs deployed staging evidence.",
  "Provider credentials are checked for presence only; no external provider is contacted.",
  "keepup_live_configured is true only for MOVEZZ_KEEPUP_MODE=live with explicit production consent; a mock or sandbox gateway never counts.",
];
const present = (...keys: string[]) => keys.every((k) => (readEnv(k) ?? "").trim() !== "");
const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

let cache: { at: number; report: ReadinessReport } | null = null;
export function resetReadinessCache() { cache = null; }

export async function evaluateReadiness(opts: { pool?: Pool; ttlMs?: number } = {}): Promise<ReadinessReport> {
  const ttl = opts.ttlMs ?? 60_000;
  if (!opts.pool && cache && Date.now() - cache.at < ttl) return cache.report;
  const checks: ReadinessCheck[] = []; const add = (name: string, ok: boolean, gating = true, detail?: string) => checks.push({ name, ok, gating, ...(detail ? { detail } : {}) });

  let postgres = false; try { postgres = isPostgresBackend(); } catch { /* invalid value */ }
  add("backend_is_postgres", postgres, true, postgres ? undefined : "MOVEZZ_DATA_BACKEND is not postgres");
  let pool: Pool | null = null; let backlog: KeepupBacklog | null = null;
  if (postgres) { try { pool = opts.pool ?? getPool(); } catch { add("database_configured", false, true, "no database connection is configured"); } }
  if (pool) {
    try {
      await timeout(pool.query("SELECT 1"), 3000);
      add("database_reachable", true);
      const info = (await timeout(pool.query(
        `SELECT (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl, to_regclass('public.invoices') IS NOT NULL AS has_invoices, to_regclass('public.keepup_sync') IS NOT NULL AS has_sync,
                (SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls) FROM pg_roles WHERE rolname = current_user) AS unprivileged`), 3000)).rows[0];
      const local = (() => { try { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(readEnv("DATABASE_URL") ?? "").hostname); } catch { return !readEnv("DATABASE_URL"); } })();
      add("database_encrypted_in_transit", info.ssl === true || local, !local, info.ssl === true ? undefined : local ? "loopback or Hyperdrive connection" : "the connection is not encrypted");
      add("schema_present", Boolean(info.has_invoices && info.has_sync), true, info.has_invoices && info.has_sync ? undefined : "migrations have not been applied");
      add("runtime_role_unprivileged", info.unprivileged === true, true, info.unprivileged === true ? undefined : "the application role has elevated privileges");
      try {
        actorKeyFromEnv();
        await timeout(withActorTransaction(pool, { type: "integration", requestId: "readiness" }, async (tx) => {
          await tx.query("SELECT 1");
          try {   // counts only; a failure here must not hide the signing-key result
            const b = (await tx.query(`SELECT count(*) FILTER (WHERE sync_state = 'pending')::int AS pending, count(*) FILTER (WHERE sync_state = 'creating')::int AS creating,
                count(*) FILTER (WHERE sync_state = 'failed')::int AS failed, count(*) FILTER (WHERE sync_state = 'failed' AND next_retry_at IS NULL)::int AS failed_exhausted,
                count(*) FILTER (WHERE sync_state = 'needs_reconciliation')::int AS needs_reconciliation,
                floor(max(extract(epoch FROM now() - coalesce(next_retry_at, created_at))) FILTER (WHERE sync_state IN ('pending','failed') AND coalesce(next_retry_at, created_at) <= now()))::int AS oldest_due
              FROM keepup_sync`)).rows[0];
            backlog = { pending: b.pending, creating: b.creating, failed: b.failed, failedExhausted: b.failed_exhausted, needsReconciliation: b.needs_reconciliation, oldestDueSeconds: b.oldest_due ?? null };
          } catch { backlog = null; }
        }), 4000);
        add("actor_signing_key_accepted_by_database", true);
      } catch { add("actor_signing_key_accepted_by_database", false, true, "ACTOR_CONTEXT_KEY is missing, malformed, or not registered in this database"); }
    } catch (e) { add("database_reachable", false, true, (e as Error).message === "timeout" ? "no answer within 3 s" : "the database query failed"); }
  }
  add("firebase_configured", present("FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "NEXT_PUBLIC_FIREBASE_API_KEY"));
  add("cloudinary_configured", present("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"));
  add("email_configured", present("RESEND_API_KEY", "EMAIL_FROM"));
  add("whatsapp_configured", present("WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"), false, "optional");
  const k = describeKeepup(readEnv);
  const required = (readEnv("MOVEZZ_KEEPUP_REQUIRED") ?? "true").trim().toLowerCase() !== "false";   // waiving Keepup is an explicit owner decision (runbook G9)
  add("keepup_live_configured", k.liveCapable, required, k.liveCapable ? undefined : `keepup mode is ${k.mode}${k.problems.length ? " (misconfigured)" : ""}; only mode=live counts`);
  add("airtable_credentials_absent", !present("AIRTABLE_API_KEY") && !present("AIRTABLE_BASE_ID"), false, "informational until cutover; required for Airtable independence");

  const waivers = required ? [] : ["keepup: synchronisation waived by MOVEZZ_KEEPUP_REQUIRED=false (an explicit owner decision, not a successful integration)"];
  const report: ReadinessReport = { ready: checks.filter((c) => c.gating).every((c) => c.ok), checks, waivers, backlog, keepup: { mode: k.mode, configured: k.configured, configuredForLive: k.liveCapable, required, waived: !required, providerConnectivityVerified: false }, notes: NOTES };
  if (!opts.pool) cache = { at: Date.now(), report };
  return report;
}

/** Constant-time comparison of the presented bearer token with READINESS_TOKEN (at least READINESS_TOKEN_MIN characters; shorter configured tokens are never accepted). */
export function readinessTokenOk(authorization: string | null): boolean {
  const expected = readEnv("READINESS_TOKEN") ?? "";
  if (expected.length < READINESS_TOKEN_MIN || !authorization?.startsWith("Bearer ")) return false;
  const given = authorization.slice(7); let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return diff === 0;
}
