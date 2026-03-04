"use client";

import React, { useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { StatCard } from "@/components/shared/StatCard";
import { StatusBadge } from "@/components/ui/badge";
import { formatDate, formatCurrency, ITEM_STATUS_STEPS } from "@/lib/utils";
import type { AdminDashboardStats } from "@/types";
import {
  Users,
  Package,
  Container,
  SortAsc,
  AlertTriangle,
  DollarSign,
  Clock,
  HandCoins,
} from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminDashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const { error } = useToast();

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get("/api/dashboard/admin");
        setStats(res.data.data);
      } catch {
        error("Failed to load dashboard", "Please refresh the page");
      } finally {
        setLoading(false);
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
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="Total Customers"
            value={stats?.totalCustomers ?? "—"}
            subtitle={`${stats?.activeCustomers ?? 0} active`}
            icon={Users}
            iconColor="text-blue-600"
            iconBg="bg-blue-50"
          />
          <StatCard
            title="Items in Warehouse"
            value={stats?.itemsInWarehouse ?? "—"}
            subtitle="Awaiting shipment"
            icon={Package}
            iconColor="text-indigo-600"
            iconBg="bg-indigo-50"
          />
          <StatCard
            title="Containers in Transit"
            value={stats?.containersInTransit ?? "—"}
            subtitle="Shipped to Ghana"
            icon={Container}
            iconColor="text-purple-600"
            iconBg="bg-purple-50"
          />
          <StatCard
            title="Items in Sorting"
            value={stats?.itemsInSorting ?? "—"}
            subtitle="Being processed"
            icon={SortAsc}
            iconColor="text-amber-600"
            iconBg="bg-amber-50"
          />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="Lost Items"
            value={stats?.lostItems ?? "—"}
            subtitle="Flagged missing"
            icon={AlertTriangle}
            iconColor="text-red-600"
            iconBg="bg-red-50"
          />
          <StatCard
            title="Total Revenue"
            value={stats ? formatCurrency(stats.totalRevenue) : "—"}
            subtitle="Paid invoices"
            icon={DollarSign}
            iconColor="text-green-600"
            iconBg="bg-green-50"
          />
          <StatCard
            title="Pending Revenue"
            value={stats ? formatCurrency(stats.pendingRevenue) : "—"}
            subtitle="Awaiting payment"
            icon={Clock}
            iconColor="text-orange-600"
            iconBg="bg-orange-50"
          />
          <StatCard
            title="Ready for Pickup"
            value={stats?.readyForPickup ?? "—"}
            subtitle="Awaiting collection"
            icon={HandCoins}
            iconColor="text-brand-600"
            iconBg="bg-brand-50"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Items Pipeline */}
          <div className="bg-white border border-gray-100 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-900">Items Pipeline</h2>
              <a href="/admin/items" className="text-sm text-brand-600 hover:underline">
                View all →
              </a>
            </div>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-8 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {ITEM_STATUS_STEPS.map((step) => {
                  const count = stats?.itemsByStatus?.[step] ?? 0;
                  const total = Object.values(stats?.itemsByStatus ?? {}).reduce<number>((a, b) => a + (b ?? 0), 0);
                  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                  return (
                    <div key={step}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-600 font-medium truncate pr-2">{step}</span>
                        <span className="text-gray-500 shrink-0">{count}</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-brand-500 rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Unpaid Invoices */}
          <div className="bg-white border border-gray-100 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-900">Unpaid Invoices</h2>
              <a href="/admin/orders" className="text-sm text-brand-600 hover:underline">
                View all →
              </a>
            </div>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : (stats?.pendingOrders ?? []).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <DollarSign className="h-8 w-8 text-gray-200 mb-2" />
                <p className="text-sm text-gray-400">No unpaid invoices</p>
              </div>
            ) : (
              <div className="space-y-2">
                {(stats?.pendingOrders ?? []).map((order) => (
                  <button
                    key={order.id}
                    onClick={() => (window.location.href = `/admin/orders`)}
                    className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
                  >
                    <div>
                      <p className="font-mono text-xs font-bold text-gray-700">{order.orderRef}</p>
                      {order.customerName && (
                        <p className="text-xs text-gray-500 mt-0.5">{order.customerName}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-gray-900">{formatCurrency(order.invoiceAmount)}</p>
                      <p className="text-xs text-gray-400">{formatDate(order.invoiceDate)}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
