// Orchestration of the independent stages. Each stage is exported and tested on its own; this file only wires them together.
//   readSnapshotFile -> discover -> normalizeAll -> validateAll -> (target pre-check) -> runImport -> reconcile -> buildReport
import { assertApprovedEnvironment } from "./env-guard.mjs";
import { runImport, readTargetState, applyTargetState } from "./execute.mjs";
import { KNOWN_FIELDS } from "./normalize.mjs";
import { reconcile } from "./reconcile.mjs";
import { buildReport } from "./report.mjs";
import { discover, snapshotFingerprint } from "./snapshot.mjs";
import { collectEntries, normalizeAll, validateAll } from "./validate.mjs";

export * from "./snapshot.mjs";
export { databaseSignature } from "./reconcile.mjs";
export * from "./validate.mjs";
export { assertApprovedEnvironment, evaluateEnvironment } from "./env-guard.mjs";
export { reportToJson, renderReport } from "./report.mjs";

/**
 * Stages 2-5 without any database. Pure and deterministic.
 * @param {any} snapshot
 * @returns {{ discovery: any, st: any, fingerprint: string }}
 */
export function prepare(snapshot) {
  const discovery = discover(snapshot, KNOWN_FIELDS);
  const st = validateAll(normalizeAll(snapshot));
  return { discovery, st, fingerprint: snapshotFingerprint(snapshot) };
}

/**
 * DRY RUN. Reads the snapshot and (optionally) the target in a READ ONLY transaction; writes nothing anywhere.
 * @param {{ snapshot: any, pool?: any, env?: Record<string,string|undefined>, targetUrl?: string }} a
 * @returns {Promise<any>}
 */
export async function dryRun({ snapshot, pool, env = process.env, targetUrl }) {
  const decision = assertApprovedEnvironment({ env, targetUrl: pool ? targetUrl : (targetUrl ?? "postgres://localhost/offline"), mode: "dry-run", snapshotKind: snapshot.source.kind });
  const p = prepare(snapshot);
  let target = null;
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      target = await readTargetState(client, p.st);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    applyTargetState(p.st, target);
  }
  const entries = collectEntries(p.st);
  return { ...p, entries, decision, target, report: buildReport({ snapshot, discovery: p.discovery, fingerprint: p.fingerprint, st: p.st, entries, decision, scope: "source", target }) };
}

/**
 * IMPORT (+ reconciliation + report). Refuses unless the environment guard approves.
 * @param {{ snapshot: any, pool: any, env?: Record<string,string|undefined>, targetUrl?: string, initiatedBy: string, hooks?: any, chunk?: number }} a
 * @returns {Promise<any>}
 */
export async function importSnapshot({ snapshot, pool, env = process.env, targetUrl, initiatedBy, hooks, chunk }) {
  const decision = assertApprovedEnvironment({ env, targetUrl, mode: "import", snapshotKind: snapshot.source.kind });
  const p = prepare(snapshot);
  const result = await runImport({ pool, snapshot, st: p.st, decision, initiatedBy, env, hooks, chunk });
  const client = await pool.connect();
  let rec;
  try {
    await client.query("BEGIN READ ONLY");
    rec = await reconcile(client, p.st, { failed: result.ctx.failed, batchId: result.batchId, quarantineExpected: result.entries.length });
    await client.query("ROLLBACK");
  } finally { client.release(); }
  const report = buildReport({ snapshot, discovery: p.discovery, fingerprint: p.fingerprint, st: p.st, entries: result.entries, decision, scope: "target", reconcile: rec, imported: result, batchId: result.batchId });
  return { ...p, ...result, reconcile: rec, report, decision };
}

/**
 * RECONCILE only (read-only): compare the snapshot with what is in the target now.
 * @param {{ snapshot: any, pool: any, env?: Record<string,string|undefined>, targetUrl?: string }} a
 * @returns {Promise<any>}
 */
export async function reconcileSnapshot({ snapshot, pool, env = process.env, targetUrl }) {
  const decision = assertApprovedEnvironment({ env, targetUrl, mode: "reconcile", snapshotKind: snapshot.source.kind });
  const p = prepare(snapshot);
  const client = await pool.connect();
  let rec;
  try {
    await client.query("BEGIN READ ONLY");
    const target = await readTargetState(client, p.st);
    applyTargetState(p.st, target);
    rec = await reconcile(client, p.st);
    await client.query("ROLLBACK");
  } finally { client.release(); }
  const entries = collectEntries(p.st);
  return { ...p, reconcile: rec, decision, report: buildReport({ snapshot, discovery: p.discovery, fingerprint: p.fingerprint, st: p.st, entries, decision, scope: "target", reconcile: rec }) };
}
