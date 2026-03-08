"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { SearchBar } from "@/components/shared/SearchBar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { Item } from "@/types";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  SortAsc,
  ChevronDown,
  ChevronRight,
  Package,
} from "lucide-react";
import axios from "axios";

type Tab = "sorting" | "missing";

interface ContainerGroup {
  containerId: string;
  containerName: string;
  items: Item[];
}

function groupByContainer(items: Item[]): ContainerGroup[] {
  const map = new Map<string, ContainerGroup>();
  for (const item of items) {
    const key = item.containerId ?? "__none__";
    const name = item.containerName ?? item.containerId ?? "No Container";
    if (!map.has(key)) map.set(key, { containerId: key, containerName: name, items: [] });
    map.get(key)!.items.push(item);
  }
  return Array.from(map.values());
}

export default function SortingPage() {
  const { success, error } = useToast();
  const [tab, setTab] = useState<Tab>("sorting");
  const [sortingItems, setSortingItems] = useState<Item[]>([]);
  const [missingItems, setMissingItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (search?: string) => {
      setLoading(true);
      try {
        const res = await axios.get("/api/sorting", {
          params: { search: search || undefined, missing: true },
        });
        const sorting: Item[] = res.data.data.sorting;
        setSortingItems(sorting);
        setMissingItems(res.data.data.missing ?? []);
        // Auto-expand all container groups on first load
        const ids = new Set(sorting.map((i) => i.containerId ?? "__none__"));
        setExpanded(ids);
      } catch {
        error("Failed to load sorting items");
      } finally {
        setLoading(false);
      }
    },
    [error]
  );

  useEffect(() => { load(); }, [load]);

  const handleFound = async (item: Item) => {
    setActionLoading(item.id);
    try {
      await axios.post("/api/sorting", { itemId: item.id, action: "found" });
      success("Item found!", `${item.itemRef} → Ready for Pickup`);
      load();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error ?? "Action failed" : "Action failed";
      error("Error", msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleMissing = async (item: Item) => {
    setActionLoading(item.id);
    try {
      await axios.post("/api/sorting", { itemId: item.id, action: "missing" });
      success("Flagged as missing", `${item.itemRef} added to lost items report`);
      load();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error ?? "Action failed" : "Action failed";
      error("Error", msg);
    } finally {
      setActionLoading(null);
    }
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const sortingGroups = groupByContainer(sortingItems);

  return (
    <div className="flex flex-col h-full">
      <Header title="Sorting Dashboard" subtitle="Process items arriving in Ghana" />

      <div className="flex-1 p-6 space-y-4 overflow-y-auto">
        {/* Summary chips */}
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 bg-yellow-50 border border-yellow-100 rounded-xl px-4 py-2.5">
            <SortAsc className="h-4 w-4 text-yellow-600" />
            <span className="text-sm font-semibold text-yellow-800">
              {sortingItems.length} in sorting
            </span>
          </div>
          <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-xl px-4 py-2.5">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <span className="text-sm font-semibold text-red-800">
              {missingItems.length} missing
            </span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
          <button
            onClick={() => setTab("sorting")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "sorting" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Sorting ({sortingItems.length})
          </button>
          <button
            onClick={() => setTab("missing")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "missing" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Missing ({missingItems.length})
          </button>
        </div>

        <SearchBar
          placeholder="Search items..."
          onSearch={load}
          className="w-full sm:w-72"
        />

        {/* Sorting tab — grouped by container */}
        {tab === "sorting" && (
          <div className="space-y-3">
            {loading ? (
              [1, 2].map((i) => (
                <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
              ))
            ) : sortingGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <SortAsc className="h-12 w-12 text-gray-200 mb-3" />
                <p className="text-sm text-gray-400">No items in sorting</p>
              </div>
            ) : (
              sortingGroups.map((group) => {
                const isOpen = expanded.has(group.containerId);
                return (
                  <div key={group.containerId} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    {/* Container header */}
                    <button
                      onClick={() => toggleExpand(group.containerId)}
                      className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        {isOpen
                          ? <ChevronDown className="h-4 w-4 text-gray-400" />
                          : <ChevronRight className="h-4 w-4 text-gray-400" />
                        }
                        <Package className="h-4 w-4 text-brand-600" />
                        <span className="font-semibold text-gray-900 text-sm">{group.containerName}</span>
                        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                          {group.items.length} item{group.items.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </button>

                    {/* Items list */}
                    {isOpen && (
                      <div className="border-t border-gray-100 divide-y divide-gray-50">
                        {group.items.map((item) => (
                          <div key={item.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 py-3 gap-2 hover:bg-gray-50">
                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                              <span className="font-mono text-xs font-bold text-gray-700 shrink-0">
                                {item.itemRef}
                              </span>
                              {item.customerShippingMark && (
                                <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded shrink-0">
                                  {item.customerShippingMark}
                                </code>
                              )}
                              {item.description && (
                                <span className="text-xs text-gray-500 truncate">
                                  {item.description}
                                </span>
                              )}
                              <span className="text-xs text-gray-400 shrink-0">{item.weight} kg</span>
                              <StatusBadge status={item.status} />
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Button
                                size="sm"
                                variant="success"
                                onClick={() => handleFound(item)}
                                loading={actionLoading === item.id}
                                disabled={!!actionLoading}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                                Found
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => handleMissing(item)}
                                loading={actionLoading === item.id}
                                disabled={!!actionLoading}
                              >
                                <XCircle className="h-3.5 w-3.5 mr-1" />
                                Missing
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Missing tab — flat list */}
        {tab === "missing" && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {loading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : missingItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <AlertTriangle className="h-12 w-12 text-gray-200 mb-3" />
                <p className="text-sm text-gray-400">No missing items</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {missingItems.map((item) => (
                  <div key={item.id} className="flex items-center gap-4 px-5 py-3">
                    <span className="font-mono text-xs font-bold text-gray-700">{item.itemRef}</span>
                    {item.customerShippingMark && (
                      <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                        {item.customerShippingMark}
                      </code>
                    )}
                    {item.containerName && (
                      <span className="text-xs text-gray-400">📦 {item.containerName}</span>
                    )}
                    {item.description && (
                      <span className="text-xs text-gray-500 truncate">{item.description}</span>
                    )}
                    <span className="text-xs text-gray-400 ml-auto">{item.weight} kg</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
