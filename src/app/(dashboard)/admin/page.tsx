"use client";

import React, { useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { StatCard } from "@/components/shared/StatCard";
import { StatusBadge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { AdminDashboardStats } from "@/types";
import {
  Users,
  Package,
  Container,
  SortAsc,
  AlertTriangle,
  HandCoins,
  Box,
  CalendarDays,
} from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

type Period = "all" | "today" | "week" | "month";

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminDashboardStats | null>(null);
  const { error } = useToast();
  const [period, setPeriod] = useState<Period>("all");

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

  const pendingOrders = (() => {
    const orders = stats?.pendingOrders ?? [];
    if (period === "all") return orders;
    const now = new Date();
    const cutoff = new Date();
    if (period === "today") cutoff.setHours(0, 0, 0, 0);
    else if (period === "week") cutoff.setDate(cutoff.getDate() - 7);
    else if (period === "month") cutoff.setMonth(cutoff.getMonth() - 1);
    return orders.filter((o) => {
      const d = new Date(o.invoiceDate);
      return !isNaN(d.getTime()) && d >= cutoff && d <= now;
    });
  })();

  return (
    <div className="flex flex-col h-full">
      <Header
        title="Admin Dashboard"
        subtitle="Overview of Pakkmaxx operations"
      />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {/* Period filter */}
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-gray-400" />
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs bg-white">
            {(["all", "today", "week", "month"] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 font-medium transition-colors ${period === p ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
              >
                {p === "all" ? "All time" : p === "today" ? "Today" : p === "week" ? "This week" : "This month"}
              </button>
            ))}
          </div>
        </div>

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
          <StatCard
            title="Total CBM"
            value={stats ? `${stats.totalCbm.toFixed(2)} m³` : "—"}
            subtitle="All items"
            icon={Box}
            iconColor="text-teal-600"
            iconBg="bg-teal-50"
            href="/admin/items"
          />
        </div>

        {/* Pending Invoices */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">Pending Invoices</h2>
            <a href="/admin/orders" className="text-sm text-brand-600 hover:underline">View all →</a>
          </div>
          {!stats ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />)}
            </div>
          ) : pendingOrders.length === 0 ? (
            <div className="text-center py-10 bg-white border border-gray-100 rounded-xl">
              <p className="text-sm text-gray-400">No pending invoices{period !== "all" ? " in this period" : ""}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {pendingOrders.map((order) => (
                <div key={order.id} className="flex items-center justify-between p-4 bg-white border border-gray-100 rounded-xl hover:border-gray-200 transition-colors">
                  <div>
                    <p className="font-mono text-xs font-bold text-gray-800">{order.orderRef}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{order.customerName ?? "—"} · {formatDate(order.invoiceDate)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-gray-900">{formatCurrency(order.invoiceAmount)}</span>
                    <StatusBadge status={order.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
