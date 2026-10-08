// Stage 8 - REPORT. A deterministic readiness report (same inputs -> byte-identical JSON; the batch id is the only run-specific value).
//
//   READY             nothing was quarantined, nothing needs review, no discrepancy of any kind, and (scope "target") the target
//                     reconciles exactly with the source.
//   READY_WITH_REVIEW every check passes and nothing financial or identity-related is unresolved, but some records were excluded for
//                     non-financial reasons or carry warnings a human must look at.
//   NOT_READY         anything else: a failed environment check, a failed reconciliation check, a financial or identity problem, a record
//                     rejected by the database, or a discrepancy between source and target.
// "scope" says what was verified: "source" (dry-run: the source data is importable) or "target" (after an import + reconciliation).
import { expectedState } from "./reconcile.mjs";
import { canonicalJson, unitsToText } from "./util.mjs";
import { TABLE_ORDER } from "./validate.mjs";

const FINANCIAL = new Set(["MISSING_VERIFIED_FINANCIALS", "INVALID_MONEY", "INVALID_FX", "INVALID_PAYMENT", "INVALID_PAYMENT_STATE", "UNEXPECTED_CURRENCY", "OVERPAYMENT", "CANCELLED_WITH_PAYMENT", "PAYMENT_ON_ZERO_INVOICE",
  "INVOICE_LINES_MISMATCH", "INVALID_LINE", "MISSING_CANCELLATION_DATE", "DUPLICATE_PAYMENT", "ORPHAN_PAYMENT", "ORPHAN_FINANCIAL_RECORD", "INVALID_SPECIAL_RATE"]);
const IDENTITY = new Set(["CONFLICTING_IDENTITY", "DUPLICATE_CUSTOMER", "DUPLICATE_CONTAINER", "DUPLICATE_SOURCE_ID", "INVALID_SHIPPING_MARK"]);
const DATABASE = new Set(["DB_REJECTED", "DB_CONSTRAINT_VIOLATION", "SOURCE_CHANGED"]);

const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

