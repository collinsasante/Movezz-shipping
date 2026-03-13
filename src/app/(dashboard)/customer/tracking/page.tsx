"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Header } from "@/components/layout/Header";
import { TrackingTimeline } from "@/components/shared/TrackingTimeline";
import { StatusBadge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import type { Item, StatusHistory } from "@/types";
import { Package, Search, ArrowLeft } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

export default function CustomerTrackingPage() {
  const { error } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<StatusHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [search, setSearch] = useState("");
  const panelPushedRef = useRef(false);

  // Push a history entry when panel opens so native back closes it, not navigates away
  useEffect(() => {
    if (selectedItem) {
      if (!panelPushedRef.current) {
        window.history.pushState({ panel: "tracking" }, "");
        panelPushedRef.current = true;
      }
    } else {
      panelPushedRef.current = false;
    }
  }, [selectedItem]);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      if (e.state?.panel === "tracking" || panelPushedRef.current) {
        // Back was pressed while panel was open — close panel instead
        setSelectedItem(null);
        setSelectedHistory([]);
        panelPushedRef.current = false;
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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

  const selectItem = useCallback((item: Item) => {
    setSelectedItem(item);
    fetchHistory(item.id);
  }, [fetchHistory]);

  const load = useCallback(
    async (searchQuery?: string) => {
      setLoading(true);
      try {
        const res = await axios.get("/api/items", {
          params: { search: searchQuery || undefined },
        });
        const data: Item[] = res.data.data;
        setItems(data);
      } catch {
        error("Failed to load items");
      } finally {
        setLoading(false);
      }
    },
    [error]
  );

  useEffect(() => { load(); }, [load]);

  // Deduplicate by tracking number, then apply search
  const dedupedItems = (() => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (!item.trackingNumber) return true;
      if (seen.has(item.trackingNumber)) return false;
      seen.add(item.trackingNumber);
      return true;
    });
  })();

  const filteredItems = dedupedItems.filter(
    (item) =>
      !search ||
      item.description.toLowerCase().includes(search.toLowerCase()) ||
      item.itemRef.toLowerCase().includes(search.toLowerCase()) ||
      (item.trackingNumber ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full">
      <Header title="Package Tracking" subtitle="Track all your shipments" />

      <div className="flex-1 flex overflow-hidden">
        {/* Items list — full width on mobile, fixed sidebar on desktop */}
        <div className="flex-1 md:flex-none md:w-80 md:border-r md:border-gray-200 bg-white flex flex-col overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="search"
                placeholder="Search packages..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-full pl-9 pr-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
            {loading ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />
                ))}
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="p-8 text-center">
                <Package className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                <p className="text-sm text-gray-400">No packages found</p>
              </div>
            ) : (
              filteredItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => selectItem(item)}
                  className={`w-full flex items-start gap-3 p-4 text-left transition-colors ${
                    selectedItem?.id === item.id
                      ? "bg-brand-50 border-r-2 border-brand-500"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <div className="w-9 h-9 rounded-xl bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
                    <Package className="h-4 w-4 text-gray-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs font-bold text-gray-700">{item.itemRef}</p>
                    <p className="text-sm text-gray-800 truncate">{item.description}</p>
                    <div className="mt-1">
                      <StatusBadge status={item.status} />
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Tracking detail — full screen overlay on mobile, inline panel on desktop */}
        {selectedItem && (
          <div className="fixed inset-0 z-50 bg-white overflow-y-auto md:relative md:inset-auto md:z-auto md:flex-1 md:p-8">
            {/* Mobile header with back button */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 sticky top-0 bg-white z-10 md:hidden">
              <button
                onClick={() => { if (panelPushedRef.current) { window.history.back(); } else { setSelectedItem(null); setSelectedHistory([]); } }}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="flex-1 min-w-0">
                <p className="font-mono font-bold text-sm text-gray-900 truncate">{selectedItem.itemRef}</p>
              </div>
              <StatusBadge status={selectedItem.status} />
            </div>

            <div className="p-5 md:p-0 md:max-w-lg">
              {/* Item header — desktop only (mobile has its own above) */}
              <div className="hidden md:block mb-6">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-mono font-bold text-lg text-gray-900">{selectedItem.itemRef}</p>
                    <p className="text-gray-600">{selectedItem.description}</p>
                  </div>
                  <StatusBadge status={selectedItem.status} />
                </div>
                <div className="flex flex-wrap gap-4 text-sm text-gray-500 mt-3">
                  {selectedItem.weight && <span>Weight: {selectedItem.weight} kg</span>}
                  {selectedItem.trackingNumber && (
                    <span>Tracking: <code className="font-mono">{selectedItem.trackingNumber}</code></span>
                  )}
                  <span>Received: {formatDate(selectedItem.dateReceived)}</span>
                </div>
              </div>

              {/* Mobile item description */}
              <div className="md:hidden mb-4">
                <p className="text-base text-gray-800 font-medium">{selectedItem.description}</p>
                <div className="flex flex-wrap gap-3 text-sm text-gray-500 mt-2">
                  {selectedItem.weight && <span>Weight: {selectedItem.weight} kg</span>}
                  {selectedItem.trackingNumber && (
                    <span>Tracking: <code className="font-mono text-xs">{selectedItem.trackingNumber}</code></span>
                  )}
                  <span>Received: {formatDate(selectedItem.dateReceived)}</span>
                </div>
              </div>

              {/* Timeline */}
              <div className="bg-white border border-gray-100 rounded-xl p-5">
                <h3 className="font-semibold text-gray-900 mb-5">Shipment Timeline</h3>
                {historyLoading ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : (
                  <TrackingTimeline currentStatus={selectedItem.status} history={selectedHistory} />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Desktop empty state */}
        {!selectedItem && (
          <div className="hidden md:flex flex-1 flex-col items-center justify-center h-full text-center">
            <Package className="h-12 w-12 text-gray-200 mb-3" />
            <p className="text-gray-500">Select a package to track it</p>
          </div>
        )}
      </div>
    </div>
  );
}
