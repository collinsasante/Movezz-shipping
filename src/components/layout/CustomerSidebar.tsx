"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  MapPin,
  LogOut,
  Copy,
  CheckCheck,
  MessageCircle,
  Settings,
} from "lucide-react";
import Image from "next/image";
import axios from "axios";
import type { SupportTicket } from "@/types";

const navItems = [
  { href: "/customer", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/customer/items", label: "My Items", icon: Package },
  { href: "/customer/orders", label: "My Invoices", icon: ShoppingCart },
  { href: "/customer/tracking", label: "Tracking", icon: MapPin },
  { href: "/customer/support", label: "Support", icon: MessageCircle },
  { href: "/customer/settings", label: "Settings", icon: Settings },
];

export function CustomerSidebar() {
  const pathname = usePathname();
  const { appUser, signOut } = useAuth();
  const [copied, setCopied] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  const shippingMark = appUser?.shippingMark ?? "";

  const copyShippingMark = () => {
    if (shippingMark) {
      navigator.clipboard.writeText(shippingMark);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Poll for unread admin messages
  useEffect(() => {
    const check = async () => {
      try {
        const res = await axios.get("/api/support");
        const tickets: SupportTicket[] = res.data.data;
        const unread = tickets.some(
          (t) =>
            t.status === "open" &&
            t.messages.length > 0 &&
            t.messages[t.messages.length - 1].sender === "admin"
        );
        setHasUnread(unread);
      } catch {}
    };
    check();
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside className="flex flex-col h-full w-64 bg-white border-r border-gray-200">
      {/* Logo */}
      <div className="flex items-center gap-2 h-16 px-6 border-b border-gray-100">
        <Image src="/logowithouttext.png" alt="Pakkmaxx" width={32} height={32} className="rounded-lg" />
        <span className="font-bold text-lg tracking-tight text-gray-900">
          Pakkmaxx
        </span>
      </div>

      {/* Shipping Mark Card */}
      <div className="mx-4 mt-4 p-3 bg-brand-50 border border-brand-100 rounded-xl">
        <p className="text-xs text-brand-600 font-medium mb-1">Your Shipping Mark</p>
        <div className="flex items-center justify-between gap-2">
          <code className="text-xs font-mono font-bold text-brand-800 truncate">
            {shippingMark || "Loading..."}
          </code>
          {shippingMark && (
            <button
              onClick={copyShippingMark}
              className="shrink-0 p-1 rounded hover:bg-brand-100 transition-colors"
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
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-brand-50 text-brand-700 border border-brand-100"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              )}
            >
              <Icon
                className={cn(
                  "h-5 w-5 shrink-0",
                  isActive ? "text-brand-600" : "text-gray-400"
                )}
              />
              <span className="flex-1">{item.label}</span>
              {item.href === "/customer/support" && hasUnread && !isActive && (
                <span className="w-2 h-2 bg-red-500 rounded-full" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className="border-t border-gray-100 p-4">
        <div className="mb-2">
          <p className="text-sm font-medium text-gray-900 truncate">
            {appUser?.customerName ?? appUser?.email}
          </p>
          <p className="text-xs text-gray-500 truncate">{appUser?.email}</p>
        </div>
        <button
          onClick={signOut}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-red-50 hover:text-red-600 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
