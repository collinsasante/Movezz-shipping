// Helpers for the PostgreSQL integration tests: a fresh, empty, migrated database per test file.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";
import { beginActor, type ActorAssertion } from "../../src/lib/db/actor";
import { migrate } from "../../scripts/lib/migrate.mjs";

export const ADMIN_URL = process.env.MOVEZZ_TEST_PG_URL;
if (!ADMIN_URL) console.warn("[db-tests] MOVEZZ_TEST_PG_URL is not set: PostgreSQL integration tests are SKIPPED (run scripts/db-local.sh start)");
else {
  const host = new URL(ADMIN_URL).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`Refusing to run destructive test setup against non-local host ${host}`);
}
/** describe() that is skipped when no test PostgreSQL is configured. */
export const dbDescribe = ADMIN_URL ? describe : describe.skip;

/** TEST-ONLY signing key (also set as ACTOR_CONTEXT_KEY in vitest.db.config.mts). Never used outside disposable test databases. */
export const TEST_ACTOR_KEY_B64 = Buffer.alloc(32, 0x5a).toString("base64");
export const TEST_ACTOR_KEY = Buffer.from(TEST_ACTOR_KEY_B64, "base64");

const APP_ROLE = "movezz_app";
const APP_PASSWORD = "test-only-app-role-password"; // local throwaway server only

export interface TestDb {
  name: string;
  /** superuser/owner connection pool (what migrations and fixtures use) */
  admin: pg.Pool;
  /** pool connected as the least-privilege runtime role */
  app: pg.Pool;
  appUrl: string;
  adminUrl: string;
  close(): Promise<void>;
}

async function ensureRole(root: pg.Pool) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rowCount } = await root.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE]);
      if (!rowCount) await root.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${APP_PASSWORD}'`);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "42710" || code === "23505" || code === "XX000") continue; // another file created it first
      throw e;
    }
  }
}

export async function createTestDb(): Promise<TestDb> {
  const name = `mvz_test_${randomBytes(6).toString("hex")}`;
  const root = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await ensureRole(root);
  await root.query(`CREATE DATABASE ${name}`);
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${name}`;
  const adminUrl = u.toString();
  await migrate(adminUrl);
  {
    const p = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await p.query("SELECT movezz_sec.set_actor_key($1)", [TEST_ACTOR_KEY]);
    await p.end();
  }
  const a = new URL(adminUrl);
  a.username = APP_ROLE;
  a.password = APP_PASSWORD;
  const appUrl = a.toString();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 20 });
  const app = new pg.Pool({ connectionString: appUrl, max: 20 });
  // an idle pooled connection may be terminated when the test database is dropped; that is not a test failure
  admin.on("error", () => {}); app.on("error", () => {});
  return {
    name, admin, app, appUrl, adminUrl,
    async close() {
      await app.end();
      await admin.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    },
  };
}

// ---- fixtures (plain SQL through the owner pool) -------------------------------------------------------------
let seq = 0;
const n = () => ++seq;
type Q = Pick<pg.Pool, "query">;

export async function customer(db: Q, over: Partial<{ name: string; mark: string; tier: string; phone: string; email: string }> = {}) {
  const i = n();
  const r = await db.query(
    `INSERT INTO customers (name, phone, email, shipping_mark, package_tier) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [over.name ?? `Customer ${i}`, over.phone ?? `0244${String(100000 + i)}`, over.email ?? `c${i}@example.invalid`, over.mark ?? `MOVEZZ-T${i}`, over.tier ?? "basic"]
  );
  return r.rows[0].id as string;
}

export async function staffUser(db: Q, role: "super_admin" | "warehouse_staff" = "super_admin") {
  const i = n();
  const r = await db.query(`INSERT INTO users (auth_uid, email, role) VALUES ($1,$2,$3) RETURNING id`, [`uid-${i}`, `u${i}@example.invalid`, role]);
  return r.rows[0].id as string;
}

let fxSeq = 0;
/** Inserts a USD->GHS rate. By default it is effective "just now" and later calls win, so the newest call is the current rate. */
export async function fxRate(db: Q, rate = "12.50000000", at: string = new Date(Date.now() - 600_000 + ++fxSeq).toISOString()) {
  const r = await db.query(`INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at) VALUES ('USD','GHS',$1,'test',$2) RETURNING id`, [rate, at]);
  return r.rows[0].id as string;
}

