"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusUpdateModal } from "@/components/shared/StatusUpdateModal";
import { TrackingTimeline } from "@/components/shared/TrackingTimeline";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { Item } from "@/types";
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

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`/api/items/${id}`);
      setItem(res.data.data);
    } catch {
      error("Failed to load item");
    } finally {
      setLoading(false);
    }
  }, [id, error]);

  useEffect(() => { load(); }, [load]);

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

      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <button
            onClick={() => router.push("/admin/items")}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Items
          </button>

          <div className="ml-auto flex items-center gap-2">
            {item.isMissing && (
              <span className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border border-red-200 rounded-lg text-xs font-semibold text-red-700">
                <AlertTriangle className="h-3.5 w-3.5" />
                Missing
              </span>
            )}
            <StatusBadge status={item.status} />
            <Button size="sm" variant="outline" onClick={openEdit}>
              <Edit2 className="h-3.5 w-3.5 mr-1.5" />
              Edit
            </Button>
            <Button size="sm" onClick={() => setStatusModal(true)}>
              Update Status
            </Button>
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600">Delete item?</span>
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
                Delete
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: Photos + Details */}
          <div className="lg:col-span-2 space-y-5">

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
                        src={photo.thumbnails?.small?.url ?? photo.url}
                        alt={photo.filename ?? `Photo ${i + 1}`}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
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

            {/* Item Details */}
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-2">
                <Package className="h-4 w-4 text-brand-600" />
                Item Details
              </h3>
              <div className="divide-y divide-gray-50">
                <InfoRow icon={Hash} label="Item Reference" value={item.itemRef} />
                <InfoRow icon={User} label="Customer" value={
                  <span className="flex items-center gap-2">
                    {item.customerName}
                    {item.customerShippingMark && (
                      <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono">
                        {item.customerShippingMark}
                      </code>
                    )}
                  </span>
                } />
                <InfoRow icon={Scale} label="Weight" value={`${item.weight} kg`} />
                <InfoRow icon={Package} label="Dimensions" value={dimensions} />
                <InfoRow icon={Hash} label="Tracking Number" value={item.trackingNumber} />
                <InfoRow icon={Calendar} label="Date Received" value={formatDateTime(item.dateReceived)} />
                {item.length && item.width && item.height ? (() => {
                  const factor = item.dimensionUnit === "inches" ? 16.387064 : 1;
                  const cbm = (item.length * item.width * item.height * factor) / 1_000_000;
                  return <InfoRow icon={Package} label="CBM" value={`${cbm.toFixed(4)} m³`} />;
                })() : null}
                <InfoRow icon={Calendar} label="Created" value={formatDate(item.createdAt)} />
                {item.createdBy && (
                  <InfoRow icon={User} label="Created by" value={item.createdBy} />
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
                        {item.containerName ?? item.containerId}
                      </button>
                    } />
                  )}
                  {item.orderId && (
                    <InfoRow icon={ShoppingCart} label="Order" value={
                      <button
                        onClick={() => router.push(`/admin/orders`)}
                        className="text-brand-600 hover:underline"
                      >
                        {item.orderRef ?? item.orderId}
                      </button>
                    } />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right column: Tracking */}
          <div className="space-y-5">
            {/* Tracking Timeline */}
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">Tracking</h3>
              <TrackingTimeline currentStatus={item.status} history={[]} />
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
