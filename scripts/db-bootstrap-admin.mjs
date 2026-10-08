#!/usr/bin/env node
// Creates the FIRST (or an additional, operator-approved) super_admin in PostgreSQL. Super-admin creation is deliberately not possible through the API.
// The operator creates the Firebase login first (own password / Google); this script only links that verified Firebase uid to a Movezz user.
// It creates no password and never contacts Firebase. Uses the OWNER connection (MIGRATION_DATABASE_URL), never the runtime role.
//   MIGRATION_DATABASE_URL=postgres://... node scripts/db-bootstrap-admin.mjs --email a@b.c --firebase-uid UID --confirm-host HOST [--confirm-database NAME] [--name "Full Name"]
import pg from "pg";
import { assertStagingTarget } from "./lib/migrate.mjs";
import { resolveTarget } from "./lib/target.mjs";

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const url = process.env.MIGRATION_DATABASE_URL;
const email = (arg("--email") ?? "").trim().toLowerCase(), uid = (arg("--firebase-uid") ?? "").trim(), host = arg("--confirm-host"), name = arg("--name") ?? null;
let pool;
try {
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required (the owner connection)");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("--email must be a valid e-mail address");
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new Error("--firebase-uid must be the Firebase uid of the already-created login");
  const resolved = (() => { try { return resolveTarget(url).host; } catch (e) { throw new Error(`Refusing target: ${e.message}`); } })();
  if (host !== resolved) throw new Error(`--confirm-host must equal the database host (${resolved}); nothing was changed`);
  assertStagingTarget({ url, confirmHost: host, confirmDatabase: arg("--confirm-database") });   // loopback passes; a remote target needs host + exact database + staging class + TLS
  pool = new pg.Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {   // the user and its audit record commit together or not at all (no un-audited administrator)
    await c.query("BEGIN");
    const r = await c.query("INSERT INTO users (auth_uid, email, full_name, role) VALUES ($1,$2,$3,'super_admin') RETURNING id", [uid, email, name]);
    await c.query("INSERT INTO audit_logs (actor_type, action, entity_type, entity_id, after_data) VALUES ('system','user.bootstrap_admin','user',$1,$2::jsonb)", [r.rows[0].id, JSON.stringify({ role: "super_admin", email, via: "db-bootstrap-admin" })]);
    await c.query("COMMIT");
    console.log(JSON.stringify({ created: true, userId: r.rows[0].id, role: "super_admin" }));
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
} catch (e) {
  console.error(`refused: ${e.code === "23505" ? "that Firebase uid or e-mail already has a Movezz user" : e.message}`);
  process.exitCode = 1;
} finally { await pool?.end(); }