export function buildReport({ snapshot, discovery, fingerprint, st, entries, decision, scope, reconcile = null, imported = null, target = null, batchId = null }) {
  const rec = {};                                                    // per table: unique source records by outcome
  for (const t of TABLE_ORDER) {
    const total = snapshot.tables[t]?.length ?? 0;
    let valid = 0, blocked = 0, deferred = 0;
    for (const r of snapshot.tables[t] ?? []) { const s = st.statusOf(t, r.id); if (s === "valid") valid++; else if (s === "deferred") deferred++; else blocked++; }
    if (total || t === "Items") rec[t] = { discovered: total, valid, quarantined: blocked, deferred };
  }
  const byCategory = {}, bySeverity = {}, byTable = {};
  for (const e of entries) { bump(byCategory, `${e.severity}:${e.category}`); bump(bySeverity, e.severity); bump(byTable, e.table); }
  const blocking = entries.filter((e) => e.severity === "blocking");
  const uniq = (list) => new Set(list.map((e) => `${e.table}\u0000${e.sourceId}`)).size;
  const dup = uniq(blocking.filter((e) => /^DUPLICATE_|^CONFLICTING_IDENTITY$/.test(e.category)));
  const unresolved = uniq(blocking);
  const orphans = uniq(blocking.filter((e) => /^ORPHAN_|^MISSING_(CUSTOMER_REFERENCE|CONTAINER|ORDER|ITEM|CARTON|WAREHOUSE)$/.test(e.category)));
  const brokenRel = uniq(blocking.filter((e) => /^(CONFLICTING_RELATIONSHIP|INVALID_LINK|INVALID_CARTON|INVOICE_QUARANTINED|PARENT_QUARANTINED|CUSTOMER_QUARANTINED|CONTAINER_QUARANTINED|ITEM_QUARANTINED)$/.test(e.category)));
  const invalidStates = uniq(blocking.filter((e) => /^(UNKNOWN_STATUS|UNKNOWN_TIER|UNKNOWN_ROLE|INVALID_PAYMENT_STATE|UNKNOWN_RECORD_TYPE)$/.test(e.category)));
  const identityConflicts = uniq(blocking.filter((e) => IDENTITY.has(e.category))) + uniq(entries.filter((e) => e.severity === "review" && e.category === "CONFLICTING_IDENTITY"));

  const checks = reconcile?.checks ?? [];
  const reconciledOk = checks.filter((c) => c.ok).length;
  const importedTotals = { imported: 0, skipped: 0, failed: 0 };
  for (const c of Object.values(imported?.counts?.perTable ?? {})) { importedTotals.imported += c.imported; importedTotals.skipped += c.skipped; importedTotals.failed += c.failed; }

  const reasons = [];
  if (!decision?.ok) reasons.push("the environment safety checks did not pass");
  for (const c of checks) if (!c.ok) reasons.push(`reconciliation check failed: ${c.name}`);
  // the financial picture is derived from the verified source in every scope; target mismatches are added once a reconciliation ran
  const fin = sourceFinancials(st, imported?.ctx?.failed, reconcile);
  if (fin?.discrepancies?.length) reasons.push(`${fin.discrepancies.length} financial discrepancy(ies) between Airtable's claims and the verified data`);
  if (fin?.mismatches?.length) reasons.push(`${fin.mismatches.length} invoice(s) differ between source and target`);
  const critical = blocking.filter((e) => FINANCIAL.has(e.category) || IDENTITY.has(e.category) || DATABASE.has(e.category));
  if (critical.length) reasons.push(`${uniq(critical)} record(s) are quarantined for financial, identity or database reasons`);
  const sourceDiscrepancies = discoveryProblems(discovery);
  if (sourceDiscrepancies) reasons.push(`${sourceDiscrepancies} structural problem(s) in the snapshot`);
  const notReady = reasons.length > 0;
  const needsReview = !notReady && (blocking.length > 0 || entries.some((e) => e.severity === "review"));
  if (needsReview) {
    if (blocking.length) reasons.push(`${unresolved} record(s) were excluded and need a human decision`);
    const rv = uniq(entries.filter((e) => e.severity === "review")); if (rv) reasons.push(`${rv} record(s) carry warnings`);
  }
  const verdict = notReady ? "NOT_READY" : needsReview ? "READY_WITH_REVIEW" : "READY";

  const report = {
    verdict, scope, reasons: [...new Set(reasons)].sort(),
    source: { snapshotFingerprint: fingerprint, kind: snapshot.source.kind, label: snapshot.source.label, capturedAt: snapshot.source.capturedAt, tables: rec,
      totals: { discovered: sumOf(rec, "discovered"), valid: sumOf(rec, "valid"), quarantined: sumOf(rec, "quarantined"), deferred: sumOf(rec, "deferred"), duplicated: dup, unresolved }, unknownTables: discovery.unknownTables.map((u) => u.table).sort() },
    postgres: { mode: scope === "target" ? "imported" : "dry-run", imported: importedTotals.imported, skippedAlreadyImported: scope === "target" ? importedTotals.skipped : (target ? [...target.mappings.keys()].length : 0), failed: importedTotals.failed,
      reconciledChecks: { passed: reconciledOk, total: checks.length }, perTable: imported?.counts?.perTable ?? null },
    financial: fin ? { invoices: fin.invoices, totalGhs: fin.sourceTotalGhs, paidGhs: fin.sourcePaidGhs, outstandingGhs: fin.sourceOutstandingGhs, cancelledInvoices: fin.cancelled, discrepancies: fin.discrepancies, mismatches: fin.mismatches } : null,
    integrity: { orphanRecords: orphans, duplicateRecords: dup, brokenRelationships: brokenRel, invalidStates, unresolvedIdentityConflicts: identityConflicts, targetChecks: reconcile?.integrity ?? null },
    security: { actorUsed: "import (signed, per-transaction, no user identity)", environment: decision ? { ok: decision.ok, class: decision.environment, mode: decision.mode, checks: decision.checks } : null,
      targetSideEffects: reconcile?.security ?? null, forbiddenOperationAttempts: entries.filter((e) => /\b(MV007|MV012|42501)\b/.test(e.reason)).length },
    identity: { usersDeferred: rec.Users?.deferred ?? 0, note: "No Firebase identity is created or linked and no role is assigned; people re-activate through the registration flow (docs/DECISIONS.md D9/D23)." },
    quarantine: { bySeverity, byTable, byCategory },
    checks,
    entries,
  };
  if (batchId) report.postgres.batchId = batchId;
  return report;
}
const sumOf = (rec, k) => Object.values(rec).reduce((a, b) => a + b[k], 0);
function discoveryProblems(d) { return d.duplicateIds.length + d.envelopeProblems; }

