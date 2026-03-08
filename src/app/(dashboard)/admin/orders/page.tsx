"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
import { SearchBar } from "@/components/shared/SearchBar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Order, OrderStatus } from "@/types";
import { Plus, ShoppingCart, CheckCircle, Trash2, ExternalLink } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "Pending", label: "Pending" },
  { value: "Paid", label: "Paid" },
];

export default function OrdersPage() {
  const router = useRouter();
  const { success, error } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "">("");
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(
    async (searchQuery?: string, statusF?: string, pageNum: number = 1) => {
      setLoading(true);
      try {
        const res = await axios.get("/api/orders", {
          params: {
            search: searchQuery || undefined,
            status: statusF || undefined,
            page: pageNum,
            limit: 50,
          },
        });
        setOrders(res.data.data);
        setTotalPages(res.data.totalPages ?? 1);
      } catch {
        error("Failed to load orders");
      } finally {
        setLoading(false);
      }
    },
    [error]
  );

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await axios.delete(`/api/orders/${id}`);
      success("Order deleted");
      setOrders((prev) => prev.filter((o) => o.id !== id));
    } catch {
      error("Failed to delete order");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const markAsPaid = async (orderId: string, orderRef: string) => {
    setMarkingPaid(orderId);
    try {
      await axios.patch(`/api/orders/${orderId}`, { status: "Paid" });
      success("Order marked as paid!", orderRef);
      load(search, statusFilter, page);
    } catch {
      error("Failed to update order");
    } finally {
      setMarkingPaid(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Invoices" subtitle="All customer invoices and payments" />

      <div className="flex-1 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <SearchBar
              placeholder="Search orders..."
              onSearch={(val) => {
                setSearch(val);
                setPage(1);
                load(val, statusFilter, 1);
              }}
              className="w-full sm:w-64"
            />
            <Select
              options={STATUS_OPTIONS}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as OrderStatus | "");
                setPage(1);
                load(search, e.target.value, 1);
              }}
              className="w-full sm:w-36"
            />
          </div>
          <Button onClick={() => router.push("/admin/orders/new")} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            New Invoice
          </Button>
        </div>

        <DataTable
          columns={[
            {
              key: "orderRef",
              header: "Order Ref",
              render: (o) => (
                <span className="font-mono text-xs font-bold text-gray-800">
                  {o.orderRef}
                </span>
              ),
            },
            {
              key: "customerName",
              header: "Customer",
              render: (o) => (
                <span className="text-sm">
                  {o.customerName ?? "—"}
                </span>
              ),
            },
            {
              key: "itemIds",
              header: "Items",
              render: (o) => (
                <span className="bg-gray-100 text-gray-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                  {o.itemIds?.length ?? 0}
                </span>
              ),
            },
            {
              key: "invoiceAmount",
              header: "Amount",
              render: (o) => (
                <span className="font-bold text-sm">
                  {formatCurrency(o.invoiceAmount)}
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (o) => <StatusBadge status={o.status} />,
            },
            {
              key: "invoiceDate",
              header: "Date",
              render: (o) => (
                <span className="text-xs text-gray-500">
                  {formatDate(o.invoiceDate)}
                </span>
              ),
            },
            {
              key: "actions",
              header: "",
              render: (o) => (
                <div
                  className="flex items-center gap-1 justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {confirmDeleteId === o.id ? (
                    <>
                      <span className="text-xs text-red-600 mr-1">Delete?</span>
                      <button
                        onClick={() => handleDelete(o.id)}
                        disabled={deletingId === o.id}
                        className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                      >
                        {deletingId === o.id ? "..." : "Yes"}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                      >
                        No
                      </button>
                    </>
                  ) : (
                    <>
                      {o.keepupLink && (
                        <a
                          href={o.keepupLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors"
                          title="View Keepup invoice"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                      {o.status === "Pending" && (
                        <Button
                          size="sm"
                          variant="success"
                          onClick={() => markAsPaid(o.id, o.orderRef)}
                          loading={markingPaid === o.id}
                        >
                          <CheckCircle className="h-3.5 w-3.5 mr-1" />
                          Mark Paid
                        </Button>
                      )}
                      <button
                        onClick={() => setConfirmDeleteId(o.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        title="Delete order"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
          data={orders}
          keyExtractor={(o) => o.id}
          loading={loading}
          emptyMessage="No orders found"
          emptyIcon={<ShoppingCart className="h-12 w-12" />}
          onRowClick={(o) => router.push(`/admin/orders/${o.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={(p) => { setPage(p); load(search, statusFilter, p); }}
        />
      </div>
    </div>
  );
}
