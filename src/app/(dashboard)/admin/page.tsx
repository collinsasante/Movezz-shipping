"use client";

import React, { useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { StatCard } from "@/components/shared/StatCard";
import type { AdminDashboardStats } from "@/types";
import {
  Users,
  Package,
  Container,
  SortAsc,
  AlertTriangle,
  HandCoins,
} from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminDashboardStats | null>(null);
  const { error } = useToast();

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get("/api/dashboard/admin");
        setStats(res.data.data);
      } catch {
        error("Failed to load dashboard", "Please refresh the page");
      }
    };
    load();
  }, [error]);

  return (
    <div className="flex flex-col h-full">
      <Header
        title="Admin Dashboard"
        subtitle="Overview of Pakkmaxx operations"
      />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatCard
            title="Total Customers"
            value={stats?.totalCustomers ?? "—"}
            subtitle={`${stats?.activeCustomers ?? 0} active`}
            icon={Users}
            iconColor="text-blue-600"
            iconBg="bg-blue-50"
            href="/admin/customers"
          />
          <StatCard
            title="Items in Warehouse"
            value={stats?.itemsInWarehouse ?? "—"}
            subtitle="Awaiting shipment"
            icon={Package}
            iconColor="text-indigo-600"
            iconBg="bg-indigo-50"
            href="/admin/items"
          />
          <StatCard
            title="Containers in Transit"
            value={stats?.containersInTransit ?? "—"}
            subtitle="Shipped to Ghana"
            icon={Container}
            iconColor="text-purple-600"
            iconBg="bg-purple-50"
            href="/admin/containers"
          />
          <StatCard
            title="Items in Sorting"
            value={stats?.itemsInSorting ?? "—"}
            subtitle="Being processed"
            icon={SortAsc}
            iconColor="text-amber-600"
            iconBg="bg-amber-50"
            href="/admin/sorting"
          />
          <StatCard
            title="Lost Items"
            value={stats?.lostItems ?? "—"}
            subtitle="Flagged missing"
            icon={AlertTriangle}
            iconColor="text-red-600"
            iconBg="bg-red-50"
            href="/admin/sorting"
          />
          <StatCard
            title="Ready for Pickup"
            value={stats?.readyForPickup ?? "—"}
            subtitle="Awaiting collection"
            icon={HandCoins}
            iconColor="text-brand-600"
            iconBg="bg-brand-50"
            href="/admin/sorting"
          />
        </div>
      </div>
    </div>
  );
}
