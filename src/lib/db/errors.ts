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
