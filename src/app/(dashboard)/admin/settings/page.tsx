"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type { CustomerPackage } from "@/types";
import { DollarSign, Save, Package, Warehouse, Plus, Trash2, ToggleLeft, ToggleRight, Tag } from "lucide-react";
import axios from "axios";
import type { Warehouse as WarehouseType } from "@/types";

const RATES_KEY = "pakk_exchange_rates";
const PACKAGES_RATES_KEY = "pakk_package_rates";
const SPECIAL_RATES_KEY = "pakk_special_rates";

interface SpecialRate { id: string; name: string; sea: number; air: number; }

interface PackageRate { sea: number; air: number; }
interface PackageRates { standard: PackageRate; discounted: PackageRate; premium: PackageRate; special: PackageRate; }
const DEFAULT_PKG_RATES: PackageRates = {
  standard: { sea: 350, air: 8 },
  discounted: { sea: 280, air: 6 },
  premium: { sea: 450, air: 12 },
  special: { sea: 500, air: 15 },
};

const PACKAGE_OPTIONS: { value: CustomerPackage | ""; label: string }[] = [
  { value: "", label: "No package" },
  { value: "standard", label: "Basic Shipping" },
  { value: "discounted", label: "Business Shipping" },
  { value: "premium", label: "Enterprise Shipping" },
  { value: "special", label: "Special" },
];

const PACKAGE_LABELS: Record<CustomerPackage, string> = {
  standard: "Basic Shipping",
  discounted: "Business Shipping",
  premium: "Enterprise Shipping",
  special: "Special",
};

const PACKAGE_COLORS: Record<CustomerPackage, string> = {
  standard: "bg-gray-100 text-gray-700",
  discounted: "bg-blue-50 text-blue-700",
  premium: "bg-amber-50 text-amber-700",
  special: "bg-purple-50 text-purple-700",
};

