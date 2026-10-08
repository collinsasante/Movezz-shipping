import type { Queryable } from "./client";
import { DomainError } from "./errors";
import { recordAudit } from "./audit";
import { authorize } from "./authz";

export interface PricedItem {
  itemId: string;
  billingBasis: "tier" | "special";
  tierRateUsd: string;
  tierPriceUsd: string;
  specialRateId: string | null;
  specialRateName: string | null;
  specialRateUsd: string | null;
  specialPriceUsd: string | null;
}

/** Everything a caller could try to dictate about a price. None of it is ever accepted. */
const FORBIDDEN_CLIENT_FIELDS = [
  "unitPriceUsd", "unit_price_usd", "priceUsd", "price_usd", "tierPriceUsd", "tierRateUsd", "specialPriceUsd", "specialRateUsd",
  "billingBasis", "billing_basis", "subtotalUsd", "subtotal_usd", "totalUsd", "total_usd", "totalGhs", "total_ghs", "fxRate", "fx_rate",
  "fxRateId", "role", "actorRole", "userRole",
] as const;

/** Rejects (rather than ignores) client-supplied financial values, so a bug or an attack is visible instead of silent. */
export function assertNoClientFinancials(input: object, what: string): void {
  const bad = FORBIDDEN_CLIENT_FIELDS.filter((k) => k in input);
  if (bad.length) throw new DomainError("INVALID_INPUT", `${what}: prices, totals, billing basis, FX and roles are decided by the server and cannot be supplied (${bad.join(", ")})`);
}

type Snap = {
  billing_basis: "tier" | "special"; package_tier: string; tier_rate_usd: string; tier_price_usd: string;
  special_rate_id: string | null; special_rate_name: string | null; special_rate_usd: string | null; special_price_usd: string | null;
};

/**
 * The authoritative price of an item, computed by PostgreSQL (item_authoritative_price, migration 0011): tier from the
 * customer's package tier + the active rate for the item's freight type; sea = CBM x quantity x rate, air = kg x quantity x rate,
 * rounded once to 2 decimals; a special price only when `specialRateId` names a card that passes resolve_special_rate().
 * Nothing falls back: a missing/zero/negative rate or measurement is an explicit error.
 */
export async function authoritativePrice(db: Queryable, itemId: string, specialRateId?: string | null): Promise<Snap> {
  if (specialRateId) {
    const { rowCount } = await db.query("SELECT 1 FROM special_rates WHERE id = $1", [specialRateId]);
    if (!rowCount) throw new DomainError("SPECIAL_RATE_NOT_FOUND", "Special rate not found");
  }
  const r = await db.query<Snap>("SELECT * FROM item_authoritative_price($1, $2)", [itemId, specialRateId ?? null]);
  return r.rows[0];
}

/**
 * Prices one item and stores the result as its snapshots (the item is locked; concurrent pricing of the same item serializes).
 *  - Only a special rate that staff EXPLICITLY pass is considered, and it is validated against the item's customer, dates,
 *    activity and freight type; otherwise nothing is written (SPECIAL_RATE_NOT_FOUND / SPECIAL_RATE_NOT_APPLICABLE).
 *  - The client never supplies a price, rate, billing basis, total or role (assertNoClientFinancials).
 * Must run inside withActorTransaction(): the pricing change is audited, attributed to the verified actor.
 */
export async function priceItem(db: Queryable, itemId: string, opts: { specialRateId?: string | null } = {}): Promise<PricedItem> {
  assertNoClientFinancials(opts, "priceItem");
  await authorize(db, "item.price");
  const locked = (await db.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [itemId])).rows[0];
  if (!locked) throw new DomainError("NOT_FOUND", "Item not found");
  const p = await authoritativePrice(db, itemId, opts.specialRateId);
  await db.query(
    `UPDATE items SET package_tier = $2, tier_rate_usd = $3, tier_price_usd = $4, billing_basis = $5,
            special_rate_id = $6, special_rate_name = $7, special_rate_usd = $8, special_price_usd = $9 WHERE id = $1`,
    [itemId, p.package_tier, p.tier_rate_usd, p.tier_price_usd, p.billing_basis, p.special_rate_id, p.special_rate_name, p.special_rate_usd, p.special_price_usd]
  );
  await recordAudit(db, {
    action: "item.price", entityType: "item", entityId: itemId,
    after: p.billing_basis === "special"
      ? { billing_basis: "special", special_rate_id: p.special_rate_id, special_rate_name: p.special_rate_name, tier_price_usd: p.tier_price_usd, special_price_usd: p.special_price_usd }
      : { billing_basis: "tier", package_tier: p.package_tier, tier_rate_usd: p.tier_rate_usd, tier_price_usd: p.tier_price_usd },
  });
  return {
    itemId, billingBasis: p.billing_basis, tierRateUsd: p.tier_rate_usd, tierPriceUsd: p.tier_price_usd,
    specialRateId: p.special_rate_id, specialRateName: p.special_rate_name, specialRateUsd: p.special_rate_usd, specialPriceUsd: p.special_price_usd,
  };
}
