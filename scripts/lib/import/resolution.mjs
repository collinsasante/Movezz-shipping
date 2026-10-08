// Smallest safe quarantine-resolution service (CLI/service only, no UI). It only RECORDS a decision in an append-only table;
// it never edits imported data, source data or the original quarantine row, and it fails closed on any missing input.
import { ImportRefusal } from "./errors.mjs";

const KINDS = ["excluded", "corrected_in_new_snapshot"];

/** Quarantine rows with their resolution (if any). @param {{unresolvedOnly?: boolean, batchId?: string}} opts */
export async function listQuarantine(pool, { unresolvedOnly = false, batchId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT q.id, q.batch_id, q.source_table, q.source_id, q.category, q.severity, q.reason, q.field,
            r.resolution, r.reason AS resolution_reason, r.resolved_by, r.resolved_at
       FROM import_quarantine q LEFT JOIN import_quarantine_resolutions r ON r.quarantine_id = q.id
      WHERE ($1::uuid IS NULL OR q.batch_id = $1) AND (NOT $2 OR r.id IS NULL)
      ORDER BY q.id`, [batchId, unresolvedOnly]);
  return rows;
}

/** Counts by severity of quarantine rows that have no resolution: the number that must be zero (or accepted) before cutover. */
export async function unresolvedSummary(pool) {
  const { rows } = await pool.query(
    `SELECT q.severity, count(*)::int AS n FROM import_quarantine q
      WHERE NOT EXISTS (SELECT 1 FROM import_quarantine_resolutions r WHERE r.quarantine_id = q.id) GROUP BY q.severity ORDER BY q.severity`);
  return Object.fromEntries(rows.map((r) => [r.severity, r.n]));
}

/** Records ONE resolution. Throws ImportRefusal on invalid input; the database refuses duplicates, updates and deletes. */
/** @param {import("pg").Pool} pool @param {{quarantineId:number, resolution:string, reason:string, resolvedBy:string, newSnapshotFingerprint?:string|null, details?:object|null}} input */
export async function resolveQuarantine(pool, { quarantineId, resolution, reason, resolvedBy, newSnapshotFingerprint = null, details = null }) {
  if (!Number.isSafeInteger(quarantineId) || quarantineId <= 0) throw new ImportRefusal("quarantine id must be a positive integer");
  if (!KINDS.includes(resolution)) throw new ImportRefusal(`resolution must be one of ${KINDS.join(", ")}`);
  if (typeof reason !== "string" || reason.trim().length < 10) throw new ImportRefusal("an explicit resolution reason (at least 10 characters) is required");
  if (typeof resolvedBy !== "string" || !resolvedBy.trim()) throw new ImportRefusal("--resolved-by is required (who decided)");
  if ((resolution === "corrected_in_new_snapshot") !== (newSnapshotFingerprint !== null)) {
    throw new ImportRefusal("corrected_in_new_snapshot requires the new snapshot fingerprint, and excluded must not carry one");
  }
  const { rows } = await pool.query(
    `INSERT INTO import_quarantine_resolutions (quarantine_id, resolution, reason, new_snapshot_fingerprint, details, resolved_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, resolved_at`,
    [quarantineId, resolution, reason.trim(), newSnapshotFingerprint, details === null ? null : JSON.stringify(details), resolvedBy.trim()]);
  return rows[0];
}
