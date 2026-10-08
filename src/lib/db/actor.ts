// Trusted actor context.
//
// WHO is performing a mutation is established per TRANSACTION by a signed, single-use assertion that PostgreSQL verifies
// (movezz_sec.begin_actor, migration 0010). The database never accepts an actor id from a request body or a session
// variable: without a valid signature, begin_actor fails and every audited mutation fails closed.
//
// Trust boundary: the caller of withActorTransaction() must pass the identity produced by the server's AUTH layer (the
// verified Firebase token resolved to a Movezz user) - never a value taken from request input. The signing key
// (ACTOR_CONTEXT_KEY, per environment) stays in the server environment. Code that holds this key can sign for any user:
// that is the unavoidable limit of a single-service architecture and is documented in DATABASE-ARCHITECTURE.md.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { toDomainError, DomainError } from "./errors";

export type ActorType = "user" | "system" | "integration" | "import";

/** Authenticated identity, as produced by the server's auth layer. */
export interface ActorAssertion {
  type: ActorType;
  /** Movezz users.id. Required for type "user", forbidden otherwise. NOT a role: roles are read from the database. */
  userId?: string;
  /** Correlation id recorded on audit rows (the request id of the HTTP call). Generated when omitted. */
  requestId?: string;
}

export const user = (userId: string, requestId?: string): ActorAssertion => ({ type: "user", userId, requestId });

const ASSERTION_TTL_SECONDS = 60;

/** Reads ACTOR_CONTEXT_KEY (base64, >= 32 bytes). Never logged. */
export function actorKeyFromEnv(): Buffer {
  const raw = process.env.ACTOR_CONTEXT_KEY;
  if (!raw) throw new DomainError("ACTOR_INVALID", "ACTOR_CONTEXT_KEY is not configured");
  const key = Buffer.from(raw, "base64");
  if (key.length < 32) throw new DomainError("ACTOR_INVALID", "ACTOR_CONTEXT_KEY must decode to at least 32 bytes");
  return key;
}

/** Must match movezz_sec.assertion_message(): 'v1|type|user|request|jti|exp'. */
export function assertionMessage(a: { type: string; userId: string | null; requestId: string; jti: string; exp: number }): string {
  return `v1|${a.type}|${a.userId ?? ""}|${a.requestId}|${a.jti}|${a.exp}`;
}

export function mintAssertion(actor: ActorAssertion, key: Buffer, now: Date = new Date()) {
  if ((actor.type === "user") !== (actor.userId !== undefined)) {
    throw new DomainError("ACTOR_INVALID", "A user actor needs a userId; service actors must not have one");
  }
  const requestId = actor.requestId ?? randomUUID();
  const jti = randomBytes(16).toString("hex");              // single use
  const exp = Math.floor(now.getTime() / 1000) + ASSERTION_TTL_SECONDS;
  const userId = actor.userId ?? null;
  const sig = createHmac("sha256", key).update(assertionMessage({ type: actor.type, userId, requestId, jti, exp }), "utf8").digest("hex");
  return { type: actor.type, userId, requestId, jti, exp, sig };
}

/** Establishes the actor for the transaction that `tx` is already inside. Call it FIRST, before any mutation. */
export async function beginActor(tx: Pick<PoolClient, "query">, actor: ActorAssertion, key: Buffer = actorKeyFromEnv()): Promise<void> {
  const a = mintAssertion(actor, key);
  await tx.query("SELECT movezz_sec.begin_actor($1, $2, $3, $4, $5, $6)", [a.type, a.userId, a.requestId, a.jti, a.exp, a.sig]);
}

/**
 * One READ COMMITTED transaction whose every audited write is attributed to the verified `actor`.
 * Commits on success; on ANY error rolls back everything, including the audit rows and status events written inside.
 * The actor lives only for this transaction: it cannot leak to the next request that reuses the pooled connection.
 */
export async function withActorTransaction<T>(
  db: Pool,
  actor: ActorAssertion,
  fn: (tx: PoolClient) => Promise<T>,
  key?: Buffer
): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await beginActor(tx, actor, key);
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

/** The verified actor's user id for the current transaction (null for service actors or when none is set). */
export async function currentActorId(tx: Pick<PoolClient, "query">): Promise<string | null> {
  const { rows } = await tx.query<{ id: string | null }>("SELECT movezz_sec.current_actor_id() AS id");
  return rows[0].id;
}
