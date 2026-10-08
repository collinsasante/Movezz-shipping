// Authorization policy (Phase 7F). The security boundary is:
//   verified identity -> trusted actor (movezz_sec.begin_actor, 0010) -> role / customer link read from `users` FOR THIS TRANSACTION
//   -> operation policy (this file) -> service -> repository (ownership predicates in SQL) -> PostgreSQL (guards, RLS, grants).
// The role is never an argument: it is read back from the database session that begin_actor established. Roles claimed by a
// client, a token claim or a request body never reach this module.
import type { Queryable } from "./client";
import { DomainError } from "./errors";

export type Role = "super_admin" | "warehouse_staff" | "customer";

export interface ActorContext {
  type: "user" | "system" | "integration" | "import";
  userId: string | null;
  role: Role | null;
  customerId: string | null;
}

const A: Role = "super_admin", S: Role = "warehouse_staff", C: Role = "customer";

/**
 * The final role matrix for the PostgreSQL layer (docs/DECISIONS.md D6, D7, D16, D23, A4).
 * An operation absent from this table is denied. Service identities (system / integration / import) are never "users":
 * they may use only the operations listed in SERVICE_OPERATIONS.
 */
export const POLICY = {
  // financial: super_admin only (staff are operational users, D6)
  "invoice.create": [A],
  "invoice.discount": [A],
  "invoice.cancel": [A],
  "payment.create": [A],
  "payment.void": [A],
  "report.financial": [A],
  "keepup.sync.manual": [A],
  // administration: super_admin only
  "rates.admin": [A],            // package rates, special rates, FX
  "warehouse.admin": [A],
  "supplier.admin": [A],
  "user.admin": [A],
  "registration.admin": [A],     // list / view / approve / reject registration requests
  "customer.admin": [A],         // name, phone, email, shipping mark, tier, warehouse, status
  // operational: staff and admin
  "item.price": [A, S],
  "item.read.any": [A, S],
  "carton.read.any": [A, S],
  "customer.read.any": [A, S],
  // customer-facing (ownership enforced in SQL by the repositories and by row-level security)
  "item.read.own": [C],
  "carton.read.own": [C],
  "invoice.read.any": [A],
  "invoice.read.own": [C],
  "customer.update_self": [C],   // address and notes only (D7)
} as const satisfies Record<string, readonly Role[]>;

export type Operation = keyof typeof POLICY;

/** Operations a service identity may perform (the worker, the importer). Everything else is denied to them. */
export const SERVICE_OPERATIONS: Partial<Record<ActorContext["type"], readonly Operation[]>> = {
  integration: ["keepup.sync.manual"],
  system: [],
  import: [],
};

/** The verified actor of the current transaction, as PostgreSQL recorded it. Throws ACTOR_INVALID when there is none. */
export async function getActorContext(tx: Queryable): Promise<ActorContext> {
  const { rows } = await tx.query<{ actor_type: ActorContext["type"]; user_id: string | null; role: Role | null; customer_id: string | null }>(
    "SELECT actor_type, user_id, role, customer_id FROM movezz_sec.actor_context()");
  const r = rows[0];
  if (!r) throw new DomainError("ACTOR_INVALID", "An authenticated actor is required");
  return { type: r.actor_type, userId: r.user_id, role: r.role, customerId: r.customer_id };
}

export function isAllowed(ctx: ActorContext, op: Operation): boolean {
  if (ctx.type !== "user") return (SERVICE_OPERATIONS[ctx.type] ?? []).includes(op);
  if (!ctx.role) return false;
  // a customer login with no customer link is never "all customers": fail closed
  if (ctx.role === "customer" && !ctx.customerId) return false;
  return ((POLICY as Record<string, readonly Role[]>)[op] ?? []).includes(ctx.role);   // an unknown operation is denied
}

/** Authorizes `op` for the verified actor of this transaction and returns the context. NOT_AUTHORIZED otherwise. */
export async function authorize(tx: Queryable, op: Operation): Promise<ActorContext> {
  const ctx = await getActorContext(tx);
  if (!isAllowed(ctx, op)) throw new DomainError("NOT_AUTHORIZED", "You are not allowed to perform this operation");
  return ctx;
}
