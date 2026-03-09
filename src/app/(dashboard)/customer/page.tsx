"use client";

import React, { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { Header } from "@/components/layout/Header";
import { StatCard } from "@/components/shared/StatCard";
import { StatusBadge } from "@/components/ui/badge";
import { TrackingTimeline } from "@/components/shared/TrackingTimeline";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { CustomerDashboardStats, Item } from "@/types";
import {
  Package,
  ShoppingCart,
  DollarSign,
  Clock,
  MapPin,
  Box,
  CalendarDays,
} from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";
import { useRouter } from "next/navigation";

type Period = "all" | "today" | "week" | "month" | "custom";

function filterByPeriod<T>(items: T[], getDate: (i: T) => string, period: Period, customFrom?: string, customTo?: string): T[] {
  if (period === "all") return items;
  if (period === "custom") {
    if (!customFrom && !customTo) return items;
    return items.filter((i) => {
      const d = new Date(getDate(i));
      if (isNaN(d.getTime())) return false;
      if (customFrom && d < new Date(customFrom)) return false;
      if (customTo) { const t = new Date(customTo); t.setHours(23, 59, 59, 999); if (d > t) return false; }
      return true;
    });
  }
  const now = new Date();
  const cutoff = new Date();
  if (period === "today") cutoff.setHours(0, 0, 0, 0);
  else if (period === "week") cutoff.setDate(cutoff.getDate() - 7);
  else if (period === "month") cutoff.setMonth(cutoff.getMonth() - 1);
  return items.filter((i) => {
    const d = new Date(getDate(i));
    return !isNaN(d.getTime()) && d >= cutoff && d <= now;
  });
}

export default function CustomerDashboardPage() {
  const { appUser } = useAuth();
  const { error } = useToast();
  const router = useRouter();
  const [stats, setStats] = useState<CustomerDashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [period, setPeriod] = useState<Period>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get("/api/dashboard/customer");
        setStats(res.data.data);
        if (res.data.data.recentItems?.length > 0) {
          setSelectedItem(res.data.data.recentItems[0]);
        }
      } catch {
        error("Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [error]);

  // Deduplicate recentItems by tracking number, then apply period filter
  const deduplicatedItems = (() => {
    const seen = new Set<string>();
    const deduped = (stats?.recentItems ?? []).filter((item) => {
      if (!item.trackingNumber) return true;
      if (seen.has(item.trackingNumber)) return false;
      seen.add(item.trackingNumber);
      return true;
    });
    return filterByPeriod(deduped, (i) => i.dateReceived, period, customFrom, customTo);
  })();

  const filteredOrders = filterByPeriod(stats?.recentOrders ?? [], (o) => o.invoiceDate, period, customFrom, customTo);

  // Filtered stat card values
  const filteredItemCount = deduplicatedItems.length;
  const filteredOrderCount = filteredOrders.length;
  const filteredPendingPayment = filteredOrders
    .filter((o) => o.status === "Pending")
    .reduce((sum, o) => sum + o.invoiceAmount, 0);
  const filteredReadyForPickup = deduplicatedItems.filter((i) => i.status === "Ready for Pickup").length;
  const filteredCbm = deduplicatedItems.reduce((sum, item) => {
    if (!item.length || !item.width || !item.height) return sum;
    const factor = item.dimensionUnit === "inches" ? 16.387064 : 1;
    return sum + (item.length * item.width * item.height * factor) / 1_000_000;
  }, 0);
  const isFiltered = period !== "all";
  const activeItems = deduplicatedItems.filter((i) => i.status !== "Completed").length;

  return (
    <div className="flex flex-col h-full">
      <Header
        title={`Hello, ${(typeof appUser?.customerName === "string" ? appUser.customerName.split(" ")[0] : null) ?? appUser?.email?.split("@")[0] ?? "there"}`}
        subtitle="Here's an overview of your shipments"
      />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {/* Period filter — above cards so it affects them */}
        <div className="flex flex-wrap items-center gap-2">
          <CalendarDays className="h-4 w-4 text-gray-400" />
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs bg-white">
            {(["all", "today", "week", "month", "custom"] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 font-medium transition-colors capitalize ${period === p ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
              >
                {p === "all" ? "All time" : p === "today" ? "Today" : p === "week" ? "This week" : p === "month" ? "This month" : "Custom"}
              </button>
            ))}
          </div>
          {period === "custom" && (
            <div className="flex items-center gap-1">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <span className="text-gray-400 text-xs">–</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          )}
        </div>

        {/* Stats — reflect selected period */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard
            title="Total Items"
            value={stats ? filteredItemCount : "—"}
            subtitle={isFiltered ? `${activeItems} active` : `${activeItems} active`}
            icon={Package}
            iconColor="text-blue-600"
            iconBg="bg-blue-50"
            href="/customer/items"
          />
          <StatCard
            title="Total Orders"
            value={stats ? filteredOrderCount : "—"}
            subtitle={isFiltered ? "In period" : "All time"}
            icon={ShoppingCart}
            iconColor="text-purple-600"
            iconBg="bg-purple-50"
            href="/customer/orders"
          />
          <StatCard
            title="Pending Payment"
            value={stats ? formatCurrency(filteredPendingPayment) : "—"}
            subtitle="Outstanding balance"
            icon={DollarSign}
            iconColor="text-amber-600"
            iconBg="bg-amber-50"
            href="/customer/orders"
          />
          <StatCard
            title="Ready for Pickup"
            value={stats ? filteredReadyForPickup : "—"}
            subtitle="Available now"
            icon={MapPin}
            iconColor="text-green-600"
            iconBg="bg-green-50"
            href="/customer/items"
          />
          <StatCard
            title="Total CBM"
            value={stats ? `${filteredCbm.toFixed(2)} m³` : "—"}
            subtitle={isFiltered ? "In period" : "Your shipments"}
            icon={Box}
            iconColor="text-teal-600"
            iconBg="bg-teal-50"
            href="/customer/items"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Recent Items */}
          <div className="lg:col-span-3 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Recent Items</h2>
              <a
                href="/customer/items"
                className="text-sm text-brand-600 hover:underline"
              >
                View all →
              </a>
            </div>

            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-16 bg-gray-100 rounded-xl animate-pulse"
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {deduplicatedItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left ${
                      selectedItem?.id === item.id
                        ? "border-brand-200 bg-brand-50 shadow-sm"
                        : "border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
                      <Package className="h-5 w-5 text-gray-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {item.description}
                      </p>
                      <p className="text-xs text-gray-500">
                        {item.itemRef} · Received {formatDate(item.dateReceived)}
                      </p>
                    </div>
                    <StatusBadge status={item.status} />
                  </button>
                ))}
                {deduplicatedItems.length === 0 && (
                  <div className="text-center py-12 bg-white rounded-xl border border-gray-100">
                    <Package className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No items yet</p>
                    <p className="text-xs text-gray-400 mt-1">
                      Use your shipping mark on packages you send to us
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tracking Timeline */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-gray-900">
                Tracking
              </h2>
              {selectedItem && (
                <span className="text-xs text-gray-500">
                  {selectedItem.itemRef}
                </span>
              )}
            </div>

            <div>
              {selectedItem ? (
                <>
                  <div className="mb-4 pb-4 border-b border-gray-50">
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {selectedItem.description}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {selectedItem.shippingType === "sea" && selectedItem.length && selectedItem.width && selectedItem.height
                        ? `${((selectedItem.length * selectedItem.width * selectedItem.height * (selectedItem.dimensionUnit === "inches" ? 16.387064 : 1)) / 1_000_000).toFixed(4)} m³`
                        : selectedItem.weight
                        ? `${selectedItem.weight} kg`
                        : ""}
                    </p>
                  </div>
                  <TrackingTimeline
                    currentStatus={selectedItem.status}
                    compact
                  />
                </>
              ) : (
                <div className="text-center py-8">
                  <Clock className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-sm text-gray-400">
                    Select an item to see tracking
                  </p>
                </div>
              )}
            </div>

            {/* Recent Orders */}
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-gray-900">Recent Orders</h2>
                <a
                  href="/customer/orders"
                  className="text-sm text-brand-600 hover:underline"
                >
                  View all →
                </a>
              </div>
              {filteredOrders.map((order) => (
                <div
                  key={order.id}
                  className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-xl"
                >
                  <div>
                    <p className="font-mono text-xs font-bold text-gray-800">
                      {order.orderRef}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatDate(order.invoiceDate)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-sm">
                      {formatCurrency(order.invoiceAmount)}
                    </p>
                    <StatusBadge status={order.status} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
