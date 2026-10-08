// Single, strict reading of a database URL for every operator guard. The guards must judge the SAME host/database/TLS settings that `pg`
// will really use, so this resolves the URL with pg's own parser (a `?host=` query parameter silently overrides the URL's host there) and
// refuses anything where the two readings disagree or where the target is ambiguous (empty host, several hosts, unix socket, hostaddr,
// service files, connection options, libpq-compat or no-verify TLS modes).
import ConnectionParameters from "pg/lib/connection-parameters.js";

export class TargetError extends Error {}
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const REJECTED_PARAMS = ["hostaddr", "service", "options", "passfile", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat", "target_session_attrs"];

/** @returns {{ host: string, database: string, user: string|null, local: boolean, tlsVerified: boolean, sslmode: string|null }} */
export function resolveTarget(url, env = process.env) {
  if (typeof url !== "string" || !url) throw new TargetError("no database URL");
  let u;
  try { u = new URL(url); } catch { throw new TargetError("the database URL is not a valid URL"); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new TargetError("the database URL must use postgres://");
  for (const k of REJECTED_PARAMS) if (u.searchParams.has(k)) throw new TargetError(`the URL parameter "${k}" is not allowed (it changes where or how the connection is made)`);
  const urlHost = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const urlDb = decodeURIComponent(u.pathname.replace(/^\//, ""));
  let p;
  try { p = new ConnectionParameters(url); } catch { throw new TargetError("the database URL could not be interpreted"); }
  const host = String(p.host ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host.includes(",") || host.startsWith("/")) throw new TargetError("the URL must name exactly one network host (no empty host, host list or socket path)");
  if (host !== urlHost) throw new TargetError("the URL host and the connection host differ (a ?host= parameter overrides the URL host); refusing");
  if (!urlDb) throw new TargetError("the URL must name the database");
  if (p.database !== urlDb) throw new TargetError("the URL database and the connection database differ; refusing");
  const sslmode = u.searchParams.get("sslmode");
  const local = LOOPBACK_HOSTS.has(host);
  // TLS counts as VERIFIED only for sslmode=verify-full with certificate checking left on, in this process and in pg.
  const ssl = p.ssl;
  const tlsVerified = sslmode === "verify-full" && Boolean(ssl) && ssl.rejectUnauthorized !== false && env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";
  return { host, database: urlDb, user: u.username ? decodeURIComponent(u.username) : null, local, tlsVerified, sslmode };
}
