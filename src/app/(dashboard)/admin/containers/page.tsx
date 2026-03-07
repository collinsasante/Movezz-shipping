"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
import { SearchBar } from "@/components/shared/SearchBar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import type { Container } from "@/types";
import { Plus, Container as ContainerIcon, Pencil, Trash2 } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

export default function ContainersPage() {
  const router = useRouter();
  const { error, success } = useToast();
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(
    async (search?: string, pageNum: number = 1) => {
      setLoading(true);
      try {
        const res = await axios.get("/api/containers", {
          params: { search: search || undefined, page: pageNum, limit: 50 },
        });
        setContainers(res.data.data);
        setTotalPages(res.data.totalPages ?? 1);
      } catch {
        error("Failed to load containers");
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
      await axios.delete(`/api/containers/${id}`);
      success("Container deleted");
      setContainers((prev) => prev.filter((c) => c.id !== id));
    } catch {
      error("Failed to delete container");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Containers" subtitle="Manage shipment containers" />

      <div className="flex-1 p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <SearchBar
            placeholder="Search containers..."
            onSearch={(val) => { setPage(1); load(val, 1); }}
            className="w-72"
          />
          <Button onClick={() => router.push("/admin/containers/new")}>
            <Plus className="h-4 w-4 mr-2" />
            New Container
          </Button>
        </div>

        <DataTable
          columns={[
            {
              key: "containerId",
              header: "Container ID",
              render: (c) => (
                <code className="text-xs font-mono font-bold text-gray-800">
                  {c.containerId}
                </code>
              ),
            },
            {
              key: "name",
              header: "Container #",
              render: (c) => (
                <div>
                  <code className="font-mono text-xs font-bold text-gray-800">{c.trackingNumber || "—"}</code>
                  {c.name && <p className="text-xs text-gray-400">{c.name}</p>}
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (c) => <StatusBadge status={c.status} />,
            },
            {
              key: "itemCount",
              header: "Items",
              render: (c) => (
                <span className="bg-gray-100 text-gray-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                  {c.itemIds?.length ?? 0}
                </span>
              ),
            },
            {
              key: "eta",
              header: "ETA",
              render: (c) => (
                <span className="text-xs text-gray-500">
                  {c.eta ? formatDate(c.eta) : "—"}
                </span>
              ),
            },
            {
              key: "arrivalDate",
              header: "Arrival",
              render: (c) => (
                <span className="text-xs text-gray-500">
                  {c.arrivalDate ? formatDate(c.arrivalDate) : "—"}
                </span>
              ),
            },
            {
              key: "actions",
              header: "",
              render: (c) => (
                <div
                  className="flex items-center gap-1 justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {confirmDeleteId === c.id ? (
                    <>
                      <span className="text-xs text-red-600 mr-1">Delete?</span>
                      <button
                        onClick={() => handleDelete(c.id)}
                        disabled={deletingId === c.id}
                        className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                      >
                        {deletingId === c.id ? "..." : "Yes"}
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
                        onClick={() => router.push(`/admin/containers/${c.id}`)}
                        className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(c.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
          data={containers}
          keyExtractor={(c) => c.id}
          loading={loading}
          emptyMessage="No containers found"
          emptyIcon={<ContainerIcon className="h-12 w-12" />}
          onRowClick={(c) => router.push(`/admin/containers/${c.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={(p) => { setPage(p); load(undefined, p); }}
        />
      </div>
    </div>
  );
}
