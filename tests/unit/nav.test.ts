import { describe, it, expect } from "vitest";
import { visibleAdminNav } from "@/lib/nav";

const items = [{ href: "/admin" }, { href: "/admin/customers" }, { href: "/admin/orders" }, { href: "/admin/staff" }, { href: "/admin/reports" }, { href: "/admin/settings" }];
const hrefs = (r: Parameters<typeof visibleAdminNav>[1]) => visibleAdminNav(items, r).map((i) => i.href);

describe("admin navigation follows the authorization matrix", () => {
  it("super_admin sees everything", () => expect(hrefs("super_admin")).toEqual(items.map((i) => i.href)));
  it("warehouse_staff does not see invoices, staff or reports", () => expect(hrefs("warehouse_staff")).toEqual(["/admin", "/admin/customers", "/admin/settings"]));
  it("an unknown or customer role sees no money/admin entries (fail closed while loading)", () => {
    expect(hrefs(undefined)).toEqual(["/admin", "/admin/customers", "/admin/settings"]);
    expect(hrefs("customer")).toEqual(["/admin", "/admin/customers", "/admin/settings"]);
  });
  it("hides sub-paths too", () => expect(visibleAdminNav([{ href: "/admin/orders/new" }], "warehouse_staff")).toEqual([]));
});
