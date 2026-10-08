// Currency rules (approved model): prices are held in USD; the customer pays in GHS; the Keepup invoice and
// every payment are in GHS. USD and GHS amounts are never compared or added to each other.
//
// KNOWN LIMIT (needs the PostgreSQL phase): an order does not store the exchange rate it was invoiced at, so
// GHS figures are derived from the CURRENT rate. The PostgreSQL design must freeze usd_total, fx_rate and
// ghs_total on the invoice at creation, and store each payment in GHS with the rate applied.

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Net amount due in GHS: (invoice - discount) converted once at the given rate. */
export function netInvoiceGhs(invoiceAmountUsd: number, discountUsd: number | undefined, usdToGhs: number): number {
  const net = Math.max(0, invoiceAmountUsd - (discountUsd && discountUsd > 0 ? discountUsd : 0));
  return round2(net * usdToGhs); // one conversion, one rounding
}

/** Half a pesewa of slack so rounding never leaves a GHS 0.01 "balance". */
export const isSettled = (paidGhs: number, totalGhs: number) => paidGhs >= totalGhs - 0.005;
