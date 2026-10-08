// Financial analysis of ONE historical invoice, in the locked money model: USD is the pricing currency, the invoice freezes its FX,
// payments are GHS, the balance is derived in GHS. Pure functions over normalized records. Nothing is repaired, recalculated with
// current rates or guessed: anomalies are returned for the caller to quarantine (blocking) or report (discrepancy).
import { parseDecimal } from "./util.mjs";

const U = (text) => parseDecimal(text, { scale: 2 }).units;

/** Chronological replay order of payment events, voids before payments at the same instant (a freed balance can be re-used). */
export function paymentEvents(payments) {
  const ev = [];
  payments.forEach((p, i) => {
    ev.push({ t: p.row.paid_at, kind: "pay", i, p });
    if (p.row.status === "voided") ev.push({ t: p.row.voided_at > p.row.paid_at ? p.row.voided_at : p.row.paid_at, kind: "void", i, p, tie: p.row.voided_at > p.row.paid_at ? 0 : 2 });
  });
  const rank = (e) => (e.kind === "void" ? (e.tie === 2 ? 3 : 0) : 1);       // a void at exactly the pay instant must follow its own payment
  return ev.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : rank(a) - rank(b) || a.p.sourceId.localeCompare(b.p.sourceId) || (a.kind === "pay" ? -1 : 1)));
}

/**
 * @param {{ totalGhs: string, cancelled: boolean, payments: { row: any, sourceId: string }[], sourceStatus?: string, claim?: any }} a
 */
export function analyzeInvoice({ totalGhs, cancelled, payments, sourceStatus, claim }) {
  const total = U(totalGhs);
  const blocking = []; const discrepancies = [];
  let balancePaid = 0n; let completedAtEnd = 0n; let peak = 0n;
  for (const e of paymentEvents(payments)) {
    const amt = U(e.p.row.amount_ghs);
    if (e.kind === "pay") { balancePaid += amt; if (total > 0n && balancePaid > total && !blocking.some((b) => b.category === "OVERPAYMENT")) blocking.push({ category: "OVERPAYMENT", reason: `payments reach GHS ${(Number(balancePaid) / 100).toFixed(2)} on an invoice of GHS ${totalGhs}` }); }
    else balancePaid -= amt;
    if (balancePaid > peak) peak = balancePaid;
  }
  completedAtEnd = balancePaid;
  if (cancelled && payments.some((p) => p.row.status === "completed")) blocking.push({ category: "CANCELLED_WITH_PAYMENT", reason: "a cancelled invoice has completed payments (they would have to be voided first)" });
  if (total === 0n && payments.length > 0) blocking.push({ category: "PAYMENT_ON_ZERO_INVOICE", reason: "a zero-value invoice is settled without payments (docs/DECISIONS.md D4)" });
  const derivedStatus = cancelled ? "Cancelled" : total === 0n ? "Paid" : completedAtEnd > 0n && completedAtEnd >= total ? "Paid" : completedAtEnd > 0n ? "Partial" : "Pending";
  const outstanding = cancelled ? 0n : total - completedAtEnd;
  if (sourceStatus && sourceStatus !== derivedStatus) discrepancies.push({ category: "STATUS_MISMATCH", reason: `Airtable status "${sourceStatus}" but verified payments derive "${derivedStatus}"` });
  if (claim?.AmountPaid != null && U(claim.AmountPaid) !== completedAtEnd) discrepancies.push({ category: "PAID_AMOUNT_MISMATCH", reason: `Airtable AmountPaid ${claim.AmountPaid} vs verified completed payments ${(Number(completedAtEnd) / 100).toFixed(2)}` });
  if (claim?.BalanceDue != null && !cancelled && U(claim.BalanceDue) !== outstanding) discrepancies.push({ category: "BALANCE_MISMATCH", reason: `Airtable BalanceDue ${claim.BalanceDue} vs derived ${(Number(outstanding) / 100).toFixed(2)}` });
  return { totalUnits: total, paidUnits: completedAtEnd, outstandingUnits: outstanding, derivedStatus, blocking, discrepancies };
}
