"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type { Customer } from "@/types";
import { ArrowLeft, Camera, X, Package, Loader2 } from "lucide-react";
import axios from "axios";
import { uploadPhotos } from "@/lib/uploadPhotos";

const CBM_LS_KEY = "pakk_exchange_rates";

function getCbm(l: number, w: number, h: number, unit: "cm" | "inches"): number {
  if (!l || !w || !h) return 0;
  if (unit === "cm") return (l * w * h) / 1_000_000;
  return l * w * h * 0.000016387; // cubic inches → cubic meters
}

function CbmDisplay({ length, width, height, unit }: { length: number; width: number; height: number; unit: "cm" | "inches" }) {
  const cbm = getCbm(length, width, height, unit);
  if (!cbm) return null;

  let rates = { shippingRatePerCbm: 0, usdToGhs: 0 };
  try {
    rates = JSON.parse(localStorage.getItem(CBM_LS_KEY) ?? "{}");
  } catch {}

  const costUsd = rates.shippingRatePerCbm ? cbm * rates.shippingRatePerCbm : null;
  const costGhs = costUsd && rates.usdToGhs ? costUsd * rates.usdToGhs : null;

  return (
    <div className="bg-brand-50 border border-brand-100 rounded-xl p-3 text-sm space-y-1">
      <div className="flex justify-between">
        <span className="text-brand-700 font-medium">CBM</span>
        <span className="font-bold text-brand-900">{cbm.toFixed(4)} m³</span>
      </div>
      {costUsd != null && (
        <div className="flex justify-between text-xs">
          <span className="text-brand-600">Shipping cost (USD)</span>
          <span className="font-semibold">${costUsd.toFixed(2)}</span>
        </div>
      )}
      {costGhs != null && (
        <div className="flex justify-between text-xs">
          <span className="text-brand-600">Est. cost (GHS)</span>
          <span className="font-bold text-brand-900">GH₵ {costGhs.toFixed(2)}</span>
        </div>
      )}
      {!rates.shippingRatePerCbm && (
        <p className="text-xs text-brand-500">Set exchange rates in Staff settings to see cost estimate.</p>
      )}
    </div>
  );
}

