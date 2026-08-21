import type { Item } from "@/types";

const INCHES_TO_CM3_FACTOR = 16.387064;

export function unitFactor(dimensionUnit?: "cm" | "inches"): number {
  return dimensionUnit === "inches" ? INCHES_TO_CM3_FACTOR : 1;
}

export function computeCbm(input: {
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit?: "cm" | "inches";
  quantity?: number;
}): number {
  if (!input.length || !input.width || !input.height) return 0;
  const qty = input.quantity ?? 1;
  return (
    (input.length * input.width * input.height * unitFactor(input.dimensionUnit) * qty) /
    1_000_000
  );
}

export function computeCartonCbm(item: Pick<Item, "cartonLength" | "cartonWidth" | "cartonHeight" | "dimensionUnit">): number {
  return computeCbm({
    length: item.cartonLength,
    width: item.cartonWidth,
    height: item.cartonHeight,
    dimensionUnit: item.dimensionUnit,
    quantity: 1,
  });
}

export interface BillingGroup {
  key: string;
  isCarton: boolean;
  cartonNumber?: string;
  items: Item[];
  cbm: number;
}

/**
 * Groups items for CBM/shipping-fee calculation: items sharing an order and
 * cartonNumber collapse into one group priced by the carton's own dimensions;
 * items without a cartonNumber remain their own singleton group priced per-item.
 */
export function groupItemsForBilling(items: Item[]): BillingGroup[] {
  const groups = new Map<string, BillingGroup>();
  for (const item of items) {
    if (item.cartonNumber) {
      const key = `carton:${item.cartonNumber}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, isCarton: true, cartonNumber: item.cartonNumber, items: [], cbm: computeCartonCbm(item) };
        groups.set(key, group);
      }
      group.items.push(item);
    } else {
      groups.set(`item:${item.id}`, {
        key: `item:${item.id}`,
        isCarton: false,
        items: [item],
        cbm: computeCbm(item),
      });
    }
  }
  return Array.from(groups.values());
}
