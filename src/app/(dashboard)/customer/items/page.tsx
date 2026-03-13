"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
import { SearchBar } from "@/components/shared/SearchBar";
import { StatusBadge } from "@/components/ui/badge";
import { FilterDropdown } from "@/components/ui/FilterDropdown";
import { TrackingTimeline } from "@/components/shared/TrackingTimeline";
import { formatDate } from "@/lib/utils";
import { ITEM_STATUS_STEPS } from "@/lib/utils";
import type { Item, ItemStatus, StatusHistory } from "@/types";
import { Package, X, Hash } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  ...ITEM_STATUS_STEPS.map((s) => ({ value: s, label: s })),
];

const DATE_OPTIONS = [
  { value: "", label: "All time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
  { value: "custom", label: "Custom range" },
];

function applyDateFilter<T>(items: T[], getDate: (item: T) => string | undefined, range: string, from?: string, to?: string): T[] {
  if (!range) return items;
  if (range === "custom") {
    if (!from && !to) return items;
    return items.filter((item) => {
      const d = new Date(getDate(item) ?? "");
      if (isNaN(d.getTime())) return false;
      if (from && d < new Date(from)) return false;
      if (to) { const t = new Date(to); t.setHours(23, 59, 59, 999); if (d > t) return false; }
      return true;
    });
  }
  const now = new Date();
  const cutoff = new Date();
  if (range === "today") cutoff.setHours(0, 0, 0, 0);
  else if (range === "week") cutoff.setDate(cutoff.getDate() - 7);
  else if (range === "month") cutoff.setMonth(cutoff.getMonth() - 1);
  else if (range === "year") cutoff.setFullYear(cutoff.getFullYear() - 1);
  return items.filter((item) => {
    const d = new Date(getDate(item) ?? "");
    return !isNaN(d.getTime()) && d >= cutoff && d <= now;
  });
}

function DetailRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex justify-between py-1.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-xs font-medium text-gray-800 text-right max-w-[60%] break-words">{value}</span>
    </div>
  );
}


