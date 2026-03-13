"use client";

import React, { useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import {
  CalendarDays, DollarSign, Clock, ShoppingCart,
} from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

type Period = "all" | "today" | "week" | "month" | "custom";

interface MonthlyRevenue { month: string; revenue: number; }
interface MonthlyShipment { month: string; count: number; }
interface TopCustomer { id: string; name: string; revenue: number; orders: number; }

interface ReportData {
  pendingRevenue: number;
  totalOrders: number;
  revenueThisYear: number;
  monthlyRevenue: MonthlyRevenue[];
  monthlyShipments: MonthlyShipment[];
  topCustomers: TopCustomer[];
}

function MonthLabel(month: string): string {
  const [year, m] = month.split("-");
  const d = new Date(parseInt(year), parseInt(m) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export default function AdminDashboardPage() {
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const { error } = useToast();
  const [period, setPeriod] = useState<Period>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    const params: Record<string, string> = {};
    if (period !== "all") {
      const now = new Date();
      if (period === "today") {
        const start = new Date(now); start.setHours(0, 0, 0, 0);
        params.from = start.toISOString().split("T")[0];
        params.to = now.toISOString().split("T")[0];
      } else if (period === "week") {
        const start = new Date(now); start.setDate(start.getDate() - 7);
        params.from = start.toISOString().split("T")[0];
        params.to = now.toISOString().split("T")[0];
      } else if (period === "month") {
        const start = new Date(now); start.setMonth(start.getMonth() - 1);
        params.from = start.toISOString().split("T")[0];
        params.to = now.toISOString().split("T")[0];
      } else if (period === "custom") {
        if (customFrom) params.from = customFrom;
        if (customTo) params.to = customTo;
      }
    }
    setLoading(true);
    axios.get("/api/reports", { params })
      .then((res) => setReport(res.data.data))
      .catch(() => error("Failed to load dashboard", "Please refresh the page"))
      .finally(() => setLoading(false));
  }, [period, customFrom, customTo, error]);

  const maxMonthly = report ? Math.max(...report.monthlyRevenue.map((m) => m.revenue), 1) : 1;
  const maxShipments = report ? Math.max(...report.monthlyShipments.map((m) => m.count), 1) : 1;

  return (
    <div className="flex flex-col h-full">
      <Header title="Admin Dashboard" subtitle="Overview of PAKKmax operations" />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {/* Date filter */}
        <div className="flex flex-wrap items-center gap-2">
          <CalendarDays className="h-4 w-4 text-gray-400 shrink-0" />
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs bg-white">
            {(["all", "today", "week", "month", "custom"] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 font-medium transition-colors ${period === p ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
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

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : report ? (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { title: "Revenue This Year", value: formatCurrency(report.revenueThisYear), sub: "Current calendar year", icon: <DollarSign className="h-5 w-5 text-blue-600" />, bg: "bg-blue-50" },
                { title: "Outstanding", value: formatCurrency(report.pendingRevenue), sub: "Pending invoices", icon: <Clock className="h-5 w-5 text-amber-600" />, bg: "bg-amber-50" },
                { title: "Total Invoices", value: report.totalOrders.toLocaleString(), sub: "All time", icon: <ShoppingCart className="h-5 w-5 text-blue-600" />, bg: "bg-blue-50" },
              ].map(({ title, value, sub, icon, bg }) => (
                <Card key={title}>
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-1">{title}</p>
                        <p className="text-2xl font-bold text-gray-900">{value}</p>
                        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
                      </div>
                      <div className={`p-2.5 rounded-xl ${bg}`}>{icon}</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Monthly Revenue (Last 12 Months)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end gap-1.5 h-40 pt-2">
                    {report.monthlyRevenue.map(({ month, revenue }) => {
                      const pct = Math.max((revenue / maxMonthly) * 100, revenue > 0 ? 4 : 0);
                      return (
                        <div key={month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                          <div
                            className="w-full rounded-t-md transition-all duration-300 relative group"
                            style={{ height: `${pct}%`, backgroundColor: revenue > 0 ? "rgb(79 70 229)" : "rgb(229 231 235)", minHeight: revenue > 0 ? "4px" : "2px" }}
                          >
                            {revenue > 0 && (
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                                <div className="bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap">{formatCurrency(revenue)}</div>
                              </div>
                            )}
                          </div>
                          <span className="text-[10px] text-gray-400 truncate w-full text-center">{MonthLabel(month)}</span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Shipments Per Month (Last 12 Months)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end gap-1.5 h-40 pt-2">
                    {report.monthlyShipments.map(({ month, count }) => {
                      const pct = Math.max((count / maxShipments) * 100, count > 0 ? 4 : 0);
                      return (
                        <div key={month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                          <div
                            className="w-full rounded-t-md transition-all duration-300 relative group"
                            style={{ height: `${pct}%`, backgroundColor: count > 0 ? "rgb(20 184 166)" : "rgb(229 231 235)", minHeight: count > 0 ? "4px" : "2px" }}
                          >
                            {count > 0 && (
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                                <div className="bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap">{count} items</div>
                              </div>
                            )}
                          </div>
                          <span className="text-[10px] text-gray-400 truncate w-full text-center">{MonthLabel(month)}</span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Top Customers */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Top Customers by Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                {report.topCustomers.length === 0 ? (
                  <p className="text-sm text-gray-400 py-4 text-center">No paid orders yet</p>
                ) : (
                  <div className="space-y-2">
                    {report.topCustomers.slice(0, 5).map((c, i) => {
                      const pct = (c.revenue / report.topCustomers[0].revenue) * 100;
                      return (
                        <div key={c.id} className="flex items-center gap-3">
                          <span className="text-xs font-bold text-gray-400 w-5 shrink-0 text-right">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-sm font-medium text-gray-900 truncate">{c.name}</span>
                              <span className="text-sm font-semibold text-gray-700 ml-2 shrink-0">{formatCurrency(c.revenue)}</span>
                            </div>
                            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full bg-brand-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                          <span className="text-xs text-gray-400 shrink-0 w-14 text-right">{c.orders} inv.</span>
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
