"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { formatDate } from "@/lib/utils";
import type { Container, Item, ContainerStatus } from "@/types";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Package,
  Trash2,
  RefreshCw,
  Container as ContainerIcon,
  Edit2,
  Check,
  X,
} from "lucide-react";
import axios from "axios";

interface ContainerDetail extends Container {
  items: Item[];
}

const STATUS_OPTIONS = [
  { value: "Loading", label: "Loading" },
  { value: "Shipped to Ghana", label: "Shipped to Ghana" },
  { value: "Arrived in Ghana", label: "Arrived in Ghana" },
  { value: "Completed", label: "Completed" },
];

export default function ContainerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { success, error } = useToast();
  const [container, setContainer] = useState<ContainerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [newStatus, setNewStatus] = useState<ContainerStatus>("Loading");
  const [itemSearch, setItemSearch] = useState("");
  const [itemResults, setItemResults] = useState<Item[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", trackingNumber: "", eta: "", notes: "" });
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`/api/containers/${id}`);
      setContainer(res.data.data);
      setNewStatus(res.data.data.status);
    } catch {
      error("Failed to load container");
    } finally {
      setLoading(false);
    }
  }, [id, error]);

  useEffect(() => { load(); }, [load]);

  const searchItems = useCallback(async (query: string) => {
    setSearchLoading(true);
    setSearchDone(false);
    try {
      const params = query.length >= 1 ? { search: query } : {};
      const res = await axios.get("/api/items", { params });
      const all: Item[] = res.data.data;
      setItemResults(all.filter((item) => !container?.items?.some((ci) => ci.id === item.id)));
    } catch { setItemResults([]); } finally {
      setSearchLoading(false);
      setSearchDone(true);
    }
  }, [container]);

  useEffect(() => {
    if (itemSearch.length === 0) { setItemResults([]); setSearchDone(false); return; }
    const timer = setTimeout(() => searchItems(itemSearch), 300);
    return () => clearTimeout(timer);
  }, [itemSearch, searchItems]);

  const openEdit = () => {
    if (!container) return;
    setEditForm({
      name: container.name ?? "",
      trackingNumber: container.trackingNumber ?? "",
      eta: container.eta?.split("T")[0] ?? "",
      notes: container.notes ?? "",
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      await axios.patch(`/api/containers/${id}`, {
        name: editForm.name || undefined,
        trackingNumber: editForm.trackingNumber || undefined,
        eta: editForm.eta || undefined,
        notes: editForm.notes || undefined,
      });
      success("Container updated");
      setEditing(false);
      load();
    } catch {
      error("Failed to update container");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await axios.delete(`/api/containers/${id}`);
      success("Container deleted");
      router.push("/admin/containers");
    } catch {
      error("Failed to delete container");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const updateStatus = async () => {
    if (!container || newStatus === container.status) return;
    setUpdatingStatus(true);
    try {
      const res = await axios.patch(`/api/containers/${id}/status`, {
        status: newStatus,
      });
      success("Status updated", res.data.message);
      load();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to update"
        : "Failed to update";
      error("Error", msg);
    } finally {
      setUpdatingStatus(false);
    }
  };

  const removeItem = async (itemId: string) => {
    try {
      await axios.delete(`/api/containers/${id}/items`, {
        data: { itemId },
      });
      success("Item removed from container");
      load();
    } catch {
      error("Failed to remove item");
    }
  };

  const addItem = async (itemId: string) => {
    try {
      await axios.post(`/api/containers/${id}/items`, { itemId });
      success("Item added to container");
      setItemSearch("");
      setItemResults([]);
      setSearchDone(false);
      load();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to add item"
        : "Failed to add item";
      error("Error", msg);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!container) return null;

  return (
    <div className="flex flex-col h-full">
      <Header
        title={container.containerId}
        subtitle={container.trackingNumber + (container.name ? ` · ${container.name}` : "")}
      />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Containers
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-600">Delete container?</span>
              <Button
                size="sm"
                variant="outline"
                className="border-red-300 text-red-600 hover:bg-red-50"
                loading={deleting}
                onClick={handleDelete}
              >
                Confirm
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 text-red-600 hover:bg-red-50"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              Delete Container
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Container Info Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <ContainerIcon className="h-5 w-5 text-brand-600" />
                  Container Info
                </span>
                {!editing ? (
                  <button onClick={openEdit} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
                    <Edit2 className="h-4 w-4" />
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <button onClick={saveEdit} disabled={savingEdit} className="p-1.5 rounded-lg hover:bg-green-50 text-green-600 transition-colors disabled:opacity-50">
                      <Check className="h-4 w-4" />
                    </button>
                    <button onClick={() => setEditing(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <InfoItem label="Container ID" value={container.containerId} mono />
              {editing ? (
                <div className="space-y-3">
                  <Input label="Container #" value={editForm.trackingNumber} onChange={(e) => setEditForm({ ...editForm, trackingNumber: e.target.value })} />
                  <Input label="Shipping Line (optional)" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="e.g. MSC, Maersk" />
                  <Input label="ETA" type="date" value={editForm.eta} onChange={(e) => setEditForm({ ...editForm, eta: e.target.value })} />
                  <Input label="Notes (optional)" value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
                </div>
              ) : (
                <>
                  <InfoItem label="Container #" value={container.trackingNumber} mono />
                  {container.name && <InfoItem label="Shipping Line" value={container.name} />}
                  <InfoItem label="Status">
                    <StatusBadge status={container.status} />
                  </InfoItem>
                  <InfoItem label="Total Items" value={String(container.items?.length ?? 0)} />
                  <InfoItem label="ETA" value={container.eta ? formatDate(container.eta) : "—"} />
                  <InfoItem label="Arrived" value={container.arrivalDate ? formatDate(container.arrivalDate) : "—"} />
                  <InfoItem label="Created" value={container.createdAt ? formatDate(container.createdAt) : "—"} />
                  {container.notes && <InfoItem label="Notes" value={container.notes} />}
                </>
              )}

              {/* Status Update */}
              <div className="pt-3 border-t border-gray-100 space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Update Status
                </p>
                <Select
                  options={STATUS_OPTIONS}
                  value={newStatus}
                  onChange={(e) =>
                    setNewStatus(e.target.value as ContainerStatus)
                  }
                />
                {newStatus === "Arrived in Ghana" && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-2">
                    This will automatically update all {container.items?.length} items to "Arrived in Ghana".
                  </p>
                )}
                <Button
                  className="w-full"
                  size="sm"
                  onClick={updateStatus}
                  loading={updatingStatus}
                  disabled={newStatus === container.status}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  Update Status
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Items Panel */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">
                Items ({container.items?.length ?? 0})
              </h3>

              {/* Add item search */}
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search by ref or shipping mark..."
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  onFocus={() => searchItems(itemSearch)}
                  onBlur={() => setTimeout(() => { setItemResults([]); setSearchDone(false); }, 200)}
                  className="h-8 text-xs px-3 border border-gray-200 rounded-lg w-56 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                {(searchLoading || searchDone) && (
                  <div className="absolute top-9 right-0 z-50 bg-white border border-gray-200 rounded-lg shadow-lg w-72 max-h-52 overflow-y-auto">
                    {searchLoading ? (
                      <p className="px-3 py-2 text-xs text-gray-400">Searching...</p>
                    ) : itemResults.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-gray-400">No items found</p>
                    ) : (
                      itemResults.map((item) => (
                        <button
                          key={item.id}
                          onMouseDown={() => addItem(item.id)}
                          className="w-full text-left px-3 py-2 hover:bg-brand-50 transition-colors border-b border-gray-50 last:border-0"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-brand-700">{item.itemRef}</span>
                            <code className="text-xs bg-gray-100 px-1 rounded">{item.customerShippingMark ?? "—"}</code>
                          </div>
                          <p className="text-xs text-gray-500 truncate mt-0.5">{item.description || "No description"}</p>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
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
                  key: "customerShippingMark",
                  header: "Customer",
                  render: (item) => (
                    <code className="text-xs font-mono bg-gray-100 px-1.5 py-0.5 rounded">
                      {item.customerShippingMark ?? "—"}
                    </code>
                  ),
                },
                {
                  key: "description",
                  header: "Description",
                  render: (item) => (
                    <span className="text-sm truncate max-w-[160px] block">
                      {item.description}
                    </span>
                  ),
                },
                {
                  key: "weight",
                  header: "Weight",
                  render: (item) => (
                    <span className="text-sm">{item.weight} kg</span>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (item) => <StatusBadge status={item.status} />,
                },
                {
                  key: "remove",
                  header: "",
                  render: (item) => (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm("Remove this item from the container?")) {
                          removeItem(item.id);
                        }
                      }}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ),
                },
              ]}
              data={container.items ?? []}
              keyExtractor={(item) => item.id}
              emptyMessage="No items in this container yet"
              emptyIcon={<Package className="h-10 w-10" />}
              onRowClick={(item) => router.push(`/admin/items/${item.id}`)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoItem({
  label,
  value,
  mono,
  children,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      {children ?? (
        <p
          className={`text-sm font-medium text-gray-900 ${
            mono ? "font-mono" : ""
          }`}
        >
          {value ?? "—"}
        </p>
      )}
    </div>
  );
}
