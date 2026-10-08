// Registration lifecycle (Phase 7G, D9):  public request -> super_admin approval -> verified activation.
//   pending --approve--> approved --activate--> activated          pending --reject--> rejected
// Every step is a SECURITY DEFINER function in PostgreSQL (migration 0014) running inside ONE actor transaction, so a failure leaves
// no partial customer, user or status. The server never accepts a role, user id, customer id, auth uid, status or actor from a client:
//   - submission and activation run under the server's own `system` actor;
//   - approval / rejection / the admin queue run under the verified super_admin's trusted actor and are authorized in the policy table.
// There are no passwords anywhere in this flow: the applicant creates their own Firebase login (own password or Google) and the server
// only ever sees a VERIFIED ID token.
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withActorTransaction, type ActorAssertion } from "./actor";
import { authorize } from "./authz";
import { DomainError } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The ONLY fields a public registration may carry. Anything else (role, status, customerId, authUid, actor ...) is rejected. */
export const PUBLIC_REGISTRATION_FIELDS = ["name", "email", "phone", "phone2", "existingMark", "location", "notes"] as const;
export interface PublicRegistrationInput {
  name: string; email: string; phone: string; phone2?: string | null; existingMark?: string | null; location: string; notes?: string | null;
}

/** Salted hash of the submitter's address: lets the database throttle one source across server instances without storing the IP. */
export function clientKeyFor(ip: string, pepper: string = process.env.REGISTRATION_THROTTLE_PEPPER ?? "movezz-registration"): string {
  return createHash("sha256").update(`${pepper}|${ip}`).digest("hex").slice(0, 32);
}

/**
 * Creates a registration request. The result is deliberately uninformative: "received" is returned whether the request was stored,
 * ignored because the person already has an account/customer, or ignored because an identical request is already open - so the
 * endpoint cannot be used to find out who is registered. Only a throttle (RATE_LIMITED) or invalid input is reported.
 */
export async function submitRegistration(db: Pool, input: PublicRegistrationInput, clientKey: string | null): Promise<"received"> {
  const extra = Object.keys(input as object).filter((k) => !(PUBLIC_REGISTRATION_FIELDS as readonly string[]).includes(k));
  if (extra.length) throw new DomainError("INVALID_INPUT", "Unexpected fields in the registration request");
  await withActorTransaction(db, { type: "system" }, async (tx) => {
    await tx.query("SELECT movezz_sec.submit_registration($1,$2,$3,$4,$5,$6,$7,$8)", [
      input.name, input.email, input.phone, input.phone2 ?? null, input.existingMark ?? null, input.location, input.notes ?? null, clientKey,
    ]);
  });
  return "received";
}

export interface RegistrationRow {
  id: string; name: string; email: string; phone: string | null; phone2: string | null; existing_mark: string | null; location: string | null;
  notes: string | null; status: string; reviewed_by: string | null; reviewed_at: string | null; rejection_reason: string | null;
  resulting_customer_id: string | null; resulting_user_id: string | null; activated_at: string | null; created_at: string;
}
const COLS = `id, name, email, phone, phone2, existing_mark, location, notes, status, reviewed_by, reviewed_at, rejection_reason,
              resulting_customer_id, resulting_user_id, activated_at, created_at`;
const STATUSES = ["pending", "approved", "rejected", "activated", "cancelled"];

export async function listRegistrations(db: Pool, actor: ActorAssertion, opts: { status?: string; limit?: number } = {}): Promise<RegistrationRow[]> {
  if (opts.status !== undefined && !STATUSES.includes(opts.status)) throw new DomainError("INVALID_INPUT", "Unknown status filter");
  return withActorTransaction(db, actor, async (tx) => {
    await authorize(tx, "registration.admin");
    const { rows } = await tx.query<RegistrationRow>(
      `SELECT ${COLS} FROM registration_requests WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC, id LIMIT $2`,
      [opts.status ?? null, Math.min(Math.max(Number(opts.limit) || 100, 1), 500)]);
    return rows;
  });
}

/** A malformed id and an unknown id are the same answer (null -> 404). */
export async function getRegistration(db: Pool, actor: ActorAssertion, id: string): Promise<RegistrationRow | null> {
  return withActorTransaction(db, actor, async (tx) => {
    await authorize(tx, "registration.admin");
    if (!UUID.test(id)) return null;
    return (await tx.query<RegistrationRow>(`SELECT ${COLS} FROM registration_requests WHERE id = $1`, [id])).rows[0] ?? null;
  });
}

export async function approveRegistration(db: Pool, actor: ActorAssertion, id: string): Promise<{ customerId: string }> {
  return withActorTransaction(db, actor, async (tx) => {
    await authorize(tx, "registration.admin");
    if (!UUID.test(id)) throw new DomainError("REGISTRATION_NOT_ELIGIBLE", "Registration request not found");
    const { rows } = await tx.query<{ c: string }>("SELECT movezz_sec.approve_registration($1) AS c", [id]);
    return { customerId: rows[0].c };
  });
}

export async function rejectRegistration(db: Pool, actor: ActorAssertion, id: string, reason: string): Promise<void> {
  await withActorTransaction(db, actor, async (tx) => {
    await authorize(tx, "registration.admin");
    if (!UUID.test(id)) throw new DomainError("REGISTRATION_NOT_ELIGIBLE", "Registration request not found");
    await tx.query("SELECT movezz_sec.reject_registration($1,$2)", [id, reason]);
  });
}

/** A Firebase identity as the SERVER verified it (verifyIdToken). Never build this from request fields. */
export interface VerifiedIdentity { uid: string; email?: string | null; emailVerified: boolean }

/**
 * Activates the approved registration that belongs to a verified Firebase identity: creates the customer login. Idempotent for the
 * same identity. Every ineligible case (no request, not approved, rejected, other identity, unverified e-mail) is the same
 * REGISTRATION_NOT_ELIGIBLE, so the endpoint reveals nothing about other people's requests.
 */
export async function activateRegistration(db: Pool, identity: VerifiedIdentity): Promise<{ userId: string; customerId: string; alreadyActive: boolean }> {
  if (!identity.uid || !identity.email || identity.emailVerified !== true) throw new DomainError("REGISTRATION_NOT_ELIGIBLE", "No approved registration for this account");
  return withActorTransaction(db, { type: "system" }, async (tx) => {
    const { rows } = await tx.query<{ user_id: string; customer_id: string; already_active: boolean }>(
      "SELECT * FROM movezz_sec.activate_registration($1,$2,$3)", [identity.uid, identity.email, identity.emailVerified]);
    return { userId: rows[0].user_id, customerId: rows[0].customer_id, alreadyActive: rows[0].already_active };
  });
}
