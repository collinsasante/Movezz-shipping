"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/context/SidebarContext";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  MapPin,
  Menu,
} from "lucide-react";

const bottomItems = [
  { href: "/customer", label: "Home", icon: LayoutDashboard, exact: true },
  { href: "/customer/items", label: "Items", icon: Package },
  { href: "/customer/orders", label: "Invoices", icon: ShoppingCart },
  { href: "/customer/tracking", label: "Tracking", icon: MapPin },
];

export function CustomerBottomNav() {
  const pathname = usePathname();
  const { openSidebar } = useSidebar();

  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 flex items-stretch h-16 safe-area-pb">
      {bottomItems.map((item) => {
        const isActive = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
              isActive ? "text-brand-600" : "text-gray-400"
            )}
          >
            <div
              className={cn(
                "flex items-center justify-center w-7 h-7 rounded-lg transition-colors",
                isActive && "bg-brand-50"
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <span>{item.label}</span>
          </Link>
        );
      })}

      {/* More button — opens full sidebar drawer */}
      <button
        onClick={openSidebar}
        className="flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-gray-400 transition-colors"
        aria-label="More"
      >
        <div className="flex items-center justify-center w-7 h-7 rounded-lg">
          <Menu className="h-5 w-5" />
        </div>
        <span>More</span>
      </button>
    </nav>
  );
}
