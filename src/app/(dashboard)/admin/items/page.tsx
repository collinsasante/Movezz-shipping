"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
import { SearchBar } from "@/components/shared/SearchBar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusUpdateModal } from "@/components/shared/StatusUpdateModal";
import { Select } from "@/components/ui/select";
import { formatDateTime } from "@/lib/utils";
import type { Item, ItemStatus } from "@/types";
import { Plus, Package, Edit2, AlertTriangle, Trash2 } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";
import { ITEM_STATUS_STEPS } from "@/lib/utils";

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  ...ITEM_STATUS_STEPS.map((s) => ({ value: s, label: s })),
];

export default function ItemsPage() {
  const router = useRouter();
  const { error, success } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ItemStatus | "">("");
  const [statusModal, setStatusModal] = useState<{
    open: boolean;
    item?: Item;
  }>({ open: false });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(
    async (searchQuery?: string, statusF?: string, pageNum: number = 1) => {
      setLoading(true);
      try {
        const res = await axios.get("/api/items", {
          params: {
            search: searchQuery || undefined,
            status: statusF || undefined,
            page: pageNum,
            limit: 50,
          },
        });
        setItems(res.data.data);
        setTotalPages(res.data.totalPages ?? 1);
      } catch {
        error("Failed to load items");
      } finally {
        setLoading(false);
      }
    },
    [error]
  );

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await axios.delete(`/api/items/${id}`);
      success("Item deleted");
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch {
      error("Failed to delete item");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Items" subtitle="All packages in the system" />

      <div className="flex-1 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <SearchBar
              placeholder="Search items..."
              onSearch={(val) => {
                setSearch(val);
                setPage(1);
                load(val, statusFilter, 1);
              }}
              className="w-full sm:w-72"
            />
            <Select
              options={STATUS_OPTIONS}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as ItemStatus | "");
                setPage(1);
                load(search, e.target.value, 1);
              }}
              className="w-full sm:w-52"
            />
          </div>
          <Button onClick={() => router.push("/admin/items/new")} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            Receive Item
          </Button>
        </div>

        <DataTable
          columns={[
            {
              key: "itemRef",
              header: "Ref",
              render: (item) => (
                <span className="font-mono text-xs font-bold text-gray-800">
                  {item.itemRef}
                </span>
              ),
            },
            {
              key: "customerShippingMark",
              header: "Customer",
              render: (item) => (
                <div>
                  <p className="text-sm font-medium text-gray-800">
                    {item.customerName ?? "—"}
                  </p>
                  {item.customerShippingMark && (
                    <code className="text-xs font-mono text-gray-400">
                      {item.customerShippingMark}
                    </code>
                  )}
                </div>
              ),
            },
            {
              key: "description",
              header: "Description",
              render: (item) => (
                <span className="text-sm text-gray-700 truncate max-w-[200px] block">
                  {item.description}
                </span>
              ),
            },
            {
              key: "weight",
              header: "Weight / CBM",
              render: (item) => {
                if (item.shippingType === "sea" || (!item.shippingType && item.length && item.width && item.height)) {
                  if (item.length && item.width && item.height) {
                    const factor = item.dimensionUnit === "inches" ? 16.387064 : 1;
                    const cbm = (item.length * item.width * item.height * factor) / 1_000_000;
                    return <span className="text-sm">{cbm.toFixed(4)} m³</span>;
                  }
                }
                if (item.weight) return <span className="text-sm">{item.weight} kg</span>;
                return <span className="text-xs text-gray-400">—</span>;
              },
            },
            {
              key: "status",
              header: "Status",
              render: (item) => (
                <div className="flex items-center gap-2">
                  <StatusBadge status={item.status} />
                  {item.isMissing && (
                    <AlertTriangle
                      className="h-3.5 w-3.5 text-red-500"
                      aria-label="Item is flagged as missing"
                    />
                  )}
                </div>
              ),
            },
            {
              key: "trackingNumber",
              header: "Tracking #",
              render: (item) => (
                <span className="text-xs text-gray-500">
                  {item.trackingNumber ?? "—"}
                </span>
              ),
            },
            {
              key: "dateReceived",
              header: "Received",
              render: (item) => (
                <span className="text-xs text-gray-500">
                  {formatDateTime(item.dateReceived)}
                </span>
              ),
            },
            {
              key: "actions",
              header: "",
              render: (item) => (
                <div
                  className="flex items-center gap-1 justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {confirmDeleteId === item.id ? (
                    <>
                      <span className="text-xs text-red-600 mr-1">Delete?</span>
                      <button
                        onClick={() => handleDelete(item.id)}
                        disabled={deletingId === item.id}
                        className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                      >
                        {deletingId === item.id ? "..." : "Yes"}
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
                      <button
                        onClick={() => setStatusModal({ open: true, item })}
                        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-brand-600 transition-colors"
                        title="Update status"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(item.id)}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
                        title="Delete item"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
          data={items}
          keyExtractor={(item) => item.id}
          loading={loading}
          emptyMessage="No items found"
          emptyIcon={<Package className="h-12 w-12" />}
          onRowClick={(item) => router.push(`/admin/items/${item.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={(p) => { setPage(p); load(search, statusFilter, p); }}
        />
      </div>

      {/* Status Update Modal */}
      {statusModal.item && (
        <StatusUpdateModal
          open={statusModal.open}
          onClose={() => setStatusModal({ open: false })}
          itemId={statusModal.item.id}
          itemRef={statusModal.item.itemRef}
          currentStatus={statusModal.item.status}
          onSuccess={() => load(search, statusFilter)}
        />
      )}
    </div>
  );
}
