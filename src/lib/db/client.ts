// PostgreSQL access: the plain `pg` driver, no ORM. All SQL lives in small repository functions that take a
// Queryable (the pool or a transaction client) so every multi-step operation can run inside ONE transaction.
//
// Credentials: DATABASE_URL is the RUNTIME role (movezz_app: DML only). Migrations use MIGRATION_DATABASE_URL and
// never run through this module. Neither value is logged or hard-coded.
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { toDomainError } from "./errors";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

let pool: Pool | undefined;

export function createPool(connectionString: string, opts: { max?: number; ssl?: boolean } = {}): Pool {
  return new Pool({
    connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: true } : undefined, // production: TLS with certificate verification
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
  });
}

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = createPool(url, { ssl: process.env.DATABASE_SSL === "true" });
  }
  return pool;
}

/** Test hook: replaces (or clears) the process-wide pool so route handlers can be exercised against a test database. */
export function setPoolForTests(p: Pool | undefined): void {
  pool = p;
}

/** Runs `fn` in one READ COMMITTED transaction; commits on success, rolls back on any error. */
export async function withTransaction<T>(db: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => {});
    throw toDomainError(err);
  } finally {
    tx.release();
  }
}
