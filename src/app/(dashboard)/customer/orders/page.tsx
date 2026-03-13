"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { StatusBadge } from "@/components/ui/badge";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Order } from "@/types";
import { ShoppingCart, ChevronRight } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";
import { useRouter } from "next/navigation";

export default function CustomerOrdersPage() {
  const { error } = useToast();
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/orders");
      setOrders(res.data.data);
    } catch {
      error("Failed to load orders");
    } finally {
      setLoading(false);
    }
  }, [error]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="My Invoices" subtitle="Tap an invoice to view details" />

      <div className="flex-1 p-4 sm:p-6 space-y-3 overflow-y-auto">
        {orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <ShoppingCart className="h-12 w-12 text-gray-200 mb-3" />
            <p className="text-gray-500">No invoices yet</p>
          </div>
        ) : (
          orders.map((order) => (
            <button
              key={order.id}
              onClick={() => router.push(`/customer/orders/${order.id}`)}
              className="w-full flex items-center justify-between p-4 bg-white border border-gray-200 rounded-xl hover:border-brand-200 hover:bg-brand-50/30 transition-all shadow-sm text-left"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center shrink-0">
                  <ShoppingCart className="h-5 w-5 text-brand-600" />
                </div>
                <div>
                  <p className="font-mono font-bold text-gray-900">{order.orderRef}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {formatDate(order.invoiceDate)} · {order.itemIds?.length ?? 0} item(s)
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <p className="font-bold text-gray-900">{formatCurrency(order.invoiceAmount)}</p>
                  <StatusBadge status={order.status} />
                </div>
                <ChevronRight className="h-4 w-4 text-gray-300" />
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
