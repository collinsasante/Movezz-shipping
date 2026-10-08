// STAGING-ONLY connectivity probe: Cloudflare Worker -> PostgreSQL -> one read-only SELECT. It is a separate Worker (not the Movezz app) and runs no
// destructive SQL. DATABASE_URL must be a STAGING database; the Worker refuses obviously production-looking names. Nothing secret is ever logged or returned.
import pg from "pg";

// Module-level pools, as the Movezz app's getPool() singleton: "reuse" keeps connections across requests (what Node does), "fresh" never reuses one (maxUses: 1).
const pools = {};
const poolFor = (url, mode) => (pools[mode] ??= new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, ...(mode === "fresh" ? { maxUses: 1, idleTimeoutMillis: 1 } : {}) }));

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const url = env.DATABASE_URL ?? "";
    const u = new URL(request.url);
    if (u.pathname === "/pool") {
      try {
        const mode = u.searchParams.get("mode") === "reuse" ? "reuse" : "fresh";
        const r = await poolFor(env.DATABASE_URL ?? "", mode).query("SELECT 1 AS ok");
        return Response.json({ ok: r.rows[0].ok === 1, mode, requestId });
      } catch (e) { return Response.json({ ok: false, error: "pool_failed", code: e && e.code ? String(e.code) : "unknown", requestId }, { status: 502 }); }
    }
    if (u.pathname !== "/probe") return Response.json({ ok: false, error: "not_found", requestId }, { status: 404 });
    if (!url || /(^|[^a-z])(prod|production|live)([^a-z]|$)/i.test(url)) return Response.json({ ok: false, error: "refused_non_staging_target", requestId }, { status: 400 });
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
    const started = Date.now();
    try {
      await client.connect();
      const r = await client.query("SELECT 1 AS ok, current_setting('transaction_read_only') AS read_only, (SELECT count(*)::int FROM pg_catalog.pg_tables WHERE schemaname = 'public') AS public_tables");
      console.log(JSON.stringify({ event: "probe.ok", requestId, ms: Date.now() - started }));
      return Response.json({ ok: r.rows[0].ok === 1, publicTables: r.rows[0].public_tables, ms: Date.now() - started, requestId });
    } catch (e) {
      console.log(JSON.stringify({ event: "probe.failed", requestId, code: e && e.code ? String(e.code) : "unknown", ms: Date.now() - started }));   // no message: it may echo connection details
      return Response.json({ ok: false, error: "connect_failed", code: e && e.code ? String(e.code) : "unknown", requestId }, { status: 502 });
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  },
};
