"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
import { SearchBar } from "@/components/shared/SearchBar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import type { Customer } from "@/types";
import { Plus, Users, Copy, CheckCheck, Pencil, Trash2 } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";
import { useRouter } from "next/navigation";

export default function CustomersPage() {
  const router = useRouter();
  const { error, success } = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(async (searchQuery?: string, pageNum: number = 1) => {
    setLoading(true);
    try {
      const res = await axios.get("/api/customers", {
        params: { search: searchQuery || undefined, page: pageNum, limit: 50 },
      });
      setCustomers(res.data.data);
      setTotalPages(res.data.totalPages ?? 1);
    } catch {
      error("Failed to load customers");
    } finally {
      setLoading(false);
    }
  }, [error]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSearch = (val: string) => {
    setSearch(val);
    setPage(1);
    load(val, 1);
  };

  const copyMark = async (mark: string, id: string) => {
    await navigator.clipboard.writeText(mark);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await axios.delete(`/api/customers/${id}`);
      success("Customer deleted");
      setCustomers((prev) => prev.filter((c) => c.id !== id));
    } catch {
      error("Failed to delete customer");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Customers" subtitle="Manage all customer accounts" />

      <div className="flex-1 p-6 space-y-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-4">
          <SearchBar
            placeholder="Search by name, email, shipping mark..."
            onSearch={handleSearch}
            className="w-80"
          />
          <Button onClick={() => router.push("/admin/customers/new")}>
            <Plus className="h-4 w-4 mr-2" />
            New Customer
          </Button>
        </div>

        <DataTable
          columns={[
            {
              key: "name",
              header: "Customer",
              render: (c) => (
                <div>
                  <p className="font-semibold text-sm text-gray-900">{c.name}</p>
                  <p className="text-xs text-gray-500">{c.email}</p>
                </div>
              ),
            },
            {
              key: "phone",
              header: "Phone",
              render: (c) => (
                <span className="text-sm text-gray-700">{c.phone}</span>
              ),
            },
            {
              key: "shippingMark",
              header: "Shipping Mark",
              render: (c) => (
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-gray-100 text-gray-800 px-2 py-0.5 rounded">
                    {c.shippingMark}
                  </code>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyMark(c.shippingMark, c.id);
                    }}
                    className="text-gray-400 hover:text-brand-600 transition-colors"
                  >
                    {copiedId === c.id ? (
                      <CheckCheck className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (c) => <StatusBadge status={c.status} />,
            },
            {
              key: "createdAt",
              header: "Created",
              render: (c) => (
                <span className="text-xs text-gray-500">
                  {formatDate(c.createdAt)}
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
                        onClick={() => router.push(`/admin/customers/${c.id}?edit=true`)}
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
          data={customers}
          keyExtractor={(c) => c.id}
          loading={loading}
          emptyMessage="No customers found"
          emptyIcon={<Users className="h-12 w-12" />}
          onRowClick={(c) => router.push(`/admin/customers/${c.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={(p) => { setPage(p); load(search, p); }}
        />
      </div>
    </div>
  );
}
