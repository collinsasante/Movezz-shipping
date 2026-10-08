import type { Queryable } from "./client";

export type ReferenceType = "item" | "invoice" | "container" | "supplier" | "carton";

/**
 * Allocates the next reference (ITM-0001, ORD-00001, PMX-CON-2026-001, SUP-0001, CTN-0001) inside the caller's
 * transaction. Concurrent callers of the same type are serialised by the counter row lock, so numbers are unique.
 * Containers need the 4-digit year as scope; the sequence restarts each year.
 */
export async function allocateReference(db: Queryable, type: ReferenceType, scope = ""): Promise<string> {
  const { rows } = await db.query<{ ref: string }>("SELECT allocate_reference($1, $2) AS ref", [type, scope]);
  return rows[0].ref;
}