export async function packageRates(db: Q, tier = "basic", sea = "350", air = "8") {
  await db.query(`INSERT INTO package_rates (tier, freight_type, rate_usd) VALUES ($1,'sea',$2), ($1,'air',$3)`, [tier, sea, air]);
}

/** A priced tier item (sea, 1 m3 by default) */
export async function item(db: Q, customerId: string, over: Record<string, unknown> = {}) {
  const i = n();
  const cols: Record<string, unknown> = {
    item_ref: `ITM-T${i}`, customer_id: customerId, description: `Box ${i}`, freight_type: "sea",
    length: 100, width: 100, height: 100, dimension_unit: "cm", quantity: 1, package_tier: "basic", tier_rate_usd: 350, tier_price_usd: 350,
    ...over,
  };
  const keys = Object.keys(cols);
  const r = await db.query(`INSERT INTO items (${keys.join(",")}) VALUES (${keys.map((_, k) => `$${k + 1}`).join(",")}) RETURNING id`, keys.map((k) => cols[k]));
  return r.rows[0].id as string;
}

export async function carton(db: Q, customerId: string, over: Record<string, unknown> = {}) {
  const i = n();
  const cols: Record<string, unknown> = {
    carton_ref: `CTN-T${i}`, customer_id: customerId, freight_type: "sea", length: 100, width: 100, height: 50, package_tier: "basic", rate_usd: 350, price_usd: 175, ...over,
  };
  const keys = Object.keys(cols);
  const r = await db.query(`INSERT INTO cartons (${keys.join(",")}) VALUES (${keys.map((_, k) => `$${k + 1}`).join(",")}) RETURNING id`, keys.map((k) => cols[k]));
  return r.rows[0].id as string;
}

export async function specialRate(db: Q, over: Record<string, unknown> = {}) {
  const i = n();
  const cols: Record<string, unknown> = { name: `Card ${i}`, sea_rate_usd: 300, air_rate_usd: 6, ...over };
  const keys = Object.keys(cols);
  const r = await db.query(`INSERT INTO special_rates (${keys.join(",")}) VALUES (${keys.map((_, k) => `$${k + 1}`).join(",")}) RETURNING id`, keys.map((k) => cols[k]));
  return r.rows[0].id as string;
}

/** Runs a query expected to fail and returns the SQLSTATE (or "OK" when it unexpectedly succeeds). */
export async function sqlstate(p: Promise<unknown>): Promise<string> {
  try { await p; return "OK"; } catch (e) { return (e as { code?: string }).code ?? "ERR"; }
}

/** An EMPTY database (no migrations applied) for upgrade-path tests. */
export async function createBareTestDb() {
  const name = `mvz_test_${randomBytes(6).toString("hex")}`;
  const root = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await ensureRole(root);
  await root.query(`CREATE DATABASE ${name}`);
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${name}`;
  const url = u.toString();
  const admin = new pg.Pool({ connectionString: url, max: 5 });
  admin.on("error", () => {});
  return {
    name, url, admin,
    async close() { await admin.end(); await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await root.end(); },
  };
}

/**
 * A `query` that runs each statement in its own transaction under a verified actor (owner pool; default an 'import' actor),
 * for raw fixtures/assertions on tables whose triggers require an actor (invoices, payments, idempotency keys).
 * Errors are rethrown UNCHANGED so tests can assert the raw SQLSTATE.
 */
export function actorQuery(pool: pg.Pool, actor: ActorAssertion = { type: "import" }) {
  return {
    async query(sql: string, params?: unknown[]) {
      const cl = await pool.connect();
      try {
        await cl.query("BEGIN");
        await beginActor(cl, actor, TEST_ACTOR_KEY);
        const r = await cl.query(sql, params);
        await cl.query("COMMIT");
        return r;
      } catch (e) {
        await cl.query("ROLLBACK").catch(() => {});
        throw e;
      } finally { cl.release(); }
    },
  };
}
