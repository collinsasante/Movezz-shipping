"use client";

import React, { useState, useEffect } from "react";
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
  Copy,
  CheckCheck,
} from "lucide-react";
import Image from "next/image";
import axios from "axios";
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
  const [copied, setCopied] = useState(false);
  const [warehouseAddress, setWarehouseAddress] = useState<string | null>(null);

  const shippingMark = appUser?.shippingMark ?? "";

  useEffect(() => {
    const savedId = localStorage.getItem("pakk_preferred_warehouse") ?? appUser?.preferredWarehouseId ?? null;
    axios.get("/api/warehouses").then((res) => {
      const warehouses: { id: string; address: string }[] = res.data.data ?? [];
      const match = savedId ? warehouses.find((w) => w.id === savedId) ?? warehouses[0] : warehouses[0];
      if (match) setWarehouseAddress(match.address);
    }).catch(() => {});
  }, [appUser?.preferredWarehouseId]);

  const copyShippingMark = () => {
    if (!shippingMark) return;
    const text = warehouseAddress ? `${warehouseAddress} (${shippingMark})` : shippingMark;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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

      {/* Shipping Mark Card */}
      <div className="mx-4 mt-4 p-3 bg-brand-50 border border-brand-100 rounded-xl shrink-0">
        <p className="text-xs text-brand-600 font-medium mb-1">Your Shipping Address</p>
        {appUser?.customerName && (
          <p className="text-xs font-semibold text-brand-900 mb-0.5">{appUser.customerName}</p>
        )}
        {appUser?.phone && (
          <p className="text-xs text-brand-700 mb-1">{appUser.phone}</p>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <code className="text-xs font-mono font-bold text-brand-800 break-all leading-relaxed">
              {warehouseAddress
                ? `${warehouseAddress}${shippingMark ? ` (${shippingMark})` : ""}`
                : (shippingMark || "Loading...")}
            </code>
          </div>
          {shippingMark && (
            <button
              onClick={copyShippingMark}
              className="shrink-0 p-1.5 rounded-lg hover:bg-brand-100 text-brand-600 transition-colors"
              title="Copy shipping mark"
            >
              {copied ? (
                <CheckCheck className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-brand-500" />
              )}
            </button>
          )}
        </div>
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
