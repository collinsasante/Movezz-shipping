"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { SidebarProvider, useSidebar } from "@/context/SidebarContext";
import { AdminSidebar } from "@/components/layout/AdminSidebar";
import { CustomerSidebar } from "@/components/layout/CustomerSidebar";
import { WhatsAppButton } from "@/components/shared/WhatsAppButton";
import { Loader2 } from "lucide-react";

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const { appUser, loading } = useAuth();
  const pathname = usePathname();
  const { open, closeSidebar } = useSidebar();

  if (loading) {
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

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>

      <WhatsAppButton />
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
