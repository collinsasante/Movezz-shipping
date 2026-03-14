"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusUpdateModal } from "@/components/shared/StatusUpdateModal";
import { TrackingTimeline } from "@/components/shared/TrackingTimeline";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { Item, StatusHistory } from "@/types";
import {
  ArrowLeft,
  Package,
  Camera,
  X,
  User,
  Scale,
  Hash,
  Calendar,
  Container,
  ShoppingCart,
  AlertTriangle,
  Loader2,
  Trash2,
  Edit2,
  DollarSign,
} from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";
import { uploadPhotos } from "@/lib/uploadPhotos";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

interface ItemDetail extends Item {}

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-gray-50 last:border-0">
      <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="h-4 w-4 text-gray-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-400 font-medium">{label}</p>
        <p className="text-sm text-gray-900 font-medium mt-0.5">{value ?? "—"}</p>
      </div>
    </div>
  );
}

export default function AdminItemDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { success, error } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [item, setItem] = useState<ItemDetail | null>(null);
  const [history, setHistory] = useState<StatusHistory[]>([]);
  const [containerDisplayName, setContainerDisplayName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusModal, setStatusModal] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editModal, setEditModal] = useState(false);
  const [editForm, setEditForm] = useState({
    description: "",
    weight: "",
    length: "",
    width: "",
    height: "",
    dimensionUnit: "cm" as "cm" | "inches",
    trackingNumber: "",
    dateReceived: "",
    notes: "",
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [customerPackage, setCustomerPackage] = useState<string>("basic");
  const [pkgEstimate, setPkgEstimate] = useState<{ amount: string; rateStr: string; label: string } | null>(null);
  const [specialEstimate, setSpecialEstimate] = useState<{ amount: string; rateStr: string; label: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [itemRes, historyRes] = await Promise.all([
        axios.get(`/api/items/${id}`),
        axios.get(`/api/items/${id}/history`),
      ]);
      const loadedItem: ItemDetail = itemRes.data.data;
      setItem(loadedItem);
      // Resolve container display name if lookup field is empty
      if (loadedItem.containerId && !loadedItem.containerName) {
        axios.get(`/api/containers/${loadedItem.containerId}`).then((r) => {
          setContainerDisplayName(r.data.data?.containerId ?? null);
        }).catch(() => {});
      } else {
        setContainerDisplayName(loadedItem.containerName ?? null);
      }
      const historyData = historyRes.data.data ?? [];
      setHistory(historyData);
      // Fetch customer package tier for pricing estimate
      if (loadedItem.customerId) {
        axios.get(`/api/customers/${loadedItem.customerId}`).then((r) => {
          setCustomerPackage(r.data.data?.package ?? "basic");
        }).catch(() => {});
      }
    } catch {
      error("Failed to load item");
    } finally {
      setLoading(false);
    }
  }, [id, error]);

  useEffect(() => { load(); }, [load]);

  // Compute live shipping estimates: package base + special surcharge (additive)
  useEffect(() => {
    if (!item) return;
    try {
      const pkgRates = JSON.parse(localStorage.getItem("pakk_package_rates") ?? "{}") as Record<string, { sea?: number; air?: number }>;
      const specialRatesRaw = JSON.parse(localStorage.getItem("pakk_special_rates") ?? "[]") as { id: string; name: string; sea: number; air: number }[];
      const qty = item.quantity ?? 1;

      function calcCost(seaRate: number, airRate: number): number {
        if (item!.shippingType === "air" && item!.weight) return item!.weight * qty * airRate;
        if (item!.length && item!.width && item!.height) {
          const factor = item!.dimensionUnit === "inches" ? 0.000016387 : 0.000001;
          return item!.length * item!.width * item!.height * factor * qty * seaRate;
        }
        return 0;
      }

      // Package tier (basic/business/enterprise)
      const tierKey = ["basic", "business", "enterprise", "special"].includes(customerPackage.toLowerCase()) ? customerPackage : "basic";
      const tierRates = pkgRates[tierKey] ?? { sea: 0, air: 0 };
      const tierLabel = tierKey.charAt(0).toUpperCase() + tierKey.slice(1);
      const pkgCost = calcCost(tierRates.sea ?? 0, tierRates.air ?? 0);
      setPkgEstimate(pkgCost > 0 ? { amount: pkgCost.toFixed(2), rateStr: item.shippingType === "air" ? `$${tierRates.air}/kg` : `$${tierRates.sea}/m³`, label: tierLabel } : null);

      // Special surcharge — matched by item's saved specialRateName
      const specialMatch = item.specialRateName
        ? specialRatesRaw.find((r) => r.name.toLowerCase() === item.specialRateName!.toLowerCase())
        : null;
      if (specialMatch) {
        const spCost = calcCost(specialMatch.sea, specialMatch.air);
        setSpecialEstimate(spCost > 0 ? { amount: spCost.toFixed(2), rateStr: item.shippingType === "air" ? `$${specialMatch.air}/kg` : `$${specialMatch.sea}/m³`, label: specialMatch.name } : null);
      } else {
        setSpecialEstimate(null);
      }
    } catch {
      setPkgEstimate(null);
      setSpecialEstimate(null);
    }
  }, [item, customerPackage]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await axios.delete(`/api/items/${id}`);
      success("Item deleted");
      router.push("/admin/items");
    } catch {
      error("Failed to delete item");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const openEdit = () => {
    if (!item) return;
    setEditForm({
      description: item.description ?? "",
      weight: String(item.weight),
      length: item.length != null ? String(item.length) : "",
      width: item.width != null ? String(item.width) : "",
      height: item.height != null ? String(item.height) : "",
      dimensionUnit: item.dimensionUnit ?? "cm",
      trackingNumber: item.trackingNumber ?? "",
      dateReceived: item.dateReceived?.split("T")[0] ?? "",
      notes: item.notes ?? "",
    });
    setEditModal(true);
  };

  const handleEdit = async () => {
    setSavingEdit(true);
    try {
      await axios.patch(`/api/items/${id}`, {
        description: editForm.description || undefined,
        weight: editForm.weight ? parseFloat(editForm.weight) : undefined,
        length: editForm.length ? parseFloat(editForm.length) : undefined,
        width: editForm.width ? parseFloat(editForm.width) : undefined,
        height: editForm.height ? parseFloat(editForm.height) : undefined,
        dimensionUnit: editForm.dimensionUnit,
        trackingNumber: editForm.trackingNumber || undefined,
        notes: editForm.notes || undefined,
      });
      success("Item updated");
      setEditModal(false);
      load();
    } catch {
      error("Failed to update item");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleAddPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

    setUploadingPhotos(true);
    try {
      const uploaded = await uploadPhotos(files);
      const newUrls = uploaded.map((u) => u.url);

      // Merge with existing photos via PATCH
      const existingUrls = item?.photos.map((p) => p.url) ?? [];
      const allUrls = [...existingUrls, ...newUrls].slice(0, 10);

      await axios.patch(`/api/items/${id}`, { photoUrls: allUrls });
      success("Photos added", `${uploaded.length} photo(s) uploaded`);
      load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      error("Upload failed", msg);
    } finally {
      setUploadingPhotos(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-400">Item not found</p>
      </div>
    );
  }

  const dimensions =
    item.length && item.width && item.height
      ? `${item.length} × ${item.width} × ${item.height} ${item.dimensionUnit}`
      : null;

  return (
    <div className="flex flex-col h-full">
      <Header
        title={item.itemRef}
        subtitle={item.description}
      />

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Top bar: back + actions */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <button
            onClick={() => router.push("/admin/items")}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {item.isMissing && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-red-50 border border-red-200 rounded-lg text-xs font-semibold text-red-700 shrink-0">
                <AlertTriangle className="h-3.5 w-3.5" />
                Missing
              </span>
            )}
            <StatusBadge status={item.status} />
            <Button size="sm" variant="outline" onClick={openEdit}>
              <Edit2 className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">Edit</span>
            </Button>
            <Button size="sm" onClick={() => setStatusModal(true)}>
              <span className="hidden sm:inline">Update </span>Status
            </Button>
            {confirmDelete ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-red-600 hidden sm:inline">Delete?</span>
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
                <Trash2 className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden sm:inline">Delete</span>
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left column: Item Details + Assignments */}
          <div className="space-y-5">

            {/* Item Details */}
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-2">
                <Package className="h-4 w-4 text-brand-600" />
                Item Details
              </h3>
              <div className="divide-y divide-gray-50">
                <InfoRow icon={Hash} label="Item Reference" value={item.itemRef} />
                <div className="flex items-start gap-3 py-3 border-b border-gray-50">
                  <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0 mt-0.5">
                    <User className="h-4 w-4 text-gray-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-400 font-medium">Customer</p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                      <p className="text-sm text-gray-900 font-medium">{item.customerName ?? "—"}</p>
                      {item.customerShippingMark && (
                        <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono">
                          {item.customerShippingMark}
                        </code>
                      )}
                    </div>
                  </div>
                </div>
                <InfoRow icon={Scale} label="Weight" value={item.weight ? `${item.weight} kg` : null} />
                {item.quantity && (
                  <InfoRow icon={Package} label="Quantity" value={`${item.quantity} pcs`} />
                )}
                <InfoRow icon={Package} label="Dimensions" value={dimensions} />
                <InfoRow icon={Hash} label="Tracking Number" value={item.trackingNumber} />
                <InfoRow icon={Calendar} label="Date Received" value={formatDateTime(item.dateReceived)} />
                {item.length && item.width && item.height ? (() => {
                  const factor = item.dimensionUnit === "inches" ? 16.387064 : 1;
                  const cbm = (item.length * item.width * item.height * factor * (item.quantity ?? 1)) / 1_000_000;
                  return <InfoRow icon={Package} label="CBM" value={`${cbm.toFixed(4)} m³`} />;
                })() : null}
                {item.estPrice != null && (
                  <InfoRow icon={DollarSign} label="Est. Item Price" value={`$ ${item.estPrice.toFixed(2)}`} />
                )}
                {item.estShippingPrice != null && (
                  <InfoRow icon={DollarSign} label="Est. Shipping Price" value={`$ ${item.estShippingPrice.toFixed(2)}`} />
                )}
                {/* Shipping estimate: prefer stored Airtable values, fall back to localStorage-computed */}
                {(item.pkgEstShipping != null || pkgEstimate) && (() => {
                  const rateUnit = item.shippingType === "air" ? "kg" : "m³";
                  const displayPkg = item.pkgEstShipping != null
                    ? {
                        amount: item.pkgEstShipping.toFixed(2),
                        rateStr: item.pkgShippingRate != null ? `$${item.pkgShippingRate}/${rateUnit}` : pkgEstimate?.rateStr ?? "",
                        label: customerPackage.charAt(0).toUpperCase() + customerPackage.slice(1),
                      }
                    : pkgEstimate;
                  const displaySpecial = (item.isSpecialItem && item.estShippingPrice != null && item.specialRateName)
                    ? {
                        amount: item.estShippingPrice.toFixed(2),
                        rateStr: item.specialShippingRate != null ? `$${item.specialShippingRate}/${rateUnit}` : specialEstimate?.rateStr ?? "",
                        label: item.specialRateName,
                      }
                    : specialEstimate;
                  const total = displaySpecial ? displaySpecial.amount : displayPkg?.amount ?? "";
                  return (
                    <div className="py-3">
                      <div className="bg-brand-50 border border-brand-100 rounded-xl p-3 space-y-1.5">
                        <p className="text-xs font-semibold text-brand-700 mb-1">Shipping Estimate</p>
                        {displayPkg && (
                          <div className="flex justify-between text-xs">
                            <span className="text-brand-600">{displayPkg.label} <span className="text-brand-400">({displayPkg.rateStr})</span></span>
                            <span className="font-semibold text-brand-900">$ {displayPkg.amount}</span>
                          </div>
                        )}
                        {displaySpecial && (
                          <div className="flex justify-between text-xs">
                            <span className="text-purple-600">{displaySpecial.label} <span className="text-purple-400">({displaySpecial.rateStr})</span></span>
                            <span className="font-semibold text-purple-900">$ {displaySpecial.amount}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-xs border-t border-brand-100 pt-1.5 mt-0.5">
                          <span className="font-semibold text-brand-800">Est. Shipping Price</span>
                          <span className="font-bold text-brand-900">$ {total}</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}
                {item.createdBy && (
                  <InfoRow icon={User} label="Created by" value={
                    item.createdBy.includes("@")
                      ? item.createdBy.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
                      : item.createdBy
                  } />
                )}
                {item.notes && (
                  <InfoRow icon={Package} label="Notes" value={item.notes} />
                )}
              </div>
            </div>

            {/* Assignments */}
            {(item.containerId || item.orderId) && (
              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <h3 className="font-semibold text-gray-900 mb-2">Assignments</h3>
                <div className="divide-y divide-gray-50">
                  {item.containerId && (
                    <InfoRow icon={Container} label="Container" value={
                      <button
                        onClick={() => router.push(`/admin/containers/${item.containerId}`)}
                        className="text-brand-600 hover:underline"
                      >
                        {containerDisplayName ?? item.containerName ?? "View Container"}
                      </button>
                    } />
                  )}
                  {item.orderId && (
                    <InfoRow icon={ShoppingCart} label="Order" value={
                      <button
                        onClick={() => router.push(`/admin/orders/${item.orderId}`)}
                        className="text-brand-600 hover:underline"
                      >
                        {item.orderRef ?? "View Order"}
                      </button>
                    } />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right column: Photos + Tracking */}
          <div className="space-y-5">
            {/* Photos */}
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <Camera className="h-4 w-4 text-brand-600" />
                  Photos
                </h3>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingPhotos}
                  className="text-xs text-brand-600 hover:underline flex items-center gap-1 disabled:opacity-50"
                >
                  {uploadingPhotos ? (
                    <><Loader2 className="h-3 w-3 animate-spin" /> Uploading...</>
                  ) : (
                    <>+ Add photos</>
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleAddPhotos}
                />
              </div>

              {item.photos.length > 0 ? (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {item.photos.map((photo, i) => (
                    <button
                      key={photo.id ?? i}
                      onClick={() => setSelectedPhoto(photo.url)}
                      className="aspect-square rounded-xl overflow-hidden border border-gray-200 hover:border-brand-300 transition-colors group"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.thumbnails?.large?.url ?? photo.url}
                        alt={photo.filename ?? `Photo ${i + 1}`}
                        className="w-full h-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-gray-200 rounded-xl p-8 text-center hover:border-brand-300 hover:bg-brand-50 transition-all"
                >
                  <Camera className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-sm text-gray-400">No photos yet. Click to add.</p>
                </button>
              )}
            </div>

            {/* Tracking Timeline */}
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">Tracking</h3>
              <TrackingTimeline
                currentStatus={item.status}
                history={history.length > 0 ? history : (
                  item.dateReceived ? [{
                    id: "synthetic-received",
                    recordType: "Item" as const,
                    recordId: item.id,
                    recordRef: item.itemRef ?? "",
                    previousStatus: "",
                    newStatus: "Arrived at Transit Warehouse",
                    changedBy: "",
                    changedByRole: "warehouse_staff" as const,
                    changedAt: item.dateReceived,
                  }] : []
                )}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Photo Lightbox */}
      {selectedPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setSelectedPhoto(null)}
        >
          <button
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
            onClick={() => setSelectedPhoto(null)}
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={selectedPhoto}
            alt="Item photo"
            className="max-w-full max-h-[85vh] object-contain rounded-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Status Update Modal */}
      <StatusUpdateModal
        open={statusModal}
        onClose={() => setStatusModal(false)}
        itemId={item.id}
        itemRef={item.itemRef}
        currentStatus={item.status}
        onSuccess={() => {
          setStatusModal(false);
          load();
        }}
      />

      {/* Edit Item Modal */}
      <Dialog open={editModal} onOpenChange={(o) => !o && setEditModal(false)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Item — {item?.itemRef}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Textarea
              label="Description (optional)"
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              rows={2}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Weight (kg)"
                type="number"
                step="0.01"
                min="0"
                value={editForm.weight}
                onChange={(e) => setEditForm({ ...editForm, weight: e.target.value })}
              />
              <Input
                label="Date Received"
                type="date"
                value={editForm.dateReceived}
                onChange={(e) => setEditForm({ ...editForm, dateReceived: e.target.value })}
              />
            </div>
            <Input
              label="Tracking Number (optional)"
              value={editForm.trackingNumber}
              onChange={(e) => setEditForm({ ...editForm, trackingNumber: e.target.value })}
            />
            <Select
              label="Dimension Unit"
              value={editForm.dimensionUnit}
              onChange={(e) => setEditForm({ ...editForm, dimensionUnit: e.target.value as "cm" | "inches" })}
              options={[
                { value: "cm", label: "Centimeters (cm)" },
                { value: "inches", label: "Inches" },
              ]}
            />
            <div className="grid grid-cols-3 gap-3">
              <Input
                label={`Length (${editForm.dimensionUnit})`}
                type="number"
                step="0.1"
                min="0"
                value={editForm.length}
                onChange={(e) => setEditForm({ ...editForm, length: e.target.value })}
              />
              <Input
                label={`Width (${editForm.dimensionUnit})`}
                type="number"
                step="0.1"
                min="0"
                value={editForm.width}
                onChange={(e) => setEditForm({ ...editForm, width: e.target.value })}
              />
              <Input
                label={`Height (${editForm.dimensionUnit})`}
                type="number"
                step="0.1"
                min="0"
                value={editForm.height}
                onChange={(e) => setEditForm({ ...editForm, height: e.target.value })}
              />
            </div>
            <Textarea
              label="Notes (optional)"
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModal(false)} disabled={savingEdit}>Cancel</Button>
            <Button onClick={handleEdit} loading={savingEdit}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
