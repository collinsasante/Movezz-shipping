import type { Queryable } from "./client";
import { DomainError } from "./errors";
import { recordAudit } from "./audit";

export interface PricedItem {
  itemId: string;
  billingBasis: "tier" | "special";
  tierRateUsd: string;
  tierPriceUsd: string;
  specialRateUsd: string | null;
  specialPriceUsd: string | null;
}

/**
 * Prices one item and stores the result as its snapshots. All arithmetic is NUMERIC in PostgreSQL.
 *
 *  - The TIER price is always computed from the customer's package tier and the package rate in force now.
 *  - A SPECIAL price is computed only when the caller passes `specialRateId` (staff chose that card explicitly).
 *    The card is validated against the item's customer (active, in its date window, global or this customer's):
 *    otherwise the whole operation fails with SPECIAL_RATE_NOT_APPLICABLE and nothing is written.
 *  - Nothing here ever chooses a special card automatically, and the client never supplies a price or a basis.
 *
 * Sea: CBM x quantity x rate.  Air: weight x quantity x rate.  Rounded once to 2 decimals.
 *
 * Must run inside withActorTransaction(): the pricing change is audited, attributed to the verified actor.
 */
export async function priceItem(db: Queryable, itemId: string, opts: { specialRateId?: string | null } = {}): Promise<PricedItem> {
  const item = (await db.query(
    `SELECT i.id, i.customer_id, i.freight_type, i.weight_kg, i.quantity, i.cbm_total, c.package_tier
       FROM items i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1 FOR UPDATE OF i`,
    [itemId]
  )).rows[0];
  if (!item) throw new DomainError("NOT_FOUND", "Item not found");
  if (!item.freight_type) throw new DomainError("INVALID_INPUT", "Item has no freight type");
  const sea = item.freight_type === "sea";
  if (sea && item.cbm_total === null) throw new DomainError("INVALID_INPUT", "Sea freight needs length, width and height");
  if (!sea && item.weight_kg === null) throw new DomainError("INVALID_INPUT", "Air freight needs a weight");

  const tier = (await db.query(
    `SELECT rate_usd FROM package_rates
      WHERE tier = $1 AND freight_type = $2 AND is_active AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())`,
    [item.package_tier, item.freight_type]
  )).rows[0];
  if (!tier) throw new DomainError("INVALID_INPUT", `No active ${item.freight_type} rate for the ${item.package_tier} tier`);

  const quantityBasis = sea ? "cbm_total" : "(weight_kg * quantity)";
  const volume = (await db.query(`SELECT ${quantityBasis} AS q FROM items WHERE id = $1`, [itemId])).rows[0].q as string;
  const price = async (rate: string) => (await db.query<{ p: string }>("SELECT round($1::numeric * $2::numeric, 2)::text AS p", [volume, rate])).rows[0].p;

  const tierRate = String(tier.rate_usd);
  const tierPrice = await price(tierRate);

  if (opts.specialRateId) {
    // resolve_special_rate raises MV002 (-> SPECIAL_RATE_NOT_APPLICABLE) for unknown / inactive / expired / future / other customer's cards
    const card = (await db.query(`SELECT * FROM resolve_special_rate($1, $2, now(), $3)`, [opts.specialRateId, item.customer_id, item.freight_type])).rows[0];
    const specialRate = String(sea ? card.sea_rate_usd : card.air_rate_usd); // never null: resolve_special_rate rejects a card without this freight's rate
    const specialPrice = await price(specialRate);
    await db.query(
      `UPDATE items SET package_tier = $2, tier_rate_usd = $3, tier_price_usd = $4, billing_basis = 'special',
              special_rate_id = $5, special_rate_name = $6, special_rate_usd = $7, special_price_usd = $8 WHERE id = $1`,
      [itemId, item.package_tier, tierRate, tierPrice, card.id, card.name, specialRate, specialPrice]
    );
    await recordAudit(db, { action: "item.price", entityType: "item", entityId: itemId,
      after: { billing_basis: "special", special_rate_id: card.id, special_rate_name: card.name, tier_price_usd: tierPrice, special_price_usd: specialPrice } });
    return { itemId, billingBasis: "special", tierRateUsd: tierRate, tierPriceUsd: tierPrice, specialRateUsd: specialRate, specialPriceUsd: specialPrice };
  }

  await db.query(
    `UPDATE items SET package_tier = $2, tier_rate_usd = $3, tier_price_usd = $4, billing_basis = 'tier',
            special_rate_id = NULL, special_rate_name = NULL, special_rate_usd = NULL, special_price_usd = NULL WHERE id = $1`,
    [itemId, item.package_tier, tierRate, tierPrice]
  );
  await recordAudit(db, { action: "item.price", entityType: "item", entityId: itemId,
    after: { billing_basis: "tier", package_tier: item.package_tier, tier_rate_usd: tierRate, tier_price_usd: tierPrice } });
  return { itemId, billingBasis: "tier", tierRateUsd: tierRate, tierPriceUsd: tierPrice, specialRateUsd: null, specialPriceUsd: null };
}