export default function AdminSettingsPage() {
  const { success, error } = useToast();
  const [activeTab, setActiveTab] = useState<"exchange" | "warehouses" | "special-rates">("exchange");

  // Exchange rate settings
  const [defaultRate, setDefaultRate] = useState("12.5");
  const [shippingRatePerCbm, setShippingRatePerCbm] = useState("200");
  const [pkgRates, setPkgRates] = useState<PackageRates>(DEFAULT_PKG_RATES);

  // Special rates
  const [specialRates, setSpecialRates] = useState<SpecialRate[]>([]);
  const [specialRateForm, setSpecialRateForm] = useState({ name: "", sea: "", air: "" });
  const [confirmDeleteSpecialId, setConfirmDeleteSpecialId] = useState<string | null>(null);

  // Warehouses
  const [warehouses, setWarehouses] = useState<WarehouseType[]>([]);
  const [loadingWarehouses, setLoadingWarehouses] = useState(false);
  const [warehouseForm, setWarehouseForm] = useState({ name: "", address: "", country: "", phone: "" });
  const [savingWarehouse, setSavingWarehouse] = useState(false);
  const [confirmDeleteWarehouseId, setConfirmDeleteWarehouseId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(RATES_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.usdToGhs) setDefaultRate(String(parsed.usdToGhs));
        if (parsed.shippingRatePerCbm) setShippingRatePerCbm(String(parsed.shippingRatePerCbm));
      }
    } catch {}
    const savedPkgRates = localStorage.getItem(PACKAGES_RATES_KEY);
    if (savedPkgRates) {
      try { setPkgRates({ ...DEFAULT_PKG_RATES, ...JSON.parse(savedPkgRates) }); } catch {}
    }
    try {
      const savedSpecial = localStorage.getItem(SPECIAL_RATES_KEY);
      if (savedSpecial) setSpecialRates(JSON.parse(savedSpecial));
    } catch {}
  }, []);

  const saveDefaultRate = () => {
    const usdToGhs = parseFloat(defaultRate);
    const ratePerCbm = parseFloat(shippingRatePerCbm);
    if (isNaN(usdToGhs) || usdToGhs <= 0) {
      error("Invalid rate", "Please enter a valid USD → GHS rate");
      return;
    }
    if (isNaN(ratePerCbm) || ratePerCbm <= 0) {
      error("Invalid rate", "Please enter a valid shipping rate");
      return;
    }
    localStorage.setItem(RATES_KEY, JSON.stringify({ usdToGhs, shippingRatePerCbm: ratePerCbm }));
    success("Rates saved", `1 USD = ${usdToGhs} GHS · $${ratePerCbm}/CBM`);
  };

  const savePackageRates = () => {
    localStorage.setItem(PACKAGES_RATES_KEY, JSON.stringify(pkgRates));
    success("Package rates saved");
  };

  useEffect(() => {
    if (activeTab === "warehouses") loadWarehouses();
  }, [activeTab]);

  const loadWarehouses = async () => {
    setLoadingWarehouses(true);
    try {
      const res = await axios.get("/api/warehouses");
      setWarehouses(res.data.data);
    } catch {
      error("Failed to load warehouses");
    } finally {
      setLoadingWarehouses(false);
    }
  };

  const addWarehouse = async () => {
    if (!warehouseForm.name.trim() || !warehouseForm.address.trim()) {
      error("Name and address are required");
      return;
    }
    setSavingWarehouse(true);
    try {
      const res = await axios.post("/api/warehouses", warehouseForm);
      setWarehouses((prev) => [...prev, res.data.data]);
      setWarehouseForm({ name: "", address: "", country: "", phone: "" });
      success("Warehouse added");
    } catch {
      error("Failed to add warehouse");
    } finally {
      setSavingWarehouse(false);
    }
  };

  const deleteWarehouse = async (id: string) => {
    try {
      await axios.delete(`/api/warehouses/${id}`);
      setWarehouses((prev) => prev.filter((w) => w.id !== id));
      success("Warehouse removed");
    } catch {
      error("Failed to remove warehouse");
    }
  };

  const toggleWarehouse = async (id: string, isActive: boolean) => {
    try {
      const res = await axios.patch(`/api/warehouses/${id}`, { isActive });
      setWarehouses((prev) => prev.map((w) => w.id === id ? res.data.data : w));
    } catch {
      error("Failed to update warehouse");
    }
  };

  const addSpecialRate = () => {
    if (!specialRateForm.name.trim()) { error("Rate name is required"); return; }
    const sea = parseFloat(specialRateForm.sea);
    const air = parseFloat(specialRateForm.air);
    if ((isNaN(sea) && isNaN(air)) || (sea < 0) || (air < 0)) { error("Enter at least one valid rate"); return; }
    const newRate: SpecialRate = { id: Date.now().toString(), name: specialRateForm.name.trim(), sea: isNaN(sea) ? 0 : sea, air: isNaN(air) ? 0 : air };
    const updated = [...specialRates, newRate];
    setSpecialRates(updated);
    localStorage.setItem(SPECIAL_RATES_KEY, JSON.stringify(updated));
    setSpecialRateForm({ name: "", sea: "", air: "" });
    success("Special rate added");
  };

  const deleteSpecialRate = (id: string) => {
    const updated = specialRates.filter((r) => r.id !== id);
    setSpecialRates(updated);
    localStorage.setItem(SPECIAL_RATES_KEY, JSON.stringify(updated));
    setConfirmDeleteSpecialId(null);
    success("Special rate removed");
  };

  const tabs = [
    { id: "exchange" as const, label: "Exchange Rates", icon: DollarSign },
    { id: "warehouses" as const, label: "Warehouses", icon: Warehouse },
    { id: "special-rates" as const, label: "Special Rates", icon: Tag },
  ];

  return (
    <div className="flex flex-col h-full">
      <Header title="Settings" subtitle="Manage system configuration" />

      <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-full sm:w-fit mb-6 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap flex-1 sm:flex-none justify-center sm:justify-start ${
                  activeTab === tab.id
                    ? "bg-white shadow-sm text-gray-900"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.id === "exchange" ? "Rates" : tab.id === "warehouses" ? "Warehouses" : "Special"}</span>
              </button>
            );
          })}
        </div>

        {/* Exchange Rate Settings */}
        {activeTab === "exchange" && (
          <div className="max-w-2xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-brand-600" />
                  Currency & Default Rates
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-gray-500">
                  Set the default USD → GHS exchange rate and base shipping rate.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="USD → GHS Rate"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 15.50"
                    value={defaultRate}
                    onChange={(e) => setDefaultRate(e.target.value)}
                    hint="How many GHS per 1 USD"
                  />
                  <Input
                    label="Default Sea Rate (USD/CBM)"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 350"
                    value={shippingRatePerCbm}
                    onChange={(e) => setShippingRatePerCbm(e.target.value)}
                    hint="Base cost per cubic metre"
                  />
                </div>
                <div className="p-3 bg-brand-50 rounded-xl border border-brand-100">
                  <p className="text-sm text-brand-700">
                    Preview: <span className="font-bold">$100 USD = {(parseFloat(defaultRate) * 100 || 0).toFixed(2)} GHS</span>
                  </p>
                </div>
              </CardContent>
            </Card>
            <Button onClick={saveDefaultRate} className="flex items-center gap-2">
              <Save className="h-4 w-4" />
              Save Default Rates
            </Button>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Package className="h-5 w-5 text-brand-600" />
                  Package Pricing Tiers
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <p className="text-sm text-gray-500">
                  Set custom sea and air rates per customer package tier.
                </p>
                {(["standard", "discounted", "premium"] as (keyof PackageRates)[]).map((pkg) => (
                  <div key={pkg} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${PACKAGE_COLORS[pkg]}`}>{PACKAGE_LABELS[pkg]}</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input
                        label="Sea Rate (USD/CBM)"
                        type="number"
                        step="0.01"
                        min="0"
                        value={String(pkgRates[pkg].sea)}
                        onChange={(e) => setPkgRates((prev) => ({ ...prev, [pkg]: { ...prev[pkg], sea: parseFloat(e.target.value) || 0 } }))}
                      />
                      <Input
                        label="Air Rate (USD/kg)"
                        type="number"
                        step="0.01"
                        min="0"
                        value={String(pkgRates[pkg].air)}
                        onChange={(e) => setPkgRates((prev) => ({ ...prev, [pkg]: { ...prev[pkg], air: parseFloat(e.target.value) || 0 } }))}
                      />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Button onClick={savePackageRates} className="flex items-center gap-2">
              <Save className="h-4 w-4" />
              Save Package Rates
            </Button>
          </div>
        )}

        {/* Special Rates */}
        {activeTab === "special-rates" && (
          <div className="max-w-2xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Tag className="h-5 w-5 text-brand-600" />
                  Add Special Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-gray-500">
                  Create named rates you can apply to individual items when logging them.
                </p>
                <Input
                  label="Rate Name *"
                  placeholder="e.g. Electronics, Fragile, Oversized"
                  value={specialRateForm.name}
                  onChange={(e) => setSpecialRateForm({ ...specialRateForm, name: e.target.value })}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Sea Rate (USD/CBM)"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 400"
                    value={specialRateForm.sea}
                    onChange={(e) => setSpecialRateForm({ ...specialRateForm, sea: e.target.value })}
                  />
                  <Input
                    label="Air Rate (USD/kg)"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 10"
                    value={specialRateForm.air}
                    onChange={(e) => setSpecialRateForm({ ...specialRateForm, air: e.target.value })}
                  />
                </div>
                <Button onClick={addSpecialRate} className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  Add Rate
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Special Rate List</CardTitle>
              </CardHeader>
              <CardContent>
                {specialRates.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">No special rates yet. Add one above.</p>
                ) : (
                  <div className="space-y-3">
                    {specialRates.map((r) => (
                      <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 bg-white">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-900">{r.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Sea: ${r.sea}/CBM · Air: ${r.air}/kg
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {confirmDeleteSpecialId === r.id ? (
                            <>
                              <span className="text-xs text-red-600">Delete?</span>
                              <button
                                onClick={() => deleteSpecialRate(r.id)}
                                className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setConfirmDeleteSpecialId(null)}
                                className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteSpecialId(r.id)}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Warehouses */}
        {activeTab === "warehouses" && (
          <div className="max-w-2xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Warehouse className="h-5 w-5 text-brand-600" />
                  Add Warehouse
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Warehouse Name *"
                    placeholder="e.g. China Warehouse"
                    value={warehouseForm.name}
                    onChange={(e) => setWarehouseForm({ ...warehouseForm, name: e.target.value })}
                  />
                  <Input
                    label="Country"
                    placeholder="e.g. China"
                    value={warehouseForm.country}
                    onChange={(e) => setWarehouseForm({ ...warehouseForm, country: e.target.value })}
                  />
                </div>
                <Input
                  label="Full Address *"
                  placeholder="e.g. 123 Shipping Rd, Guangzhou, China"
                  value={warehouseForm.address}
                  onChange={(e) => setWarehouseForm({ ...warehouseForm, address: e.target.value })}
                />
                <Input
                  label="Phone (optional)"
                  placeholder="+86..."
                  value={warehouseForm.phone}
                  onChange={(e) => setWarehouseForm({ ...warehouseForm, phone: e.target.value })}
                />
                <Button onClick={addWarehouse} loading={savingWarehouse} className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  Add Warehouse
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Warehouse List</CardTitle>
              </CardHeader>
              <CardContent>
                {loadingWarehouses ? (
                  <div className="flex justify-center py-8">
                    <div className="animate-spin rounded-full h-6 w-6 border-2 border-brand-600 border-t-transparent" />
                  </div>
                ) : warehouses.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">No warehouses yet. Add one above.</p>
                ) : (
                  <div className="space-y-3">
                    {warehouses.map((w) => (
                      <div key={w.id} className={`flex items-start gap-3 p-3 rounded-xl border ${w.isActive ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50 opacity-60"}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-900">{w.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{w.address}</p>
                          {w.phone && <p className="text-xs text-gray-400 mt-0.5">{w.phone}</p>}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => toggleWarehouse(w.id, !w.isActive)}
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                            title={w.isActive ? "Deactivate" : "Activate"}
                          >
                            {w.isActive ? <ToggleRight className="h-4 w-4 text-green-600" /> : <ToggleLeft className="h-4 w-4" />}
                          </button>
                          {confirmDeleteWarehouseId === w.id ? (
                            <>
                              <span className="text-xs text-red-600">Delete?</span>
                              <button
                                onClick={() => { deleteWarehouse(w.id); setConfirmDeleteWarehouseId(null); }}
                                className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setConfirmDeleteWarehouseId(null)}
                                className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteWarehouseId(w.id)}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
