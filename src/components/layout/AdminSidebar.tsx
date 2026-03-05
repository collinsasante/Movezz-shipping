"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import {
  LayoutDashboard,
  Users,
  Package,
  Container,
  ShoppingCart,
  SortAsc,
  Activity,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  MessageCircle,
  Settings,
} from "lucide-react";
import Image from "next/image";
import axios from "axios";

const navItems = [
  {
    href: "/admin",
    label: "Dashboard",
    icon: LayoutDashboard,
    exact: true,
  },
  {
    href: "/admin/customers",
    label: "Customers",
    icon: Users,
  },
  {
    href: "/admin/items",
    label: "Items",
    icon: Package,
  },
  {
    href: "/admin/containers",
    label: "Containers",
    icon: Container,
  },
  {
    href: "/admin/orders",
    label: "Invoices",
    icon: ShoppingCart,
  },
  {
    href: "/admin/sorting",
    label: "Sorting",
    icon: SortAsc,
  },
  {
    href: "/admin/reports",
    label: "Status History",
    icon: Activity,
  },
  {
    href: "/admin/staff",
    label: "Staff",
    icon: ShieldCheck,
  },
  {
    href: "/admin/support",
    label: "Support",
    icon: MessageCircle,
  },
  {
    href: "/admin/settings",
    label: "Settings",
    icon: Settings,
  },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const { appUser, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [openTickets, setOpenTickets] = useState(0);

  // Poll for open support ticket count
  useEffect(() => {
    const check = async () => {
      try {
        const res = await axios.get("/api/support");
        const count = (res.data.data as { status: string }[]).filter(
          (t) => t.status === "open"
        ).length;
        setOpenTickets(count);
      } catch {}
    };
    check();
    const interval = setInterval(check, 90000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside
      className={cn(
        "flex flex-col h-full bg-gray-900 text-white transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          "flex items-center h-16 px-4 border-b border-gray-700",
          collapsed ? "justify-center" : "justify-between"
        )}
      >
        {!collapsed && (
          <div className="flex items-center gap-2">
            <Image src="/logowithouttext.png" alt="Pakkmaxx" width={32} height={32} className="rounded-lg" />
            <span className="font-bold text-lg tracking-tight">Pakkmaxx</span>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-lg hover:bg-gray-700 transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-4 px-2 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);
          const Icon = item.icon;
          const isSupport = item.href === "/admin/support";

          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                "relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-brand-600 text-white"
                  : "text-gray-300 hover:bg-gray-700 hover:text-white"
              )}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span className="flex-1">{item.label}</span>}
              {isSupport && openTickets > 0 && (
                collapsed ? (
                  <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 rounded-full text-white text-[9px] font-bold flex items-center justify-center">
                    {openTickets > 9 ? "9+" : openTickets}
                  </span>
                ) : (
                  <span className="ml-auto bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                    {openTickets > 99 ? "99+" : openTickets}
                  </span>
                )
              )}
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className="border-t border-gray-700 p-3">
        {!collapsed && (
          <div className="px-2 pb-2">
            <p className="text-xs text-gray-400 truncate">{appUser?.email}</p>
            <p className="text-xs text-brand-400 font-medium capitalize">
              {appUser?.role?.replace("_", " ")}
            </p>
          </div>
        )}
        <button
          onClick={signOut}
          className={cn(
            "flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors",
            collapsed && "justify-center"
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
