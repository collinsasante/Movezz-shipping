"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { SearchBar } from "@/components/shared/SearchBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { computeCbm } from "@/lib/cbm";
import type { Customer, Item } from "@/types";
import { Boxes, Package, ChevronDown, ChevronRight, X, Trash2 } from "lucide-react";
import axios from "axios";

interface PkgRates {
  basic?: { sea?: number; air?: number };
  business?: { sea?: number; air?: number };
  enterprise?: { sea?: number; air?: number };
  special?: { sea?: number; air?: number };
}

interface Carton {
  cartonNumber: string;
  items: Item[];
  cbm: number;
}

export default function RepackingPage() {
  const { success, error } = useToast();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [pkgRates, setPkgRates] = useState<PkgRates>({});

  const [items, setItems] = useState<Item[]>([]);
  const [cartons, setCartons] = useState<Carton[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [trackingSearch, setTrackingSearch] = useState("");
  const [expandedCartons, setExpandedCartons] = useState<Set<string>>(new Set());

  const [repackDialogOpen, setRepackDialogOpen] = useState(false);
  const [repackMode, setRepackMode] = useState<"new" | "existing">("new");
  const [targetCarton, setTargetCarton] = useState("");
  const [repackForm, setRepackForm] = useState({
    length: "",
    width: "",
    height: "",
    weight: "",
    dimensionUnit: "cm" as "cm" | "inches",
  });
  const [submittingRepack, setSubmittingRepack] = useState(false);

  useEffect(() => {
    axios.get("/api/customers", { params: { limit: 1000 } }).then((res) => setCustomers(res.data.data)).catch(() => {});
    axios.get("/api/package-rates").then((res) => setPkgRates(res.data.data)).catch(() => {});
  }, []);

  const loadCustomerData = useCallback(async (customerId: string) => {
    if (!customerId) {
      setItems([]);
      setCartons([]);
      return;
    }
    setLoadingItems(true);
    try {
      const [itemsRes, cartonsRes] = await Promise.all([
        axios.get("/api/items", { params: { customerId, limit: 500 } }),
        axios.get("/api/cartons", { params: { customerId } }),
      ]);
      setItems(itemsRes.data.data);
      const fetchedCartons: Carton[] = cartonsRes.data.data;
      setCartons(fetchedCartons);
      setExpandedCartons(new Set(fetchedCartons.map((c) => c.cartonNumber)));
      setSelectedItemIds([]);
      setTrackingSearch("");
    } catch {
      error("Failed to load customer items");
    } finally {
      setLoadingItems(false);
    }
  }, [error]);

  const handleSelectCustomer = (customer: Customer) => {
    setSelectedCustomerId(customer.id);
    setCustomerSearch(customer.shippingMark);
    setCustomerDropdownOpen(false);
    loadCustomerData(customer.id);
  };

  const filteredCustomers = customers.filter((c) => {
    const q = customerSearch.toLowerCase();
    const selectedCustomer = customers.find((x) => x.id === selectedCustomerId);
    if (selectedCustomer && customerSearch === selectedCustomer.shippingMark) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      c.shippingMark.toLowerCase().includes(q) ||
      (c.phone ?? "").toLowerCase().includes(q)
    );
  });

  const selectedCustomer = customers.find((c) => c.id === selectedCustomerId);

  // Eligible for repacking: not already in a carton, not yet invoiced, not a special rate item
  // Selection state is derived from the full eligible pool (not the search-filtered
  // view below), so a selected item stays selected even if a later search hides it.
  const allEligibleItems = items.filter((i) => !i.cartonNumber && !i.orderId && !i.isSpecialItem);
  const eligibleItems = allEligibleItems.filter((i) =>
    trackingSearch ? (i.trackingNumber ?? "").toLowerCase().includes(trackingSearch.toLowerCase()) : true
  );
  const selectedItems = allEligibleItems.filter((i) => selectedItemIds.includes(i.id));

  const toggleItem = (id: string) => {
    setSelectedItemIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const toggleCartonExpand = (cartonNumber: string) => {
    setExpandedCartons((prev) => {
      const next = new Set(prev);
      next.has(cartonNumber) ? next.delete(cartonNumber) : next.add(cartonNumber);
      return next;
    });
  };

  const openRepackDialog = () => {
    if (selectedItems.length === 0) return;
    setRepackMode("new");
    setTargetCarton("");
    setRepackForm({ length: "", width: "", height: "", weight: "", dimensionUnit: "cm" });
    setRepackDialogOpen(true);
  };

  const shippingType = selectedItems[0]?.shippingType ?? "sea";
  const mixedShippingType = selectedItems.some((i) => (i.shippingType ?? "sea") !== shippingType);

  const previewCbm = computeCbm({
    length: parseFloat(repackForm.length) || 0,
    width: parseFloat(repackForm.width) || 0,
    height: parseFloat(repackForm.height) || 0,
    dimensionUnit: repackForm.dimensionUnit,
    quantity: 1,
  });
  const tier = (selectedCustomer?.package ?? "basic") as keyof PkgRates;
  const tierRates = pkgRates[tier] ?? pkgRates.basic ?? {};
  const previewTotal =
    repackMode === "new"
      ? shippingType === "air"
        ? (parseFloat(repackForm.weight) || 0) * (tierRates.air ?? 0)
        : previewCbm * (tierRates.sea ?? 0)
      : null;

  const handleSubmitRepack = async () => {
    setSubmittingRepack(true);
    try {
      if (repackMode === "new") {
        await axios.post("/api/cartons", {
          customerId: selectedCustomerId,
          itemIds: selectedItemIds,
          length: parseFloat(repackForm.length),
          width: parseFloat(repackForm.width),
          height: parseFloat(repackForm.height),
          weight: repackForm.weight ? parseFloat(repackForm.weight) : undefined,
          dimensionUnit: repackForm.dimensionUnit,
        });
        success("Carton created", `${selectedItems.length} item(s) repacked`);
      } else {
        await axios.patch(`/api/cartons/${targetCarton}`, { addItemIds: selectedItemIds });
        success("Items added to carton", targetCarton);
      }
      setRepackDialogOpen(false);
      loadCustomerData(selectedCustomerId);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error ?? "Repack failed" : "Repack failed";
      error("Error", msg);
    } finally {
      setSubmittingRepack(false);
    }
  };

  const handleRemoveFromCarton = async (cartonNumber: string, itemId: string) => {
    try {
      await axios.patch(`/api/cartons/${cartonNumber}`, { removeItemIds: [itemId] });
      success("Item removed from carton");
      loadCustomerData(selectedCustomerId);
    } catch {
      error("Failed to remove item from carton");
    }
  };

  const handleDissolveCarton = async (cartonNumber: string) => {
    try {
      await axios.delete(`/api/cartons/${cartonNumber}`);
      success("Carton dissolved");
      loadCustomerData(selectedCustomerId);
    } catch {
      error("Failed to dissolve carton");
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Repacking" subtitle="Group items into cartons before invoicing" />

      <div className="flex-1 p-6 space-y-5 overflow-y-auto">
        {/* Customer picker */}
        <div className="max-w-md">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Customer</label>
          <div className="relative">
            <input
              type="text"
              placeholder="Search by name or shipping mark..."
              value={customerSearch}
              onChange={(e) => {
                setCustomerSearch(e.target.value);
                setCustomerDropdownOpen(true);
                if (!e.target.value) { setSelectedCustomerId(""); setItems([]); setCartons([]); }
              }}
              onFocus={() => setCustomerDropdownOpen(true)}
              onBlur={() => setTimeout(() => setCustomerDropdownOpen(false), 150)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 transition-colors"
            />
            {customerDropdownOpen && filteredCustomers.length > 0 && (
              <div className="mt-1 absolute z-10 w-full border border-gray-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto bg-white shadow-sm">
                {filteredCustomers.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={() => handleSelectCustomer(c)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-brand-50 transition-colors border-b border-gray-50 last:border-0"
                  >
                    <span className="text-sm text-gray-700 truncate">{c.name}</span>
                    <code className="text-xs text-gray-500 font-mono ml-2 shrink-0">{c.shippingMark}</code>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {!selectedCustomerId ? (
          <div className="text-center py-16 border-2 border-dashed border-gray-100 rounded-xl">
            <Boxes className="h-10 w-10 text-gray-200 mx-auto mb-2" />
            <p className="text-sm text-gray-400">Select a customer to see items ready for repacking</p>
          </div>
        ) : loadingItems ? (
          <div className="space-y-3">
            {[1, 2].map((i) => <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />)}
          </div>
        ) : (
          <>
            {/* Ready to repack */}
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-1">
                <Package className="h-4 w-4 text-brand-600" />
                Ready to Repack
              </h3>
              <p className="text-xs text-gray-400 mb-4">Unmeasured, uninvoiced items for {selectedCustomer?.name}</p>

              {allEligibleItems.length > 0 && (
                <SearchBar
                  placeholder="Search by tracking number..."
                  onSearch={setTrackingSearch}
                  className="mb-4 max-w-xs"
                />
              )}

              {eligibleItems.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">
                  {trackingSearch ? "No items match that tracking number" : "No items ready for repacking"}
                </p>
              ) : (
                <div className="space-y-2">
                  {eligibleItems.map((item) => (
                    <label
                      key={item.id}
                      className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                        selectedItemIds.includes(item.id) ? "border-brand-200 bg-brand-50" : "border-gray-100 hover:border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedItemIds.includes(item.id)}
                        onChange={() => toggleItem(item.id)}
                        className="w-4 h-4 accent-brand-600 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{item.description || item.itemRef}</p>
                        <p className="text-xs text-gray-500">
                          {item.itemRef} · {item.shippingType ?? "sea"} freight{item.weight ? ` · ${item.weight} kg` : ""}
                          {item.trackingNumber ? ` · TRK: ${item.trackingNumber}` : ""}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {selectedItemIds.length > 0 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-50">
                  <span className="text-xs font-medium text-brand-600">{selectedItemIds.length} item(s) selected</span>
                  {mixedShippingType && (
                    <span className="text-xs text-red-500">Selected items must share the same freight type</span>
                  )}
                  <Button size="sm" onClick={openRepackDialog} disabled={mixedShippingType}>
                    Repack {selectedItemIds.length} item(s)
                  </Button>
                </div>
              )}
            </div>

            {/* Existing cartons */}
            {cartons.length > 0 && (
              <div className="space-y-3">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2 px-1">
                  <Boxes className="h-4 w-4 text-brand-600" />
                  Cartons
                </h3>
                {cartons.map((carton) => {
                  const isOpen = expandedCartons.has(carton.cartonNumber);
                  const totalPrice = carton.items.reduce((s, i) => s + (i.pkgEstShipping ?? 0), 0);
                  return (
                    <div key={carton.cartonNumber} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                      <button
                        onClick={() => toggleCartonExpand(carton.cartonNumber)}
                        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          {isOpen ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                          <Boxes className="h-4 w-4 text-brand-600" />
                          <span className="font-semibold text-gray-900 text-sm">{carton.cartonNumber}</span>
                          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                            {carton.items.length} item{carton.items.length !== 1 ? "s" : ""}
                          </span>
                          {carton.cbm > 0 && (
                            <span className="text-xs font-medium text-brand-600">{carton.cbm.toFixed(4)} m³</span>
                          )}
                          {totalPrice > 0 && (
                            <span className="text-xs font-semibold text-brand-700">$ {totalPrice.toFixed(2)}</span>
                          )}
                        </div>
                        <span
                          role="button"
                          onClick={(e) => { e.stopPropagation(); handleDissolveCarton(carton.cartonNumber); }}
                          className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Dissolve
                        </span>
                      </button>
                      {isOpen && (
                        <div className="border-t border-gray-100 divide-y divide-gray-50">
                          {carton.items.map((item) => (
                            <div key={item.id} className="flex items-center justify-between px-4 py-3 gap-2 hover:bg-gray-50">
                              <div className="min-w-0">
                                <span className="font-mono text-xs font-bold text-gray-700 mr-2">{item.itemRef}</span>
                                <span className="text-xs text-gray-500">{item.description}</span>
                              </div>
                              <button
                                onClick={() => handleRemoveFromCarton(carton.cartonNumber, item.id)}
                                title="Remove from carton"
                                className="text-gray-300 hover:text-red-500 shrink-0"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Repack Dialog */}
      <Dialog open={repackDialogOpen} onOpenChange={(o) => !o && setRepackDialogOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Repack {selectedItemIds.length} Item(s)</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {cartons.length > 0 && (
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setRepackMode("new")}
                  className={`flex-1 py-1.5 text-center font-medium transition-colors ${repackMode === "new" ? "bg-brand-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                >
                  New Carton
                </button>
                <button
                  type="button"
                  onClick={() => setRepackMode("existing")}
                  className={`flex-1 py-1.5 text-center font-medium transition-colors ${repackMode === "existing" ? "bg-brand-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                >
                  Add to Existing Carton
                </button>
              </div>
            )}

            {repackMode === "existing" ? (
              <Select
                label="Carton"
                value={targetCarton}
                onChange={(e) => setTargetCarton(e.target.value)}
                options={cartons.map((c) => ({ value: c.cartonNumber, label: `${c.cartonNumber} (${c.items.length} items)` }))}
              />
            ) : (
              <>
                <Select
                  label="Unit"
                  value={repackForm.dimensionUnit}
                  onChange={(e) => setRepackForm({ ...repackForm, dimensionUnit: e.target.value as "cm" | "inches" })}
                  options={[{ value: "cm", label: "cm" }, { value: "inches", label: "inches" }]}
                />
                <div className="grid grid-cols-3 gap-2">
                  <Input label="Length" type="number" min="0" step="0.01" value={repackForm.length} onChange={(e) => setRepackForm({ ...repackForm, length: e.target.value })} />
                  <Input label="Width" type="number" min="0" step="0.01" value={repackForm.width} onChange={(e) => setRepackForm({ ...repackForm, width: e.target.value })} />
                  <Input label="Height" type="number" min="0" step="0.01" value={repackForm.height} onChange={(e) => setRepackForm({ ...repackForm, height: e.target.value })} />
                </div>
                <Input label="Carton Weight (kg, optional)" type="number" min="0" step="0.01" value={repackForm.weight} onChange={(e) => setRepackForm({ ...repackForm, weight: e.target.value })} />
                {previewTotal != null && previewTotal > 0 && (
                  <div className="bg-brand-50 border border-brand-100 rounded-xl p-3 text-sm space-y-1">
                    {shippingType === "sea" && (
                      <div className="flex justify-between">
                        <span className="text-brand-700 font-medium">CBM</span>
                        <span className="font-bold text-brand-900">{previewCbm.toFixed(4)} m³</span>
                      </div>
                    )}
                    <div className="flex justify-between text-xs">
                      <span className="text-brand-600">Est. shipping cost (USD)</span>
                      <span className="font-bold text-brand-900">$ {previewTotal.toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepackDialogOpen(false)} disabled={submittingRepack}>Cancel</Button>
            <Button
              onClick={handleSubmitRepack}
              loading={submittingRepack}
              disabled={repackMode === "existing" ? !targetCarton : !repackForm.length || !repackForm.width || !repackForm.height}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