export function reportToJson(report) {
  const sorted = JSON.parse(canonicalJson(report));
  return JSON.stringify(sorted, null, 2);
}

export function renderReport(r) {
  const L = [];
  L.push(`MOVEZZ IMPORT READINESS REPORT  [${r.verdict}]  scope=${r.scope}`);
  for (const x of r.reasons) L.push(`  - ${x}`);
  L.push("", `Source ${r.source.kind} "${r.source.label}" captured ${r.source.capturedAt}  fingerprint ${r.source.snapshotFingerprint.slice(0, 16)}`);
  const t = r.source.totals;
  L.push(`  discovered ${t.discovered}  valid ${t.valid}  quarantined ${t.quarantined}  deferred ${t.deferred}  duplicated ${t.duplicated}  unresolved ${t.unresolved}`);
  for (const [k, v] of Object.entries(r.source.tables)) L.push(`    ${k.padEnd(22)} discovered ${String(v.discovered).padStart(4)}  valid ${String(v.valid).padStart(4)}  quarantined ${String(v.quarantined).padStart(4)}  deferred ${String(v.deferred).padStart(4)}`);
  L.push("", `PostgreSQL (${r.postgres.mode}): imported ${r.postgres.imported}  skipped(already imported) ${r.postgres.skippedAlreadyImported}  failed ${r.postgres.failed}  reconciliation ${r.postgres.reconciledChecks.passed}/${r.postgres.reconciledChecks.total}`);
  if (r.financial) L.push("", `Financial: ${r.financial.invoices} invoice(s)  total GHS ${r.financial.totalGhs}  paid ${r.financial.paidGhs}  outstanding ${r.financial.outstandingGhs}  cancelled ${r.financial.cancelledInvoices}  discrepancies ${r.financial.discrepancies.length}  mismatches ${r.financial.mismatches.length}`);
  const i = r.integrity;
  L.push("", `Integrity: orphans ${i.orphanRecords}  duplicates ${i.duplicateRecords}  broken relationships ${i.brokenRelationships}  invalid states ${i.invalidStates}  identity conflicts ${i.unresolvedIdentityConflicts}`);
  L.push(`Security: actor=${r.security.actorUsed}  environment ok=${r.security.environment?.ok}  forbidden attempts ${r.security.forbiddenOperationAttempts}`);
  L.push(`Identity: ${r.identity.usersDeferred} user record(s) deferred - ${r.identity.note}`);
  return L.join("\n");
}

function sourceFinancials(st, failed, reconcile) {
  if (reconcile) return reconcile.financial;
  const exp = expectedState(st, failed);
  const f = { invoices: exp.invoices.length, sourceTotalGhs: 0n, sourcePaidGhs: 0n, sourceOutstandingGhs: 0n, cancelled: 0, discrepancies: [], mismatches: [] };
  for (const { o, fin, cancelled } of exp.invoices) {
    f.sourceTotalGhs += fin.totalUnits; f.sourcePaidGhs += fin.paidUnits; if (cancelled) f.cancelled++; else f.sourceOutstandingGhs += fin.outstandingUnits;
    for (const d of fin.discrepancies) f.discrepancies.push({ invoice: o.row.invoice_ref, sourceId: o.sourceId, ...d });
  }
  return { ...f, sourceTotalGhs: unitsToText(f.sourceTotalGhs, 2), sourcePaidGhs: unitsToText(f.sourcePaidGhs, 2), sourceOutstandingGhs: unitsToText(f.sourceOutstandingGhs, 2) };
}
