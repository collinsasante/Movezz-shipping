// Navigation reflects the locked authorization matrix (docs/DECISIONS.md D6): money and administration screens are super_admin only.
// This only decides what is SHOWN; the API (and the database) remain the authority and keep denying direct URL / API access.
import type { UserRole } from "@/types";

export const SUPER_ADMIN_ONLY_HREFS = ["/admin/orders", "/admin/staff", "/admin/reports"] as const;

export function visibleAdminNav<T extends { href: string }>(items: readonly T[], role: UserRole | undefined): T[] {
  // unknown role (still loading) or any non-admin: show the operational items only
  return items.filter((i) => role === "super_admin" || !SUPER_ADMIN_ONLY_HREFS.some((h) => i.href === h || i.href.startsWith(h + "/")));
}
