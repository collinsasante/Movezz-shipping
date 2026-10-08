// Client-side pre-check for the invoice discount (USD). It only gives immediate feedback; the server re-validates everything
// (role from the database, reason, bounds, frozen snapshot) and remains authoritative.
import type { UserRole } from "@/types";

export type DiscountCheck = { ok: true; discount: number; total: number } | { ok: false; error: string };

export function canGiveDiscount(role: UserRole | undefined): boolean {
  return role === "super_admin";
}

export function checkDiscount(input: { subtotal: number; discount: string; reason: string; role: UserRole | undefined }): DiscountCheck {
  const raw = input.discount.trim();
  const discount = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(discount) || discount < 0) return { ok: false, error: "The discount must be a number of 0 or more" };
  if (discount === 0) return { ok: true, discount: 0, total: round2(input.subtotal) };
  if (!canGiveDiscount(input.role)) return { ok: false, error: "Only a super admin can give a discount" };
  if (Math.round(discount * 100) !== discount * 100 && Math.abs(Math.round(discount * 100) - discount * 100) > 1e-6) return { ok: false, error: "The discount can have at most 2 decimals" };
  if (!input.reason.trim()) return { ok: false, error: "A reason is required for a discount" };
  if (discount > input.subtotal + 1e-9) return { ok: false, error: "The discount cannot be larger than the invoice subtotal" };
  return { ok: true, discount: round2(discount), total: round2(input.subtotal - discount) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
