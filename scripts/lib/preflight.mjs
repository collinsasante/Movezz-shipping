// Read-only staging preflight. Collects every prerequisite of docs/STAGING-CHECKLIST.md that can be checked without writing anything,
// and reports each as PASS | FAIL | BLOCKED (an input the owner must supply) | NOT_RUN. It never prints a secret, never writes to the
// database (all sessions are read-only), never contacts Airtable/Firebase/Keepup/Cloudinary/Cloudflare, and never "passes" a check it
// could not actually perform.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateEnvironment } from "./import/env-guard.mjs";
import { parseSnapshotText, snapshotFingerprint } from "./import/index.mjs";
import { loadMigrations } from "./migrate.mjs";

export const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const toolOk = (cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0;

/**
 * @param {{ env?: Record<string,string|undefined>, cwd?: string, ownerUrl?: string, runtimeUrl?: string, snapshotPath?: string, expectFingerprint?: string,
 *           connect?: (url: string) => Promise<{ query: Function, end: Function }>, tools?: (cmd: string) => boolean, repoRoot?: string }} o
 */
export async function runPreflight({ env = process.env, cwd = process.cwd(), ownerUrl, runtimeUrl, snapshotPath, expectFingerprint, connect, tools = toolOk, repoRoot = cwd } = {}) {
  const out = [];
  const add = (id, status, detail) => out.push({ id, status, detail });

  // 1 environment guard (same rules as the importer; mode is read-only)
  const g = evaluateEnvironment({ env, targetUrl: ownerUrl, mode: "reconcile", snapshotKind: snapshotPath ? "export" : undefined });
  for (const c of g.checks) add(`guard: ${c.name}`, c.ok ? "PASS" : (ownerUrl ? "FAIL" : "BLOCKED"), c.detail);
  const airtable = Object.keys(env).filter((k) => /^AIRTABLE_/i.test(k) && env[k]);
  add("Airtable variables absent from this shell", airtable.length ? "FAIL" : "PASS", airtable.length ? `present (names only): ${airtable.join(", ")}` : "none");

  // 2 TLS requirement in the URLs
  const u = ownerUrl ? new URL(ownerUrl) : null;
  const remote = u && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname.toLowerCase());
  if (!u) add("staging database URL (IMPORT_DATABASE_URL)", "BLOCKED", "not provided: staging host and exact database name are needed");
  else if (remote) add("URL requests TLS (sslmode=require|verify-ca|verify-full)", ["require", "verify-ca", "verify-full"].includes(u.searchParams.get("sslmode") ?? "") ? "PASS" : "FAIL", `sslmode=${u.searchParams.get("sslmode") ?? "(none)"}`);
  else add("URL requests TLS", "NOT_RUN", "loopback target: TLS is only required for remote staging");

  // 3 database state (read-only)
  if (u && connect) {
    let c;
    try {
      c = await connect(ownerUrl);
      const q = async (sql, p) => (await c.query(sql, p)).rows;
      const me = (await q("SELECT current_user AS u, current_database() AS d, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su"))[0];
      add("owner connection reaches the named database", me.d === decodeURIComponent(u.pathname.slice(1)) ? "PASS" : "FAIL", `database=${me.d}`);
      add("owner role is not a superuser", me.su ? "FAIL" : "PASS", `role=${me.u}`);
      if (remote) { const ssl = (await q("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"))[0]?.ssl; add("connection is actually encrypted", ssl === true ? "PASS" : "FAIL", `ssl=${ssl}`); }
      const app = (await q("SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = 'movezz_app'"))[0];
      if (!app) add("runtime role movezz_app exists", "FAIL", "missing: create it before running grants");
      else add("runtime role is unprivileged (no superuser/createrole/createdb/bypassrls)", app.rolsuper || app.rolcreaterole || app.rolcreatedb || app.rolbypassrls ? "FAIL" : "PASS", "movezz_app");
      if (me.u === "movezz_app") add("owner and runtime roles are different", "FAIL", "the owner connection uses the runtime role");
      else add("owner and runtime roles are different", "PASS", `owner=${me.u}`);
      const hasMig = (await q("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS t"))[0].t;
      const mig = await loadMigrations(); const files = mig.map((m) => m.name);
      if (!hasMig) {
        const tables = (await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"))[0].n;
        add("database is empty before the first migration", tables === 0 ? "PASS" : "FAIL", `${tables} existing tables`);
      } else {
        const rowsApplied = await q("SELECT name, checksum FROM schema_migrations ORDER BY version");
        const applied = rowsApplied.map((r) => r.name);
        const edited = rowsApplied.filter((r) => mig.find((m) => m.name === r.name && m.checksum !== r.checksum)).map((r) => r.name);
        add("applied migrations match the repository's files byte for byte (checksums)", edited.length ? "FAIL" : "PASS", edited.length ? `edited after being applied: ${edited.join(", ")}` : "identical");
        const unknown = applied.filter((n) => !files.includes(n)); const pending = files.filter((n) => !applied.includes(n));
        add("applied migrations are a prefix of the repository's migrations", unknown.length === 0 && files.slice(0, applied.length).join() === applied.join() ? "PASS" : "FAIL", `applied=${applied.length}/${files.length}${unknown.length ? ` unknown=${unknown.join(",")}` : ""}`);
        add("pending migrations", "PASS", pending.length ? `${pending.length} to apply` : "none");
        if (applied.length === files.length) {
          const act = (await q("SELECT count(*)::int AS n FROM movezz_sec.actor_keys"))[0].n;
          add("actor signing key provisioned (required before the app runs)", act > 0 ? "PASS" : "BLOCKED", `${act} key(s)`);
        }
      }
    } catch (e) { add("owner connection", "FAIL", String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "[url]").slice(0, 200)); }
    finally { await c?.end?.().catch(() => {}); }
  } else if (u) add("database state checks", "NOT_RUN", "no connection function supplied");
  if (runtimeUrl && connect) {
    let c;
    try {
      c = await connect(runtimeUrl);
      const me = (await c.query("SELECT current_user AS u")).rows[0].u;
      add("runtime connection uses movezz_app", me === "movezz_app" ? "PASS" : "FAIL", `role=${me}`);
      const canCreate = (await c.query("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ok")).rows[0].ok;
      add("runtime role cannot create objects", canCreate ? "FAIL" : "PASS", "public schema");
    } catch (e) { add("runtime connection", "FAIL", String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "[url]").slice(0, 200)); }
    finally { await c?.end?.().catch(() => {}); }
  } else add("runtime role connection (DATABASE_URL as movezz_app)", runtimeUrl ? "NOT_RUN" : "BLOCKED", runtimeUrl ? "no connection function" : "not provided");

  // 4 export + fingerprint
  if (!snapshotPath) add("export snapshot", "BLOCKED", "no authorised export provided (--snapshot)");
  else {
    const p = path.resolve(cwd, snapshotPath);
    if (!p.startsWith(cwd + path.sep)) add("export snapshot is inside the working directory", "FAIL", "path escapes the working directory");
    else if (!existsSync(p)) add("export snapshot exists", "FAIL", "file not found");
    else if (statSync(p).size > MAX_SNAPSHOT_BYTES) add("export snapshot size", "FAIL", "larger than the importer limit");
    else {
      const inRepo = path.relative(repoRoot, p) && !path.relative(repoRoot, p).startsWith("..");
      add("export snapshot is not a tracked repository path", inRepo ? "FAIL" : "PASS", inRepo ? "keep exports outside the repository tree (git-ignored paths only)" : "outside the repository");
      if (!expectFingerprint) add("exporter-recorded fingerprint", "BLOCKED", "--expect-fingerprint is required for a real export; never compute it from the file you are verifying");
      else {
        try {
          const actual = snapshotFingerprint(parseSnapshotText(readFileSync(p, "utf8")));
          add("snapshot fingerprint equals the exporter's recorded value", actual === expectFingerprint ? "PASS" : "FAIL", actual === expectFingerprint ? "match" : "MISMATCH: do not import");
        } catch (e) { add("snapshot parses", "FAIL", String(e.message).slice(0, 200)); }
      }
    }
  }

  // 5 tooling, backup destination, optional integrations (names/booleans only)
  for (const t of ["pg_dump", "pg_restore", "psql"]) add(`tool: ${t}`, tools(t) ? "PASS" : "FAIL", "");
  add("tool: age or gpg (encrypted backups)", tools("age") || tools("gpg") ? "PASS" : "FAIL", "");
  const bd = env.MOVEZZ_BACKUP_DIR;
  if (!bd) add("backup destination (MOVEZZ_BACKUP_DIR)", "BLOCKED", "an encrypted backup destination outside the repository is needed");
  else { const abs = path.resolve(cwd, bd); add("backup destination is outside the repository and exists", !abs.startsWith(repoRoot + path.sep) && existsSync(abs) ? "PASS" : "FAIL", abs.startsWith(repoRoot + path.sep) ? "inside the repository" : existsSync(abs) ? "ok" : "does not exist"); }
  add("Cloudinary TEST cloud for photo re-hosting", env.MOVEZZ_REHOST_CLOUDINARY_URL && env.MOVEZZ_REHOST_CONFIRM_CLOUD ? "PASS" : "BLOCKED", env.MOVEZZ_REHOST_CLOUDINARY_URL ? "credentials and cloud confirmation present" : "not provided (needed for checklist step 6a)");
  add("staging Cloudflare / Firebase / Keepup resources", "NOT_RUN", "cannot be verified from the repository; checklist steps 9-10 need the owner's staging accounts");

  const count = (s) => out.filter((r) => r.status === s).length;
  return { verdict: count("FAIL") ? "FAIL" : count("BLOCKED") ? "BLOCKED" : "READY", pass: count("PASS"), fail: count("FAIL"), blocked: count("BLOCKED"), notRun: count("NOT_RUN"), checks: out };
}
