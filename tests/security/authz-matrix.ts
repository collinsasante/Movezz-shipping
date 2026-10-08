// FINAL role guards (Phase 7F), transcribed from the requireAuth(...) call of every route handler and checked against
// docs/DECISIONS.md D6/D7/A4. `[]` = no role is accepted (the route is disabled).
// "public" = no requireAuth (the handler does its own checks or is open).
import type { HttpMethod, Role } from "../helpers/world";

const A: Role = "super_admin";
const S: Role = "warehouse_staff";
const C: Role = "customer";

export type Guard = Role[] | "public";
export interface Entry {
  route: string;
  method: HttpMethod;
  guard: Guard;
}

const r = (route: string, method: HttpMethod, guard: Guard): Entry => ({ route, method, guard });

export const MATRIX: Entry[] = [
  r("activity-logs", "GET", [A]),
  r("admin/registrations", "GET", [A]),
  r("admin/registrations/[id]", "PATCH", [A]),
  r("admin/registrations/[id]", "DELETE", [A]),
  r("auth/reset-password", "POST", "public"),
  r("auth/signup", "POST", "public"),
  r("auth/verify", "POST", "public"),
  r("auth/verify", "DELETE", "public"),
  r("auth/verify-cookie", "GET", "public"),
  r("cartons", "GET", [A, S]),
  r("cartons", "POST", [A, S]),
  r("cartons/[cartonNumber]", "PATCH", [A, S]),
  r("cartons/[cartonNumber]", "DELETE", [A, S]),
  r("containers", "GET", [A, S]),
  r("containers", "POST", [A]),
  r("containers/[id]", "GET", [A, S]),
  r("containers/[id]", "PATCH", [A]),
  r("containers/[id]", "DELETE", [A]),
  r("containers/[id]/items", "POST", [A, S]),
  r("containers/[id]/items", "DELETE", [A, S]),
  r("containers/[id]/status", "PATCH", [A]),
  r("containers/[id]/sync-items", "POST", [A]),
  r("customers", "GET", [A, S]),
  r("customers", "POST", [A]),
  r("customers/[id]", "GET", [A, S, C]),
  r("customers/[id]", "PATCH", [A, C]),
  r("customers/[id]", "DELETE", [A]),
  r("customers/me/warehouse", "PATCH", []),
  r("dashboard/admin", "GET", [A, S]),
  r("dashboard/customer", "GET", [C, A]),
  r("health", "GET", "public"),
  r("items", "GET", [A, S, C]),
  r("items", "POST", [A, S]),
  r("items/[id]", "GET", [A, S, C]),
  r("items/[id]", "PATCH", [A, S]),
  r("items/[id]", "DELETE", [A]),
  r("items/[id]/history", "GET", [A, S, C]),
  r("items/[id]/status", "PATCH", [A, S]),
  r("onboard", "POST", "public"),
  r("orders", "GET", [A, S, C]),
  r("orders", "POST", [A]),
  r("orders/[id]", "GET", [A, S, C]),
  r("orders/[id]", "PATCH", [A]),
  r("orders/[id]", "DELETE", [A]),
  r("orders/[id]/create-invoice", "POST", [A]),
  r("orders/[id]/create-invoice", "DELETE", [A]),
  r("orders/keepup-sync", "POST", [A]),
  r("package-rates", "GET", [A, S, C]),
  r("package-rates", "PUT", [A]),
  r("reports", "GET", [A]),
  r("settings", "GET", [A, S]),
  r("settings", "PUT", [A]),
  r("sorting", "GET", [A, S]),
  r("sorting", "POST", [A, S]),
  r("special-rates", "GET", [A, S]),
  r("special-rates", "POST", [A]),
  r("special-rates/[id]", "PATCH", [A]),
  r("special-rates/[id]", "DELETE", [A]),
  r("suppliers", "GET", [A, S]),
  r("suppliers", "POST", [A]),
  r("suppliers/[id]", "GET", [A, S]),
  r("suppliers/[id]", "PATCH", [A]),
  r("suppliers/[id]", "DELETE", [A]),
  r("upload/sign", "POST", [A, S]),
  r("users", "GET", [A]),
  r("users", "POST", [A]),
  r("users/[id]", "DELETE", [A]),
  r("warehouses", "GET", [A, S, C]),
  r("warehouses", "POST", [A]),
  r("warehouses/[id]", "PATCH", [A]),
  r("warehouses/[id]", "DELETE", [A]),
];