export default function NewItemPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { success, error } = useToast();
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    customerId: searchParams?.get("customerId") ?? "",
    description: "",
    weight: "",
    shippingType: "sea" as "air" | "sea",
    length: "",
    width: "",
    height: "",
    dimensionUnit: "cm" as "cm" | "inches",
    trackingNumber: "",
    dateReceived: new Date().toISOString().slice(0, 16),
    notes: "",
  });

  // Photo state
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);

  useEffect(() => {
    axios.get("/api/customers").then((res) => setCustomers(res.data.data));
  }, []);

  // Auto-set shippingType from selected customer
  useEffect(() => {
    if (!form.customerId) return;
    const customer = customers.find((c) => c.id === form.customerId);
    if (customer?.shippingType) {
      setForm((prev) => ({ ...prev, shippingType: customer.shippingType as "air" | "sea" }));
    }
  }, [form.customerId, customers]);

  const customerOptions = [
    { value: "", label: "Select a customer..." },
    ...customers.map((c) => ({
      value: c.id,
      label: `${c.name} (${c.shippingMark})`,
    })),
  ];

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    const newFiles = [...photoFiles, ...files].slice(0, 5); // max 5 photos
    setPhotoFiles(newFiles);

    // Generate previews
    const newPreviews = newFiles.map((f) => URL.createObjectURL(f));
    // Revoke old previews to avoid memory leaks
    photoPreviews.forEach((p) => URL.revokeObjectURL(p));
    setPhotoPreviews(newPreviews);

    // Reset input so same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePhoto = (index: number) => {
    URL.revokeObjectURL(photoPreviews[index]);
    setPhotoFiles((prev) => prev.filter((_, i) => i !== index));
    setPhotoPreviews((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.customerId) {
      error("Validation", "Please select a customer");
      return;
    }
    setLoading(true);

    try {
      // Upload photos first (if any)
      let photoUrls: string[] = [];
      if (photoFiles.length > 0) {
        setUploadingPhotos(true);
        try {
          const uploaded = await uploadPhotos(photoFiles);
          photoUrls = uploaded.map((u) => u.url);
        } catch (uploadErr) {
          const msg = uploadErr instanceof Error ? uploadErr.message : "Photo upload failed";
          error("Photo Upload Failed", msg + " — item will be saved without photos.");
        } finally {
          setUploadingPhotos(false);
        }
      }

      const payload = {
        ...form,
        weight: form.weight ? parseFloat(form.weight) : undefined,
        length: form.length ? parseFloat(form.length) : undefined,
        width: form.width ? parseFloat(form.width) : undefined,
        height: form.height ? parseFloat(form.height) : undefined,
        photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
      };

      const res = await axios.post("/api/items", payload);
      success("Item received!", res.data.message);
      router.push(`/admin/items/${res.data.data.id}`);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to create item"
        : "Failed to create item";
      error("Error", msg);
    } finally {
      setLoading(false);
    }
  };

  const isSubmitting = loading || uploadingPhotos;

  return (
    <div className="flex flex-col h-full">
      <Header title="Log Item" subtitle="Record a new package at the warehouse" />

      <div className="flex-1 p-4 sm:p-6 max-w-2xl mx-auto w-full overflow-y-auto">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <form onSubmit={handleSubmit} className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5 text-brand-600" />
                Item Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select
                label="Assign to Customer"
                options={customerOptions}
                value={form.customerId}
                onChange={(e) => setForm({ ...form, customerId: e.target.value })}
                required
              />
              <Textarea
                label="Description (optional)"
                placeholder="Describe the item (e.g. iPhone 15 Pro Max, 2x Sneakers size 10)"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select
                  label="Freight Type"
                  options={[
                    { value: "sea", label: "Sea Freight (CBM)" },
                    { value: "air", label: "Air Freight (Weight)" },
                  ]}
                  value={form.shippingType}
                  onChange={(e) => setForm({ ...form, shippingType: e.target.value as "air" | "sea" })}
                />
                <Input
                  label={`Weight (kg)${form.shippingType === "sea" ? " (optional)" : ""}`}
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={form.weight}
                  onChange={(e) => setForm({ ...form, weight: e.target.value })}
                  required={form.shippingType === "air"}
                />
              </div>
              <Input
                label="Date & Time Received"
                type="datetime-local"
                value={form.dateReceived}
                onChange={(e) => setForm({ ...form, dateReceived: e.target.value })}
                required
              />
              <Input
                label="Tracking Number (optional)"
                placeholder="UPS/FedEx/USPS tracking number"
                value={form.trackingNumber}
                onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })}
              />
            </CardContent>
          </Card>

          {/* Photo Upload */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5 text-brand-600" />
                Item Photos
                <span className="text-xs font-normal text-gray-400 ml-1">(up to 5)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Previews */}
              {photoPreviews.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  {photoPreviews.map((src, i) => (
                    <div key={i} className="relative group aspect-square">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt={`Photo ${i + 1}`}
                        className="w-full h-full object-cover rounded-xl border border-gray-200"
                      />
                      <button
                        type="button"
                        onClick={() => removePhoto(i)}
                        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add photos button */}
              {photoFiles.length < 5 && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-gray-200 rounded-xl p-5 text-center hover:border-brand-300 hover:bg-brand-50 transition-all"
                >
                  <Camera className="h-7 w-7 text-gray-300 mx-auto mb-1.5" />
                  <p className="text-sm font-medium text-gray-500">
                    {photoFiles.length === 0 ? "Add item photos" : "Add more photos"}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    JPG, PNG, WEBP · {5 - photoFiles.length} remaining
                  </p>
                </button>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handlePhotoSelect}
              />

              {uploadingPhotos && (
                <div className="flex items-center gap-2 mt-3 text-sm text-brand-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Uploading photos...
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dimensions (optional)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select
                label="Unit"
                options={[
                  { value: "cm", label: "Centimeters (cm)" },
                  { value: "inches", label: "Inches" },
                ]}
                value={form.dimensionUnit}
                onChange={(e) =>
                  setForm({ ...form, dimensionUnit: e.target.value as "cm" | "inches" })
                }
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input
                  label={`Length (${form.dimensionUnit})`}
                  type="number"
                  step="0.1"
                  min="0"
                  value={form.length}
                  onChange={(e) => setForm({ ...form, length: e.target.value })}
                />
                <Input
                  label={`Width (${form.dimensionUnit})`}
                  type="number"
                  step="0.1"
                  min="0"
                  value={form.width}
                  onChange={(e) => setForm({ ...form, width: e.target.value })}
                />
                <Input
                  label={`Height (${form.dimensionUnit})`}
                  type="number"
                  step="0.1"
                  min="0"
                  value={form.height}
                  onChange={(e) => setForm({ ...form, height: e.target.value })}
                />
              </div>
              <CbmDisplay
                length={parseFloat(form.length) || 0}
                width={parseFloat(form.width) || 0}
                height={parseFloat(form.height) || 0}
                unit={form.dimensionUnit}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <Textarea
                label="Internal Notes (optional)"
                placeholder="Condition notes, special handling instructions..."
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting} className="flex-1">
              {uploadingPhotos ? "Uploading photos..." : "Submit"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
