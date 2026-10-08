// Typed errors for the database layer. PostgreSQL integrity triggers raise custom SQLSTATEs (class "MV");
// toDomainError() turns them into errors the service/route layer can map to HTTP responses.
export type DomainErrorCode =
  | "FX_RATE_MISSING"
  | "SPECIAL_RATE_NOT_APPLICABLE"
  | "OVERPAYMENT"
  | "IMMUTABLE_RECORD"
  | "INVALID_STATE"
  | "INVALID_INPUT"
  | "ITEM_UNPRICED"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "DUPLICATE"
  | "ACTOR_INVALID"
  | "PRICING_NOT_FOUND"
  | "PRICING_INVALID"
  | "SPECIAL_RATE_NOT_FOUND"
  | "DISCOUNT_NOT_AUTHORIZED"
  | "DISCOUNT_INVALID"
  | "FX_RATE_INVALID"
  | "INVOICE_NOT_FOUND"
  | "INVOICE_ALREADY_CANCELLED"
  | "ACTIVE_PAYMENT_EXISTS"
  | "ITEM_ALREADY_INVOICED"
  | "ITEM_NOT_RELEASABLE"
  | "CARTON_NOT_RELEASABLE"
  | "CANCELLATION_CONFLICT"
  | "NOT_AUTHORIZED"
  | "REGISTRATION_NOT_ELIGIBLE"
  | "RATE_LIMITED"
  | "REGISTRATION_CONFLICT"
  | "INTEGRITY";

export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

const SQLSTATE_MAP: Record<string, DomainErrorCode> = {
  MV001: "FX_RATE_MISSING",
  MV002: "SPECIAL_RATE_NOT_APPLICABLE",
  MV003: "OVERPAYMENT",
  MV004: "IMMUTABLE_RECORD",
  MV005: "INVALID_STATE",
  MV006: "INVALID_INPUT",
  MV007: "ACTOR_INVALID", // no/unknown/inactive/forged/replayed actor
  MV008: "DISCOUNT_NOT_AUTHORIZED", // discount by anyone but a super_admin
  MV009: "PRICING_NOT_FOUND", // no applicable authoritative rate / item / tier
  MV010: "PRICING_INVALID", // zero, negative, missing basis, or a line that disagrees with the authoritative price
  MV013: "REGISTRATION_NOT_ELIGIBLE", // unknown request / no approved registration for this identity (deliberately one answer)
  MV014: "RATE_LIMITED", // database-enforced registration throttle
  MV015: "REGISTRATION_CONFLICT", // an existing account/customer needs explicit super_admin resolution
  MV012: "NOT_AUTHORIZED", // operation reserved for staff (full permission matrix: Phase 7F)
  MV011: "FX_RATE_INVALID", // invoice FX is not the current authoritative USD->GHS rate
  "23505": "DUPLICATE", // unique_violation
  "23503": "INTEGRITY", // foreign_key_violation
  "23514": "INTEGRITY", // check_violation
  "23P01": "DUPLICATE", // exclusion_violation (overlapping active rate windows)
};

export function toDomainError(err: unknown): unknown {
  if (err instanceof DomainError) return err;
  const e = err as { code?: string; message?: string; detail?: string; constraint?: string };
  const code = e?.code ? SQLSTATE_MAP[e.code] : undefined;
  if (!code) return err;
  // Never leak SQL detail (table/column values) to callers; the constraint name is enough for logs.
  const message = e.code?.startsWith("MV") ? String(e.message) : `Integrity rule violated${e.constraint ? ` (${e.constraint})` : ""}`;
  return new DomainError(code, message);
}
