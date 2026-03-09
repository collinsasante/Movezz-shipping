"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
import { SearchBar } from "@/components/shared/SearchBar";
import { Button } from "@/components/ui/button";
import { FilterDropdown } from "@/components/ui/FilterDropdown";
import { useToast } from "@/components/ui/toast";
import type { Supplier } from "@/types";
import { Plus, Store, Star, Pencil, Trash2, ExternalLink } from "lucide-react";
import axios from "axios";

const CATEGORY_OPTIONS = [
  { value: "", label: "All categories" },
  { value: "Electronics", label: "Electronics" },
  { value: "Clothing", label: "Clothing" },
  { value: "Footwear", label: "Footwear" },
  { value: "Beauty", label: "Beauty" },
  { value: "Home & Garden", label: "Home & Garden" },
  { value: "Toys", label: "Toys" },
  { value: "Sports", label: "Sports" },
  { value: "Auto Parts", label: "Auto Parts" },
  { value: "Food & Supplements", label: "Food & Supplements" },
  { value: "Other", label: "Other" },
];

function StarRating({ value }: { value?: number }) {
  if (!value) return <span className="text-gray-400 text-xs">—</span>;
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`h-3 w-3 ${s <= value ? "fill-amber-400 text-amber-400" : "text-gray-200"}`}
        />
      ))}
    </div>
  );
}

export default function SuppliersPage() {
  const router = useRouter();
  const { error, success } = useToast();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [category, setCategory] = useState("");

  const load = useCallback(
    async (search?: string, pageNum: number = 1) => {
      setLoading(true);
      try {
        const res = await axios.get("/api/suppliers", {
          params: { search: search || undefined, page: pageNum, limit: 50 },
        });
        const data: Supplier[] = res.data.data;
        const filtered = category ? data.filter((s) => s.category === category) : data;
        setSuppliers(filtered);
        setTotalPages(res.data.totalPages ?? 1);
      } catch {
        error("Failed to load suppliers");
      } finally {
        setLoading(false);
      }
    },
    [error, category]
  );

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await axios.delete(`/api/suppliers/${id}`);
      success("Supplier deleted");
      setSuppliers((prev) => prev.filter((s) => s.id !== id));
    } catch {
      error("Failed to delete supplier");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Suppliers" subtitle="Manage your supplier contacts" />

      <div className="flex-1 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <SearchBar
              placeholder="Search suppliers..."
              onSearch={(val) => { setPage(1); load(val, 1); }}
              className="w-full sm:w-64"
            />
            <FilterDropdown
              options={CATEGORY_OPTIONS}
              value={category}
              onChange={(val) => { setCategory(val); setPage(1); }}
              placeholder="All categories"
              className="w-full sm:w-44"
            />
          </div>
          <Button onClick={() => router.push("/admin/suppliers/new")} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            Add Supplier
          </Button>
        </div>

        <DataTable
          columns={[
            {
              key: "supplierId",
              header: "ID",
              render: (s) => (
                <code className="text-xs font-mono font-bold text-gray-600">{s.supplierId}</code>
              ),
            },
            {
              key: "name",
              header: "Supplier Name",
              render: (s) => (
                <div>
                  <p className="text-sm font-semibold text-gray-900">{s.name}</p>
                  {s.contact && (
                    <p className="text-xs text-gray-500">{s.contact}</p>
                  )}
                </div>
              ),
            },
            {
              key: "category",
              header: "Category",
              render: (s) => s.category ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                  {s.category}
                </span>
              ) : <span className="text-gray-400 text-xs">—</span>,
            },
            {
              key: "platform",
              header: "Platform",
              render: (s) => (
                <div className="flex items-center gap-1">
                  {s.platform ? (
                    <>
                      <span className="text-sm text-gray-700">{s.platform}</span>
                      {s.platformLink && (
                        <a
                          href={s.platformLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-brand-500 hover:text-brand-700"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </>
                  ) : <span className="text-gray-400 text-xs">—</span>}
                </div>
              ),
            },
            {
              key: "rating",
              header: "Rating",
              render: (s) => <StarRating value={s.rating} />,
            },
            {
              key: "actions",
              header: "",
              render: (s) => (
                <div
                  className="flex items-center gap-1 justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {confirmDeleteId === s.id ? (
                    <>
                      <span className="text-xs text-red-600 mr-1">Delete?</span>
                      <button
                        onClick={() => handleDelete(s.id)}
                        disabled={deletingId === s.id}
                        className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                      >
                        {deletingId === s.id ? "..." : "Yes"}
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
                        onClick={() => router.push(`/admin/suppliers/${s.id}`)}
                        className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(s.id)}
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
          data={suppliers}
          keyExtractor={(s) => s.id}
          loading={loading}
          emptyMessage="No suppliers found"
          emptyIcon={<Store className="h-12 w-12" />}
          onRowClick={(s) => router.push(`/admin/suppliers/${s.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={(p) => { setPage(p); load(undefined, p); }}
        />
      </div>
    </div>
  );
}
