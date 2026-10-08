// Single definition of "what does this item bill at" (USD). Used by the order screen and the order API,
// so the browser and the server cannot disagree.
//
// Approved decision Q16: an item that carries a special rate is billed at the special price
// (estShippingPrice); every other item is billed at its tier price (pkgEstShipping).
// A special rate is only honoured when the item names one (isSpecialItem + specialRateName) - the API
// refuses to store that combination unless the named rate exists (see validateSpecialClaim).
import type { Item } from "@/types";

export type BillingBasis = "special" | "tier";

type Priced = Pick<Item, "isSpecialItem" | "specialRateName" | "estShippingPrice" | "pkgEstShipping">;

export function billingFor(item: Priced): { basis: BillingBasis; priceUsd: number } {
  if (item.isSpecialItem && item.specialRateName && item.estShippingPrice != null) {
    return { basis: "special", priceUsd: item.estShippingPrice };
  }
  return { basis: "tier", priceUsd: item.pkgEstShipping ?? item.estShippingPrice ?? 0 };
}

/** Invoice total in USD, rounded once on the final sum. */
export function invoiceTotalUsd(items: Priced[]): number {
  const total = items.reduce((sum, item) => sum + billingFor(item).priceUsd, 0);
  return Math.round(total * 100) / 100;
}

export interface SpecialClaim {
  isSpecialItem?: boolean;
  specialRateName?: string;
  specialShippingRate?: number;
}

/**
 * Checks a client's special-rate claim against the SpecialRates table.
 * The client may only say WHICH named rate applies; the per-unit rate stored on the item is taken
 * from the table (never from the request) and the flag cannot be set without a matching rate.
 */
export function validateSpecialClaim(
  claim: SpecialClaim,
  rates: { name: string; sea: number; air: number }[],
  freight: "air" | "sea" | undefined
): { ok: true; fields: { isSpecialItem?: boolean; specialRateName?: string; specialShippingRate?: number } } | { ok: false; error: string } {
  const claims = claim.isSpecialItem === true || claim.specialRateName !== undefined || claim.specialShippingRate !== undefined;
  if (!claims) return { ok: true, fields: claim.isSpecialItem === false ? { isSpecialItem: false } : {} };
  if (claim.isSpecialItem !== true || !claim.specialRateName) {
    return { ok: false, error: "A special rate requires both isSpecialItem and a special rate name" };
  }
  const rate = rates.find((r) => r.name === claim.specialRateName);
  if (!rate) return { ok: false, error: "Unknown special rate" };
  return {
    ok: true,
    fields: {
      isSpecialItem: true,
      specialRateName: rate.name,
      specialShippingRate: freight === "air" ? rate.air : rate.sea,
    },
  };
}
