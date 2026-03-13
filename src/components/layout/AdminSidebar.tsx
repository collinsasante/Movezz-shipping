"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { useSidebar } from "@/context/SidebarContext";
import {
  LayoutDashboard,
  Users,
  Package,
  Container,
  ShoppingCart,
  SortAsc,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Settings,
  X,
} from "lucide-react";
import Image from "next/image";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/customers", label: "Customers", icon: Users },
  { href: "/admin/items", label: "Items", icon: Package },
  { href: "/admin/containers", label: "Containers", icon: Container },
  { href: "/admin/orders", label: "Invoices", icon: ShoppingCart },
  { href: "/admin/sorting", label: "Sorting", icon: SortAsc },
{ href: "/admin/staff", label: "Staff", icon: ShieldCheck },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const { appUser, signOut } = useAuth();
  const { open, closeSidebar } = useSidebar();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "flex flex-col bg-gray-900 text-white",
        // Mobile: fixed drawer, slides in from left
        "fixed inset-y-0 left-0 z-50 w-72 transition-transform duration-300 ease-in-out",
        // Desktop: static in flow, collapsible width
        "lg:relative lg:translate-x-0 lg:z-auto lg:h-full",
        collapsed ? "lg:w-16" : "lg:w-64",
        // Mobile open/close
        open ? "translate-x-0" : "-translate-x-full"
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          "flex items-center h-14 lg:h-16 px-4 border-b border-gray-700 shrink-0",
          collapsed ? "lg:justify-center" : "justify-between"
        )}
      >
        {!collapsed && (
          <div className="flex items-center gap-2">
            <Image src="/logowithouttext.png" alt="PAKKmax" width={32} height={32} className="rounded-lg" />
            <span className="font-bold text-lg tracking-tight">PAKKmax</span>
          </div>
        )}
        {/* Mobile: X to close drawer | Desktop: chevron to collapse */}
        <button
          onClick={() => {
            if (typeof window !== "undefined" && window.innerWidth < 1024) {
              closeSidebar();
            } else {
              setCollapsed(!collapsed);
            }
          }}
          className="p-1.5 rounded-lg hover:bg-gray-700 transition-colors shrink-0"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <X className="h-4 w-4 lg:hidden" />
          <span className="hidden lg:block">
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </span>
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-4 px-2 space-y-1 overflow-y-auto">
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
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "text-white bg-white/10"
                  : "text-gray-300 hover:bg-white/5 hover:text-white"
              )}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className="border-t border-gray-700 p-3 shrink-0">
        {!collapsed && (
          <div className="px-2 pb-2">
            <p className="text-xs text-gray-400 truncate">{appUser?.email}</p>
            <p className="text-xs text-brand-400 font-medium capitalize">
              {appUser?.role?.replace("_", " ")}
            </p>
          </div>
        )}
        <button
          onClick={() => { closeSidebar(); signOut(); }}
          className={cn(
            "flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors",
            collapsed && "lg:justify-center"
          )}
          title={collapsed ? "Sign out" : undefined}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </button>
      </div>
    </aside>
  );
}