export default function CustomerItemsPage() {
  const { error } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ItemStatus | "">("");
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<StatusHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [dateRange, setDateRange] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = useCallback(
    async (search?: string, status?: string, pageNum: number = 1) => {
      setLoading(true);
      try {
        const res = await axios.get("/api/items", {
          params: {
            search: search || undefined,
            status: status || undefined,
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

  const fetchHistory = useCallback(async (itemId: string) => {
    setHistoryLoading(true);
    try {
      const res = await axios.get(`/api/items/${itemId}/history`);
      setSelectedHistory(res.data.data ?? []);
    } catch {
      setSelectedHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const selectItem = (item: Item) => {
    if (selectedItem?.id === item.id) {
      setSelectedItem(null);
      setSelectedHistory([]);
    } else {
      setSelectedItem(item);
      fetchHistory(item.id);
    }
  };

  useEffect(() => { load(); }, [load]);

  const dedupedItems = (() => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (!item.trackingNumber) return true;
      if (seen.has(item.trackingNumber)) return false;
      seen.add(item.trackingNumber);
      return true;
    });
  })();

  return (
    <div className="flex flex-col h-full">
      <Header title="My Items" subtitle="All your packages" />

      <div className="flex-1 flex overflow-hidden">
        {/* Items list */}
        <div className="flex-1 p-4 sm:p-6 space-y-4 overflow-y-auto">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <SearchBar
              placeholder="Search items..."
              onSearch={(val) => { setPage(1); load(val, statusFilter, 1); }}
              className="w-full sm:w-64"
            />
            <FilterDropdown
              options={STATUS_OPTIONS}
              value={statusFilter}
              onChange={(val) => {
                setStatusFilter(val as ItemStatus | "");
                setPage(1);
                load("", val, 1);
              }}
              className="w-full sm:w-52"
            />
            <FilterDropdown
              options={DATE_OPTIONS}
              value={dateRange}
              onChange={(val) => { setDateRange(val); setPage(1); }}
              className="w-full sm:w-40"
            />
            {dateRange === "custom" && (
              <div className="flex items-center gap-1">
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-10 rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                <span className="text-gray-400 text-sm px-0.5">–</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-10 rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
            )}
          </div>

          <DataTable
            columns={[
              {
                key: "itemRef",
                header: "Ref",
                render: (item) => (
                  <span className="font-mono text-xs font-bold">
                    {item.itemRef}
                  </span>
                ),
              },
              {
                key: "description",
                header: "Description",
                render: (item) => (
                  <span className="text-sm text-gray-800">{item.description}</span>
                ),
              },
              {
                key: "trackingNumber",
                header: "Tracking #",
                render: (item) => item.trackingNumber ? (
                  <div className="flex items-center gap-1.5">
                    <Hash className="h-3 w-3 text-gray-400 shrink-0" />
                    <span className="text-xs font-mono text-gray-600">{item.trackingNumber}</span>
                  </div>
                ) : (
                  <span className="text-xs text-gray-300">—</span>
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
                render: (item) => <StatusBadge status={item.status} />,
              },
              {
                key: "dateReceived",
                header: "Received",
                render: (item) => (
                  <span className="text-xs text-gray-500">
                    {formatDate(item.dateReceived)}
                  </span>
                ),
              },
            ]}
            data={applyDateFilter(dedupedItems, (i) => i.dateReceived, dateRange, dateFrom, dateTo)}
            keyExtractor={(item) => item.id}
            loading={loading}
            emptyMessage="No items found"
            emptyIcon={<Package className="h-12 w-12" />}
            onRowClick={selectItem}
            rowClassName={(item) => selectedItem?.id === item.id ? "bg-brand-50" : ""}
            page={page}
            totalPages={totalPages}
            onPageChange={(p) => { setPage(p); load(undefined, statusFilter, p); }}
          />
        </div>

        {/* Detail + Tracking Panel — full screen on mobile, side panel on desktop */}
        {selectedItem && (
          <div className="fixed inset-0 z-50 bg-white overflow-y-auto md:relative md:inset-auto md:z-auto md:w-[22rem] md:border-l md:border-gray-200 md:shrink-0">
            {/* Panel header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
              <div>
                <p className="font-mono font-bold text-sm text-gray-900">{selectedItem.itemRef}</p>
                <StatusBadge status={selectedItem.status} />
              </div>
              <button
                onClick={() => { setSelectedItem(null); setSelectedHistory([]); }}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* Photos */}
              {selectedItem.photos && selectedItem.photos.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Photos</p>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {selectedItem.photos.map((photo) => (
                      <a key={photo.id} href={photo.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                        <img
                          src={photo.url}
                          alt={photo.filename}
                          className="h-24 w-24 object-cover rounded-xl border border-gray-200 hover:opacity-90 transition-opacity"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Description */}
              {selectedItem.description && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Description</p>
                  <p className="text-sm text-gray-800">{selectedItem.description}</p>
                </div>
              )}

              {/* Item details */}
              <div className="bg-gray-50 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Details</p>
                {selectedItem.quantity && <DetailRow label="Quantity" value={String(selectedItem.quantity)} />}
                {selectedItem.estPrice != null && <DetailRow label="Est. Item Price" value={`GH₵ ${selectedItem.estPrice.toFixed(2)}`} />}
                {selectedItem.estShippingPrice != null && <DetailRow label="Est. Shipping Cost" value={`GH₵ ${selectedItem.estShippingPrice.toFixed(2)}`} />}
                {selectedItem.shippingType === "sea" && selectedItem.length && selectedItem.width && selectedItem.height ? (
                  <DetailRow
                    label="CBM"
                    value={`${((selectedItem.length * selectedItem.width * selectedItem.height * (selectedItem.dimensionUnit === "inches" ? 16.387064 : 1)) / 1_000_000).toFixed(4)} m³`}
                  />
                ) : selectedItem.weight ? (
                  <DetailRow label="Weight" value={`${selectedItem.weight} kg`} />
                ) : null}
                {selectedItem.length && selectedItem.width && selectedItem.height && (
                  <DetailRow label="Dimensions" value={`${selectedItem.length} × ${selectedItem.width} × ${selectedItem.height} ${selectedItem.dimensionUnit}`} />
                )}
                <DetailRow label="Date Received" value={formatDate(selectedItem.dateReceived)} />
                {selectedItem.trackingNumber && <DetailRow label="Tracking Number" value={selectedItem.trackingNumber} />}
                {selectedItem.containerName && <DetailRow label="Container" value={selectedItem.containerName} />}
                {selectedItem.orderRef && <DetailRow label="Invoice" value={selectedItem.orderRef} />}
                {selectedItem.notes && <DetailRow label="Notes" value={selectedItem.notes} />}
              </div>

              {/* Tracking timeline */}
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Shipment Progress</p>
                {historyLoading ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-8 bg-gray-100 rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : (
                  <TrackingTimeline
                    currentStatus={selectedItem.status}
                    history={selectedHistory.length > 0 ? selectedHistory : (
                      selectedItem.dateReceived ? [{
                        id: "synthetic-received",
                        recordType: "Item" as const,
                        recordId: selectedItem.id,
                        recordRef: selectedItem.itemRef ?? "",
                        previousStatus: "",
                        newStatus: "Arrived at Transit Warehouse",
                        changedBy: "",
                        changedByRole: "warehouse_staff" as const,
                        changedAt: selectedItem.dateReceived,
                      }] : []
                    )}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
