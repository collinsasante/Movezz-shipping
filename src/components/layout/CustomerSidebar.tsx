"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { useSidebar } from "@/context/SidebarContext";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  MapPin,
  LogOut,
  Settings,
  X,
  Calculator,
  Warehouse,
  MessageCircle,
} from "lucide-react";
import Image from "next/image";
import type { CustomerPackage } from "@/types";

const PACKAGE_LABELS: Record<CustomerPackage, string> = {
  basic: "Basic",
  business: "Business",
  enterprise: "Enterprise",
  special: "Special",
};

const navItems = [
  { href: "/customer", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/customer/items", label: "My Items", icon: Package },
  { href: "/customer/orders", label: "My Invoices", icon: ShoppingCart },
  { href: "/customer/tracking", label: "Tracking", icon: MapPin },
  { href: "/customer/addresses", label: "Addresses", icon: Warehouse },
  { href: "/customer/calculator", label: "Calculator", icon: Calculator },
  { href: "/customer/settings", label: "Settings", icon: Settings },
];

export function CustomerSidebar() {
  const pathname = usePathname();
  const { appUser, signOut } = useAuth();
  const { open, closeSidebar } = useSidebar();
  const shippingMark = appUser?.shippingMark ?? "";

  const accountType = appUser?.package ? (PACKAGE_LABELS[appUser.package] ?? "Customer") : "Customer";

  return (
    <aside
      className={cn(
        "flex flex-col bg-white border-r border-gray-200",
        "fixed inset-y-0 left-0 z-50 w-72 transition-transform duration-300 ease-in-out",
        "lg:relative lg:translate-x-0 lg:w-64 lg:z-auto lg:h-full",
        open ? "translate-x-0" : "-translate-x-full"
      )}
    >
      {/* Logo */}
      <div className="flex items-center justify-between h-14 lg:h-16 px-5 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-2">
          <Image src="/Logo.jpeg" alt="De-MOVEZZ LOGISTICS" width={32} height={32} className="rounded-lg" />
          <span className="font-bold text-lg tracking-tight text-gray-900">De-MOVEZZ LOGISTICS</span>
        </div>
        <button
          onClick={closeSidebar}
          className="lg:hidden p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Address shortcut */}
      <div className="mx-4 mt-4 shrink-0">
        <Link
          href="/customer/addresses"
          onClick={closeSidebar}
          className="flex items-center gap-3 w-full px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 hover:bg-amber-100 transition-colors"
        >
          <MapPin className="h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Change your address</p>
            <p className="text-xs text-amber-600 mt-0.5 truncate">
              {appUser?.customerName ?? (shippingMark || "View warehouse address")}
            </p>
          </div>
          <span className="text-xs text-amber-500 shrink-0">→</span>
        </Link>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={closeSidebar}
              className={cn(
                "flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-brand-50 text-brand-700 border border-brand-100"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              )}
            >
              <Icon className={cn("h-5 w-5 shrink-0", isActive ? "text-brand-600" : "text-gray-400")} />
              <span className="flex-1">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className="border-t border-gray-100 shrink-0">
        <div className="px-4 py-3">
          <p className="text-sm font-medium text-gray-900 truncate">
            {appUser?.customerName ?? appUser?.email}
          </p>
          <p className="text-xs text-gray-500 truncate">{accountType}</p>
        </div>
        <a
          href="https://wa.me/233544752701"
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeSidebar}
          className="flex items-center gap-2 w-full px-4 py-3 text-sm text-green-600 hover:bg-green-50 transition-colors border-t border-gray-100"
        >
          <MessageCircle className="h-4 w-4" />
          Chat on WhatsApp
        </a>
        <button
          onClick={() => { closeSidebar(); signOut(); }}
          className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-600 hover:bg-red-50 hover:text-red-600 transition-colors border-t border-gray-100"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
