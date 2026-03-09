"use client";

import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { TrendingUp, Clock, ShoppingCart, CheckCircle2 } from "lucide-react";
import axios from "axios";

interface MonthlyRevenue {
  month: string;
  revenue: number;
}

interface TopCustomer {
  id: string;
  name: string;
  revenue: number;
  orders: number;
}

interface ReportData {
  totalRevenue: number;
  pendingRevenue: number;
  totalOrders: number;
  paidOrders: number;
  monthlyRevenue: MonthlyRevenue[];
  topCustomers: TopCustomer[];
}

function StatCard({
  title, value, sub, icon, color,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1">{title}</p>
            <p className="text-2xl font-bold text-gray-900">{value}</p>
            {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
          </div>
          <div className={`p-2.5 rounded-xl ${color}`}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function MonthLabel(month: string): string {
  const [year, m] = month.split("-");
  const d = new Date(parseInt(year), parseInt(m) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export default function ReportsPage() {
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios.get("/api/reports")
      .then((res) => setData(res.data.data))
      .catch(() => console.error("Failed to load reports"))
      .finally(() => setLoading(false));
  }, []);

  const maxMonthly = data ? Math.max(...data.monthlyRevenue.map((m) => m.revenue), 1) : 1;

  return (
    <div className="flex flex-col h-full">
      <Header title="Revenue Reports" subtitle="Financial overview and performance metrics" />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : data ? (
          <>
            {/* Stat Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                title="Total Revenue"
                value={formatCurrency(data.totalRevenue)}
                sub="Paid invoices"
                icon={<TrendingUp className="h-5 w-5 text-green-600" />}
                color="bg-green-50"
              />
              <StatCard
                title="Outstanding"
                value={formatCurrency(data.pendingRevenue)}
                sub="Pending invoices"
                icon={<Clock className="h-5 w-5 text-amber-600" />}
                color="bg-amber-50"
              />
              <StatCard
                title="Total Invoices"
                value={data.totalOrders.toLocaleString()}
                sub="All time"
                icon={<ShoppingCart className="h-5 w-5 text-blue-600" />}
                color="bg-blue-50"
              />
              <StatCard
                title="Paid Invoices"
                value={data.paidOrders.toLocaleString()}
                sub={data.totalOrders > 0 ? `${Math.round((data.paidOrders / data.totalOrders) * 100)}% collection rate` : undefined}
                icon={<CheckCircle2 className="h-5 w-5 text-brand-600" />}
                color="bg-brand-50"
              />
            </div>

            {/* Monthly Revenue Chart */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Monthly Revenue (Last 12 Months)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-end gap-1.5 h-40 pt-2">
                  {data.monthlyRevenue.map(({ month, revenue }) => {
                    const pct = Math.max((revenue / maxMonthly) * 100, revenue > 0 ? 4 : 0);
                    return (
                      <div key={month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                        <div
                          className="w-full rounded-t-md transition-all duration-300 relative group"
                          style={{
                            height: `${pct}%`,
                            backgroundColor: revenue > 0 ? "rgb(79 70 229)" : "rgb(229 231 235)",
                            minHeight: revenue > 0 ? "4px" : "2px",
                          }}
                        >
                          {revenue > 0 && (
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                              <div className="bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap">
                                {formatCurrency(revenue)}
                              </div>
                            </div>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-400 truncate w-full text-center">
                          {MonthLabel(month)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Top Customers */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Top Customers by Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topCustomers.length === 0 ? (
                  <p className="text-sm text-gray-400 py-4 text-center">No paid orders yet</p>
                ) : (
                  <div className="space-y-2">
                    {data.topCustomers.map((c, i) => {
                      const pct = (c.revenue / data.topCustomers[0].revenue) * 100;
                      return (
                        <div key={c.id} className="flex items-center gap-3">
                          <span className="text-xs font-bold text-gray-400 w-5 shrink-0 text-right">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-sm font-medium text-gray-900 truncate">{c.name}</span>
                              <span className="text-sm font-semibold text-gray-700 ml-2 shrink-0">
                                {formatCurrency(c.revenue)}
                              </span>
                            </div>
                            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-brand-500 rounded-full transition-all duration-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                          <span className="text-xs text-gray-400 shrink-0 w-14 text-right">
                            {c.orders} inv.
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        ) : (
          <p className="text-sm text-gray-400">Failed to load report data.</p>
        )}
      </div>
    </div>
  );
}
