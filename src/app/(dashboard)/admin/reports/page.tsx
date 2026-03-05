"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { StatusBadge } from "@/components/ui/badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { formatDateTime } from "@/lib/utils";
import type { StatusHistory } from "@/types";
import { History, ArrowRight } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

const RECORD_FILTERS = ["All", "Item", "Container", "Order"] as const;

export default function ReportsPage() {
  const router = useRouter();
  const { error } = useToast();
  const [statusHistory, setStatusHistory] = useState<StatusHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [recordFilter, setRecordFilter] = useState<string>("All");

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await axios.get("/api/activity-logs?type=status");
        setStatusHistory(res.data.data);
      } catch {
        error("Failed to load status history");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [error]);

  const filtered = useMemo(() => {
    return statusHistory.filter((h) => {
      if (recordFilter !== "All" && h.recordType !== recordFilter) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        h.recordRef?.toLowerCase().includes(q) ||
        h.changedBy?.toLowerCase().includes(q) ||
        h.newStatus?.toLowerCase().includes(q) ||
        h.previousStatus?.toLowerCase().includes(q)
      );
    });
  }, [statusHistory, recordFilter, search]);

  function navigateToRecord(h: StatusHistory) {
    if (h.recordType === "Item") router.push(`/admin/items/${h.recordId}`);
    else if (h.recordType === "Order") router.push(`/admin/orders/${h.recordId}`);
    else if (h.recordType === "Container") router.push(`/admin/containers/${h.recordId}`);
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="Status History" subtitle="Full audit trail of all status changes" />

      <div className="flex-1 p-6 space-y-4 overflow-y-auto">
        {!loading && (
          <div className="bg-white border border-gray-100 rounded-xl px-4 py-2.5 flex items-center gap-2 w-fit">
            <History className="h-4 w-4 text-purple-500" />
            <span className="text-sm font-semibold text-gray-900">{statusHistory.length}</span>
            <span className="text-xs text-gray-400">status changes</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex gap-1">
            {RECORD_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setRecordFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  recordFilter === f
                    ? "bg-brand-600 text-white"
                    : "bg-white border border-gray-200 text-gray-500 hover:text-gray-800"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <SearchBar
            placeholder="Search records..."
            onSearch={setSearch}
            className="w-56"
          />
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin h-6 w-6 border-4 border-brand-600 border-t-transparent rounded-full" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16">
              <History className="h-10 w-10 text-gray-200 mx-auto mb-2" />
              <p className="text-sm text-gray-400">No status history found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Time</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Record</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">From</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide"></th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">To</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Changed By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map((h) => (
                    <tr
                      key={h.id}
                      onClick={() => navigateToRecord(h)}
                      className="hover:bg-gray-50/50 transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-xs text-gray-400 font-mono">
                          {formatDateTime(h.changedAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-xs font-semibold text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">
                          {h.recordType}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <code className="text-xs font-mono font-bold text-brand-700">
                          {h.recordRef}
                        </code>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {h.previousStatus ? (
                          <StatusBadge status={h.previousStatus} />
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <ArrowRight className="h-3.5 w-3.5 text-gray-300" />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <StatusBadge status={h.newStatus} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="text-xs text-gray-600">{h.changedBy}</p>
                        <p className="text-xs text-gray-400 capitalize">
                          {h.changedByRole?.replace(/_/g, " ")}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!loading && (
          <p className="text-xs text-gray-400 text-right">
            {filtered.length} of {statusHistory.length} entries
          </p>
        )}
      </div>
    </div>
  );
}
