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
import { ArrowLeft, Camera, X, Package, Loader2, ChevronLeft, ChevronRight, Columns2, Tag, Search } from "lucide-react";
import axios from "axios";
import { uploadPhotos } from "@/lib/uploadPhotos";

const CBM_LS_KEY = "pakk_exchange_rates";
const SPECIAL_RATES_KEY = "pakk_special_rates";
interface SpecialRate { id: string; name: string; sea: number; air: number; }

function getCbm(l: number, w: number, h: number, unit: "cm" | "inches"): number {
  if (!l || !w || !h) return 0;
  if (unit === "cm") return (l * w * h) / 1_000_000;
  return l * w * h * 0.000016387;
}

function CbmDisplay({ length, width, height, unit, quantity, weight, shippingType, specialRate }: { length: number; width: number; height: number; unit: "cm" | "inches"; quantity: number; weight: number; shippingType: "air" | "sea"; specialRate?: SpecialRate }) {
  let pkgRates: { basic?: { sea?: number; air?: number }; shippingRatePerCbm?: number } = {};
  try {
    pkgRates = JSON.parse(localStorage.getItem("pakk_package_rates") ?? "{}");
  } catch {}

  const stdRates = pkgRates.basic ?? { sea: 0, air: 0 };
  const rateLabel = specialRate ? specialRate.name : "Basic";

  // Air: weight-based
  if (shippingType === "air") {
    if (!weight) return null;
    const airRate = specialRate ? specialRate.air : (stdRates.air || 0);
    if (!airRate) return (
      <p className="text-xs text-brand-500">Set air rate in Settings → Package Rates to see estimate.</p>
    );
    const qty = Math.max(1, quantity || 1);
    const costGhs = weight * qty * airRate;
    return (
      <div className="bg-brand-50 border border-brand-100 rounded-xl p-3 text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-brand-700 font-medium">Weight</span>
          <span className="font-bold text-brand-900">{(weight * qty).toFixed(2)} kg</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-brand-600">Rate ({rateLabel})</span>
          <span className="font-semibold">${airRate}/kg</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-brand-600">Est. cost (USD)</span>
          <span className="font-bold text-brand-900">${costGhs.toFixed(2)}</span>
        </div>
      </div>
    );
  }

  // Sea: CBM-based
  const cbm = getCbm(length, width, height, unit) * Math.max(1, quantity || 1);
  if (!cbm) return null;

  const seaRate = specialRate ? specialRate.sea : (stdRates.sea || pkgRates.shippingRatePerCbm || 0);
  const costGhs = seaRate ? cbm * seaRate : null;

  return (
    <div className="bg-brand-50 border border-brand-100 rounded-xl p-3 text-sm space-y-1">
      <div className="flex justify-between">
        <span className="text-brand-700 font-medium">CBM</span>
        <span className="font-bold text-brand-900">{cbm.toFixed(4)} m³</span>
      </div>
      {costGhs != null && (
        <div className="flex justify-between text-xs">
          <span className="text-brand-600">Rate ({rateLabel})</span>
          <span className="font-semibold">${seaRate}/m³</span>
        </div>
      )}
      {costGhs != null && (
        <div className="flex justify-between text-xs">
          <span className="text-brand-600">Est. cost (USD)</span>
          <span className="font-bold text-brand-900">${costGhs.toFixed(2)}</span>
        </div>
      )}
      {!seaRate && (
        <p className="text-xs text-brand-500">Set rates in Settings → Package Rates to see cost estimate.</p>
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
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [splitView, setSplitView] = useState(false);
  const [splitPhotoIdx, setSplitPhotoIdx] = useState(0);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

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
    quantity: "",
    dateReceived: new Date().toISOString().slice(0, 16),
    estPrice: "",
    estShippingPrice: "",
    notes: "",
  });
  const [isSpecialItem, setIsSpecialItem] = useState(false);
  const [specialRates, setSpecialRates] = useState<SpecialRate[]>([]);
  const [selectedSpecialRateId, setSelectedSpecialRateId] = useState("");
  const [specialSearch, setSpecialSearch] = useState("");

  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);

  useEffect(() => {
    axios.get("/api/customers").then((res) => {
      const data: Customer[] = res.data.data;
      setCustomers(data);
      // If pre-filled from URL, set the search text
      const prefilledId = searchParams?.get("customerId");
      if (prefilledId) {
        const match = data.find((c) => c.id === prefilledId);
        if (match) setCustomerSearch(match.shippingMark);
      }
    });
    try {
      const saved = localStorage.getItem(SPECIAL_RATES_KEY);
      if (saved) setSpecialRates(JSON.parse(saved));
    } catch {}
  }, []);

  useEffect(() => {
    if (!form.customerId) return;
    const customer = customers.find((c) => c.id === form.customerId);
    if (customer?.shippingType) {
      setForm((prev) => ({ ...prev, shippingType: customer.shippingType as "air" | "sea" }));
    }
  }, [form.customerId, customers]);

  // Auto-fill estShippingPrice from customer package tier rates (all items)
  useEffect(() => {
    // Special rate takes priority — handled by the effect below
    if (selectedSpecialRateId) return;
    try {
      const pkgRates = JSON.parse(localStorage.getItem("pakk_package_rates") ?? "{}");
      const customer = customers.find((c) => c.id === form.customerId);
      const tier = (customer?.package ?? "basic") as "basic" | "business" | "enterprise" | "special";
      const tierRates = pkgRates[tier] ?? { sea: 350, air: 8 };
      const qty = Math.max(1, parseInt(form.quantity) || 1);
      let costGhs = 0;
      if (form.shippingType === "air") {
        const w = parseFloat(form.weight) || 0;
        if (w) costGhs = w * qty * tierRates.air;
      } else {
        const cbm = getCbm(parseFloat(form.length) || 0, parseFloat(form.width) || 0, parseFloat(form.height) || 0, form.dimensionUnit) * qty;
        if (cbm) costGhs = cbm * tierRates.sea;
      }
      setForm((prev) => ({ ...prev, estShippingPrice: costGhs > 0 ? costGhs.toFixed(2) : "" }));
    } catch {}
  }, [form.customerId, customers, form.shippingType, form.length, form.width, form.height, form.dimensionUnit, form.weight, form.quantity, selectedSpecialRateId]);

  // Auto-fill estShippingPrice when special rate + dimensions/weight are set
  useEffect(() => {
    const rate = specialRates.find((r) => r.id === selectedSpecialRateId);
    if (!rate) return;
    try {
      const qty = Math.max(1, parseInt(form.quantity) || 1);
      let costGhs = 0;
      if (form.shippingType === "air") {
        const w = parseFloat(form.weight) || 0;
        if (w) costGhs = w * qty * rate.air;
      } else {
        const cbm = getCbm(parseFloat(form.length) || 0, parseFloat(form.width) || 0, parseFloat(form.height) || 0, form.dimensionUnit) * qty;
        if (cbm) costGhs = cbm * rate.sea;
      }
      if (costGhs > 0) {
        setForm((prev) => ({ ...prev, estShippingPrice: costGhs.toFixed(2) }));
      }
    } catch {}
  }, [selectedSpecialRateId, specialRates, form.shippingType, form.length, form.width, form.height, form.dimensionUnit, form.weight, form.quantity]);

  const filteredCustomers = customers.filter((c) => {
    const q = customerSearch.toLowerCase();
    if (form.customerId && c.shippingMark === customerSearch) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      (c.shippingMark ?? "").toLowerCase().includes(q) ||
      (c.phone ?? "").includes(q)
    );
  });

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const newFiles = [...photoFiles, ...files].slice(0, 5);
    setPhotoFiles(newFiles);
    const newPreviews = newFiles.map((f) => URL.createObjectURL(f));
    photoPreviews.forEach((p) => URL.revokeObjectURL(p));
    setPhotoPreviews(newPreviews);
    if (fileInputRef.current) fileInputRef.current.value = "";
    // Auto-activate split view on desktop when first photo added
    if (photoFiles.length === 0 && newFiles.length > 0) setSplitView(true);
    setSplitPhotoIdx(newFiles.length - 1);
  };

  const removePhoto = (index: number) => {
    URL.revokeObjectURL(photoPreviews[index]);
    const newPreviews = photoPreviews.filter((_, i) => i !== index);
    setPhotoFiles((prev) => prev.filter((_, i) => i !== index));
    setPhotoPreviews(newPreviews);
    if (lightboxIdx !== null) {
      if (index === lightboxIdx) setLightboxIdx(null);
      else if (index < lightboxIdx) setLightboxIdx(lightboxIdx - 1);
    }
    setSplitPhotoIdx((prev) => Math.min(prev, Math.max(0, newPreviews.length - 1)));
    if (newPreviews.length === 0) setSplitView(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.customerId) {
      error("Validation", "Please select a customer");
      return;
    }
    setLoading(true);
    try {
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

      const selectedRate = specialRates.find((r) => r.id === selectedSpecialRateId);

      const payload = {
        ...form,
        notes: form.notes || undefined,
        weight: form.weight ? parseFloat(form.weight) : undefined,
        estPrice: form.estPrice ? parseFloat(form.estPrice) : undefined,
        estShippingPrice: form.estShippingPrice ? parseFloat(form.estShippingPrice) : undefined,
        isSpecialItem: (isSpecialItem || !!selectedRate) || undefined,
        specialRateName: selectedRate?.name || undefined,
        length: form.length ? parseFloat(form.length) : undefined,
        width: form.width ? parseFloat(form.width) : undefined,
        height: form.height ? parseFloat(form.height) : undefined,
        quantity: form.quantity ? parseInt(form.quantity) : undefined,
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
      <Header title="Add Item" subtitle="Record a new package at the warehouse" />

      <div className={`flex-1 overflow-hidden ${splitView && photoPreviews.length > 0 ? "flex flex-row" : "overflow-y-auto"}`}>
        {/* Form column */}
        <div className={splitView && photoPreviews.length > 0 ? "flex-1 overflow-y-auto p-4 sm:p-6" : "p-4 sm:p-6 max-w-2xl mx-auto w-full"}>
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={() => router.back()}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            {photoPreviews.length > 0 && (
              <button
                type="button"
                onClick={() => setSplitView(!splitView)}
                className="hidden lg:flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
              >
                <Columns2 className="h-4 w-4" />
                {splitView ? "Form only" : "Split view"}
              </button>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Package className="h-5 w-5 text-brand-600" />
                  Item Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Assign to Customer <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search by name or shipping mark..."
                      value={customerSearch}
                      onChange={(e) => {
                        setCustomerSearch(e.target.value);
                        setCustomerDropdownOpen(true);
                        if (!e.target.value) setForm({ ...form, customerId: "" });
                      }}
                      onFocus={() => setCustomerDropdownOpen(true)}
                      onBlur={() => setTimeout(() => setCustomerDropdownOpen(false), 150)}
                      className="h-10 w-full pl-9 pr-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                    />
                  </div>
                  {customerDropdownOpen && filteredCustomers.length > 0 && (
                    <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto bg-white shadow-sm">
                      {filteredCustomers.slice(0, 20).map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onMouseDown={() => {
                            setForm({ ...form, customerId: c.id });
                            setCustomerSearch(c.shippingMark);
                            setCustomerDropdownOpen(false);
                          }}
                          className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-brand-50 transition-colors text-sm"
                        >
                          <code className="text-sm font-mono text-gray-500 truncate">{c.name}</code>
                          <code className="text-xs text-gray-500 font-mono ml-2 shrink-0">{c.shippingMark}</code>
                        </button>
                      ))}
                    </div>
                  )}
                  {customerDropdownOpen && customerSearch && filteredCustomers.length === 0 && (
                    <p className="mt-1 text-xs text-gray-400 px-2">No customers match &quot;{customerSearch}&quot;</p>
                  )}
                </div>
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
                  placeholder="Enter tracking number"
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
                {photoPreviews.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                    {photoPreviews.map((src, i) => (
                      <div key={i} className="relative group aspect-square">
                        <button
                          type="button"
                          onClick={() => setLightboxIdx(i)}
                          className="w-full h-full rounded-xl overflow-hidden border border-gray-200 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={src}
                            alt={`Photo ${i + 1}`}
                            className="w-full h-full object-cover hover:scale-105 transition-transform duration-200"
                          />
                        </button>
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
                <Input
                  label="Quantity"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="1"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
                <CbmDisplay
                  length={parseFloat(form.length) || 0}
                  width={parseFloat(form.width) || 0}
                  height={parseFloat(form.height) || 0}
                  unit={form.dimensionUnit}
                  quantity={parseInt(form.quantity) || 1}
                  weight={parseFloat(form.weight) || 0}
                  shippingType={form.shippingType}
                  specialRate={specialRates.find((r) => r.id === selectedSpecialRateId)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Tag className="h-5 w-5 text-brand-600" />
                  Special Rate (optional)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {specialRates.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-3">
                    No special rates configured. Add them in{" "}
                    <button type="button" className="text-brand-600 hover:underline" onClick={() => window.location.href = "/admin/settings"}>
                      Settings → Special Rates
                    </button>
                  </p>
                ) : (
                  <>
                    <input
                      type="text"
                      placeholder="Search rates..."
                      value={specialSearch}
                      onChange={(e) => setSpecialSearch(e.target.value)}
                      className="h-9 w-full px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {specialRates
                        .filter((r) => r.name.toLowerCase().includes(specialSearch.toLowerCase()))
                        .map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => {
                              setSelectedSpecialRateId(selectedSpecialRateId === r.id ? "" : r.id);
                              setIsSpecialItem(selectedSpecialRateId !== r.id);
                            }}
                            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-left transition-all ${
                              selectedSpecialRateId === r.id
                                ? "border-brand-300 bg-brand-50"
                                : "border-gray-100 hover:border-gray-200 hover:bg-gray-50"
                            }`}
                          >
                            <span className="text-sm font-medium text-gray-900">{r.name}</span>
                            <span className="text-xs text-gray-500">Sea: ${r.sea}/CBM · Air: ${r.air}/kg</span>
                          </button>
                        ))}
                      {specialRates.filter((r) => r.name.toLowerCase().includes(specialSearch.toLowerCase())).length === 0 && (
                        <p className="text-sm text-gray-400 text-center py-3">No rates match your search</p>
                      )}
                    </div>
                    {selectedSpecialRateId && (
                      <button
                        type="button"
                        onClick={() => { setSelectedSpecialRateId(""); setIsSpecialItem(false); }}
                        className="text-xs text-red-500 hover:underline"
                      >
                        Clear selection
                      </button>
                    )}
                  </>
                )}
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

        {/* Split view photo panel (desktop only) */}
        {splitView && photoPreviews.length > 0 && (
          <div className="hidden lg:flex lg:w-[480px] xl:w-[560px] shrink-0 border-l border-gray-200 flex-col bg-gray-950 overflow-hidden">
            {/* Large photo */}
            <div className="relative flex-1 min-h-0 flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoPreviews[splitPhotoIdx]}
                alt={`Photo ${splitPhotoIdx + 1}`}
                className="w-full h-full object-contain"
                style={{ maxHeight: "calc(100vh - 140px)" }}
              />
              {/* Remove button */}
              <button
                type="button"
                onClick={() => removePhoto(splitPhotoIdx)}
                className="absolute top-3 right-3 w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors shadow"
              >
                <X className="h-4 w-4" />
              </button>
              {/* Prev / Next */}
              {photoPreviews.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => setSplitPhotoIdx((splitPhotoIdx - 1 + photoPreviews.length) % photoPreviews.length)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center transition-colors"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSplitPhotoIdx((splitPhotoIdx + 1) % photoPreviews.length)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center transition-colors"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </>
              )}
            </div>
            {/* Thumbnail strip */}
            <div className="flex gap-2 p-3 bg-gray-900 overflow-x-auto shrink-0">
              {photoPreviews.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSplitPhotoIdx(i)}
                  className={`shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors ${i === splitPhotoIdx ? "border-brand-400" : "border-transparent opacity-60 hover:opacity-100"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`Thumb ${i + 1}`} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
            {/* Counter + form-only toggle */}
            <div className="flex items-center justify-between px-3 py-2 bg-gray-900 border-t border-gray-800">
              <span className="text-xs text-gray-400">{splitPhotoIdx + 1} / {photoPreviews.length}</span>
              <button
                type="button"
                onClick={() => setSplitView(false)}
                className="text-xs text-gray-400 hover:text-white transition-colors"
              >
                Form only
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxIdx !== null && (
        <div
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxIdx(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoPreviews[lightboxIdx]}
            alt={`Photo ${lightboxIdx + 1}`}
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-xl"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/60 text-sm">
            {lightboxIdx + 1} / {photoPreviews.length}
          </div>
          <button
            onClick={() => setLightboxIdx(null)}
            className="absolute top-4 right-4 text-white p-2 hover:bg-white/10 rounded-full"
          >
            <X className="h-6 w-6" />
          </button>
          {photoPreviews.length > 1 && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); setLightboxIdx((lightboxIdx - 1 + photoPreviews.length) % photoPreviews.length); }}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-white p-2 hover:bg-white/10 rounded-full"
              >
                <ChevronLeft className="h-7 w-7" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setLightboxIdx((lightboxIdx + 1) % photoPreviews.length); }}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white p-2 hover:bg-white/10 rounded-full"
              >
                <ChevronRight className="h-7 w-7" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
