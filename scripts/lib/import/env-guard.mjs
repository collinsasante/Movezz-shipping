// Production-safety guard. The importer FAILS CLOSED: it runs only when every check below passes, and the decision (with the
// individual checks) is part of the readiness report. Nothing here hard-codes a production host or credential; instead it
// requires an explicit environment class + mode, refuses any live-integration credential in the process environment, and
// refuses database targets that are not loopback or explicitly allow-listed staging hosts.
import { ImportRefusal } from "./errors.mjs";

export const MODES = ["dry-run", "import", "reconcile"];
export const APPROVED_CLASSES = ["test", "local", "staging"];

// Environment variables that would mean the process holds (or could reach) a live integration. The importer needs none of them.
const FORBIDDEN_ENV = [
  /^AIRTABLE_/i, /^FIREBASE_/i, /^NEXT_PUBLIC_FIREBASE/i, /^GOOGLE_APPLICATION_CREDENTIALS$/i, /^KEEPUP_/i, /^CLOUDINARY_/i, /^NEXT_PUBLIC_CLOUDINARY/i,
  /^CLOUDFLARE_/i, /^CF_/i, /^RESEND_/i, /^WHATSAPP_/i, /^TWILIO_/i,
];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PRODUCTION_WORDS = /(^|[^a-z])(prod|production|live)([^a-z]|$)/i;

/**
 * @param {{ env?: Record<string,string|undefined>, targetUrl?: string, mode?: string, snapshotKind?: string }} input
 * @returns {{ ok: boolean, environment: string|null, mode: string|null, checks: {name: string, ok: boolean, detail: string}[] }}
 */
export function evaluateEnvironment({ env = process.env, targetUrl, mode, snapshotKind } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const m = mode ?? env.MOVEZZ_IMPORT_MODE;
  add("import mode is explicit", MODES.includes(m), MODES.includes(m) ? `mode=${m}` : "MOVEZZ_IMPORT_MODE must be one of dry-run|import|reconcile");

  const cls = env.MOVEZZ_IMPORT_ENVIRONMENT;
  add("environment class is explicitly approved", APPROVED_CLASSES.includes(cls),
    APPROVED_CLASSES.includes(cls) ? `class=${cls}` : "MOVEZZ_IMPORT_ENVIRONMENT must be one of test|local|staging");

  add("NODE_ENV is not production", env.NODE_ENV !== "production", `NODE_ENV=${env.NODE_ENV ?? "(unset)"}`);

  const offenders = Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== "" && FORBIDDEN_ENV.some((re) => re.test(k)));
  add("no live-integration credentials in the environment", offenders.length === 0,
    offenders.length === 0 ? "none present" : `present (names only): ${offenders.sort().join(", ")}`);

  let host = null; let dbName = "";
  if (!targetUrl) add("target database is given", false, "no target URL");
  else {
    try {
      const u = new URL(targetUrl);
      host = u.hostname.toLowerCase(); dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
      const loopback = LOOPBACK.has(host);
      const allowed = (env.MOVEZZ_IMPORT_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const hostOk = loopback || (cls === "staging" && allowed.includes(host));
      add("target host is loopback or an explicitly allow-listed staging host", hostOk, hostOk ? `host=${host}` : `host ${host} is neither loopback nor allow-listed for staging`);
      const looksProd = PRODUCTION_WORDS.test(host) || PRODUCTION_WORDS.test(dbName);
      add("target does not look like production", !looksProd, looksProd ? "host or database name contains prod/production/live" : "no production marker in host or database name");
    } catch {
      add("target database is given", false, "target URL is not a valid URL");
    }
  }

  if (snapshotKind === "export") {
    add("a real export snapshot is only accepted in staging with explicit consent", cls === "staging" && env.MOVEZZ_IMPORT_ALLOW_EXPORT === "1",
      cls === "staging" && env.MOVEZZ_IMPORT_ALLOW_EXPORT === "1" ? "staging + MOVEZZ_IMPORT_ALLOW_EXPORT=1" : "needs MOVEZZ_IMPORT_ENVIRONMENT=staging and MOVEZZ_IMPORT_ALLOW_EXPORT=1");
  }

  return { ok: checks.every((c) => c.ok), environment: APPROVED_CLASSES.includes(cls) ? cls : null, mode: MODES.includes(m) ? m : null, checks };
}

/** Throws ImportRefusal (listing every failed check) unless the environment is approved. Returns the decision otherwise. */
export function assertApprovedEnvironment(input) {
  const d = evaluateEnvironment(input);
  if (!d.ok) {
    const failed = d.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    throw new ImportRefusal(`The importer refuses to run: ${failed.join("; ")}`, d.checks);
  }
  return d;
}
