import type { Queryable } from "./client";

export type ReferenceType = "item" | "invoice" | "supplier" | "carton";

/**
 * Allocates the next reference (ITM-0001, ORD-00001, PMX-CON-2026-001, SUP-0001, CTN-0001) inside the caller's
 * transaction. Concurrent callers of the same type are serialised by the counter row lock, so numbers are unique.
 * The runtime role cannot touch the counters directly; it can only call these SECURITY DEFINER functions.
 */
export async function allocateReference(db: Queryable, type: ReferenceType): Promise<string> {
  const { rows } = await db.query<{ ref: string }>("SELECT allocate_reference($1) AS ref", [type]);
  return rows[0].ref;
}

/**
 * Next container reference, PMX-CON-<year>-<NNN>. The year is the container's creation year and is only printed; the
 * sequence is GLOBAL and never restarts (docs/DECISIONS.md D1).
 */
export async function allocateContainerReference(db: Queryable, year?: number): Promise<string> {
  const { rows } = await db.query<{ ref: string }>(
    year === undefined ? "SELECT allocate_container_reference() AS ref" : "SELECT allocate_container_reference($1) AS ref",
    year === undefined ? [] : [year]
  );
  return rows[0].ref;
}
