"use client";

import React, { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { SidebarProvider, useSidebar } from "@/context/SidebarContext";
import { AdminSidebar } from "@/components/layout/AdminSidebar";
import { CustomerSidebar } from "@/components/layout/CustomerSidebar";
import { AdminBottomNav } from "@/components/layout/AdminBottomNav";
import { CustomerBottomNav } from "@/components/layout/CustomerBottomNav";
import { WhatsAppButton } from "@/components/shared/WhatsAppButton";
import { Loader2, Copy, CheckCheck } from "lucide-react";
import axios from "axios";

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const { appUser, loading } = useAuth();
  const pathname = usePathname();
  const { open, closeSidebar } = useSidebar();
  const [copied, setCopied] = useState(false);
  const [warehouseAddress, setWarehouseAddress] = useState<string | null>(null);

  useEffect(() => {
    if (appUser?.role !== "customer") return;
    const savedId = localStorage.getItem("pakk_preferred_warehouse");
    axios.get("/api/warehouses").then((res) => {
      const warehouses: { id: string; address: string }[] = res.data.data ?? [];
      const match = savedId
        ? warehouses.find((w) => w.id === savedId) ?? warehouses[0]
        : warehouses[0];
      if (match) setWarehouseAddress(match.address);
    }).catch(() => {});
  }, [appUser?.role]);

  const shippingMark = appUser?.shippingMark ?? "";
  const fullAddress = warehouseAddress ? `${warehouseAddress} (${shippingMark})` : shippingMark;

  const copyMark = () => {
    if (!shippingMark) return;
    navigator.clipboard.writeText(fullAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  // Show spinner only when loading AND no cached user to display
  if (loading && !appUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600 mx-auto" />
          <p className="text-sm text-gray-500 mt-3">Loading...</p>
        </div>
      </div>
    );
  }

  if (!appUser) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    return null;
  }

  const isAdminRoute = pathname.startsWith("/admin");
  const isCustomerRoute = pathname.startsWith("/customer");

  // Guard admin routes
  if (
    isAdminRoute &&
    appUser.role !== "super_admin" &&
    appUser.role !== "warehouse_staff"
  ) {
    if (typeof window !== "undefined") {
      window.location.href = "/customer";
    }
    return null;
  }

  // Guard customer routes
  if (isCustomerRoute && appUser.role !== "customer") {
    if (typeof window !== "undefined") {
      window.location.href = "/admin";
    }
    return null;
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Mobile backdrop — dismisses sidebar when tapping outside */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar */}
      {(appUser.role === "super_admin" || appUser.role === "warehouse_staff") && (
        <AdminSidebar />
      )}
      {appUser.role === "customer" && <CustomerSidebar />}

      {/* Main content — pb-16 on mobile to clear bottom nav */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile-only shipping mark bar for customers */}
        {appUser.role === "customer" && shippingMark && (
          <div className="lg:hidden shrink-0 bg-brand-50 border-b border-brand-100 px-4 py-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] text-brand-600 font-semibold uppercase tracking-wide leading-none mb-0.5">Your Shipping Address</p>
              <code className="text-xs font-mono font-bold text-brand-800 break-all leading-relaxed">{fullAddress}</code>
            </div>
            <button
              onClick={copyMark}
              className="shrink-0 p-1.5 rounded-lg hover:bg-brand-100 text-brand-500 transition-colors"
              aria-label="Copy shipping address"
            >
              {copied ? <CheckCheck className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto pb-16 lg:pb-0">{children}</div>
      </main>

      {/* Bottom navigation — mobile only */}
      {(appUser.role === "super_admin" || appUser.role === "warehouse_staff") && (
        <AdminBottomNav />
      )}
      {appUser.role === "customer" && <CustomerBottomNav />}

      {appUser.role === "customer" && <WhatsAppButton />}
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <DashboardLayoutInner>{children}</DashboardLayoutInner>
    </SidebarProvider>
  );
}
