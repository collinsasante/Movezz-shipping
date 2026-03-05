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
} from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";
import { useRouter } from "next/navigation";

export default function CustomerDashboardPage() {
  const { appUser } = useAuth();
  const { error } = useToast();
  const router = useRouter();
  const [stats, setStats] = useState<CustomerDashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

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

  const activeItems = stats
    ? Object.entries(stats.itemsByStatus)
        .filter(([s]) => s !== "Completed")
        .reduce((sum, [, count]) => sum + count, 0)
    : 0;

  return (
    <div className="flex flex-col h-full">
      <Header
        title={`Hello, ${(typeof appUser?.customerName === "string" ? appUser.customerName.split(" ")[0] : null) ?? appUser?.email?.split("@")[0] ?? "there"} 👋`}
        subtitle="Here's an overview of your shipments"
      />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="Total Items"
            value={stats?.totalItems ?? "—"}
            subtitle={`${activeItems} active`}
            icon={Package}
            iconColor="text-blue-600"
            iconBg="bg-blue-50"
          />
          <StatCard
            title="Total Orders"
            value={stats?.totalOrders ?? "—"}
            subtitle="All time"
            icon={ShoppingCart}
            iconColor="text-purple-600"
            iconBg="bg-purple-50"
          />
          <StatCard
            title="Pending Payment"
            value={stats ? formatCurrency(stats.pendingPayment) : "—"}
            subtitle="Outstanding balance"
            icon={DollarSign}
            iconColor="text-amber-600"
            iconBg="bg-amber-50"
          />
          <StatCard
            title="Ready for Pickup"
            value={stats?.itemsByStatus?.["Ready for Pickup"] ?? "0"}
            subtitle="Available now"
            icon={MapPin}
            iconColor="text-green-600"
            iconBg="bg-green-50"
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
                {stats?.recentItems.map((item) => (
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
                {(!stats?.recentItems || stats.recentItems.length === 0) && (
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
                      {selectedItem.weight} kg
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
              {stats?.recentOrders?.map((order) => (
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
