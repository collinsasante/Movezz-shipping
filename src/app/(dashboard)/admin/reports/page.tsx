"use client";

import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { TrendingUp, DollarSign, Package, BarChart2, Clock, ShoppingCart, CheckCircle2 } from "lucide-react";
import axios from "axios";

interface MonthlyRevenue {
  month: string;
  revenue: number;
}

interface MonthlyShipment {
  month: string;
  count: number;
}

interface TopCustomer {
  id: string;
  name: string;
  revenue: number;
  orders: number;
}

interface CustomerAnalytic {
  id: string;
  name: string;
  totalOrders: number;
  totalRevenue: number;
  outstandingBalance: number;
}

interface OutstandingPayment {
  id: string;
  orderRef: string;
  customerName: string;
  invoiceAmount: number;
  invoiceDate: string;
  status: string;
}

interface ReportData {
  totalRevenue: number;
  pendingRevenue: number;
  totalOrders: number;
  paidOrders: number;
  monthlyRevenue: MonthlyRevenue[];
  topCustomers: TopCustomer[];
  revenueThisMonth: number;
  revenueThisYear: number;
  avgOrderValue: number;
  totalShipments: number;
  monthlyShipments: MonthlyShipment[];
  customerAnalytics: CustomerAnalytic[];
  outstandingPayments: OutstandingPayment[];
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
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const maxMonthly = data ? Math.max(...data.monthlyRevenue.map((m) => m.revenue), 1) : 1;
  const maxShipments = data ? Math.max(...data.monthlyShipments.map((m) => m.count), 1) : 1;

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
            {/* Existing summary stat cards */}
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

            {/* Revenue Overview cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                title="Revenue This Month"
                value={formatCurrency(data.revenueThisMonth)}
                sub="Current calendar month"
                icon={<TrendingUp className="h-5 w-5 text-green-600" />}
                color="bg-green-50"
              />
              <StatCard
                title="Revenue This Year"
                value={formatCurrency(data.revenueThisYear)}
                sub="Current calendar year"
                icon={<DollarSign className="h-5 w-5 text-blue-600" />}
                color="bg-blue-50"
              />
              <StatCard
                title="Avg. Order Value"
                value={formatCurrency(data.avgOrderValue)}
                sub="Per paid invoice"
                icon={<BarChart2 className="h-5 w-5 text-purple-600" />}
                color="bg-purple-50"
              />
              <StatCard
                title="Total Shipments"
                value={data.totalShipments.toLocaleString()}
                sub="All items received"
                icon={<Package className="h-5 w-5 text-indigo-600" />}
                color="bg-indigo-50"
              />
            </div>

            {/* Two side-by-side charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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

              {/* Shipments Per Month Chart */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Shipments Per Month (Last 12 Months)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end gap-1.5 h-40 pt-2">
                    {data.monthlyShipments.map(({ month, count }) => {
                      const pct = Math.max((count / maxShipments) * 100, count > 0 ? 4 : 0);
                      return (
                        <div key={month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                          <div
                            className="w-full rounded-t-md transition-all duration-300 relative group"
                            style={{
                              height: `${pct}%`,
                              backgroundColor: count > 0 ? "rgb(20 184 166)" : "rgb(229 231 235)",
                              minHeight: count > 0 ? "4px" : "2px",
                            }}
                          >
                            {count > 0 && (
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                                <div className="bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap">
                                  {count} items
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
            </div>

            {/* Customer Analytics Table */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Customer Analytics</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.customerAnalytics.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6 text-center">No customers found</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="px-4 py-3 bg-gray-50 border-b text-left text-xs font-medium text-gray-500 uppercase">Customer Name</th>
                          <th className="px-4 py-3 bg-gray-50 border-b text-right text-xs font-medium text-gray-500 uppercase">Total Orders</th>
                          <th className="px-4 py-3 bg-gray-50 border-b text-right text-xs font-medium text-gray-500 uppercase">Total Revenue (USD)</th>
                          <th className="px-4 py-3 bg-gray-50 border-b text-right text-xs font-medium text-gray-500 uppercase">Outstanding Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.customerAnalytics.map((c, i) => (
                          <tr key={c.id} className={i % 2 === 0 ? "" : "bg-gray-50"}>
                            <td className="px-4 py-3 text-sm font-medium text-gray-900">{c.name}</td>
                            <td className="px-4 py-3 text-sm text-gray-600 text-right">{c.totalOrders}</td>
                            <td className="px-4 py-3 text-sm text-gray-900 font-medium text-right">{formatCurrency(c.totalRevenue)}</td>
                            <td className="px-4 py-3 text-sm text-right">
                              {c.outstandingBalance > 0 ? (
                                <span className="text-amber-600 font-medium">{formatCurrency(c.outstandingBalance)}</span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Outstanding Payments Table */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Outstanding Payments</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.outstandingPayments.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6 text-center">No outstanding payments</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="px-4 py-3 bg-gray-50 border-b text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
                          <th className="px-4 py-3 bg-gray-50 border-b text-left text-xs font-medium text-gray-500 uppercase">Invoice ID</th>
                          <th className="px-4 py-3 bg-gray-50 border-b text-right text-xs font-medium text-gray-500 uppercase">Amount Due (USD)</th>
                          <th className="px-4 py-3 bg-gray-50 border-b text-left text-xs font-medium text-gray-500 uppercase">Invoice Date</th>
                          <th className="px-4 py-3 bg-gray-50 border-b text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.outstandingPayments.map((p, i) => (
                          <tr key={p.id} className={i % 2 === 0 ? "" : "bg-gray-50"}>
                            <td className="px-4 py-3 text-sm font-medium text-gray-900">{p.customerName}</td>
                            <td className="px-4 py-3 text-sm font-mono text-gray-600">{p.orderRef}</td>
                            <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">{formatCurrency(p.invoiceAmount)}</td>
                            <td className="px-4 py-3 text-sm text-gray-600">
                              {p.invoiceDate
                                ? new Date(p.invoiceDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                                : "—"}
                            </td>
                            <td className="px-4 py-3 text-sm">
                              <StatusBadge status={p.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
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
                    {data.topCustomers.slice(0, 5).map((c, i) => {
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
