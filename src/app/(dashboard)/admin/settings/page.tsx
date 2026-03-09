"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { SearchBar } from "@/components/shared/SearchBar";
import { DataTable } from "@/components/shared/DataTable";
import type { Customer, CustomerPackage } from "@/types";
import { Settings, DollarSign, Users, Save, RefreshCw, Package, Warehouse, Plus, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import axios from "axios";
import type { Warehouse as WarehouseType } from "@/types";

const RATES_KEY = "pakk_exchange_rates";
const COMPANY_KEY = "pakk_company_settings";
const PACKAGES_RATES_KEY = "pakk_package_rates";

interface PackageRate { sea: number; air: number; }
interface PackageRates { standard: PackageRate; discounted: PackageRate; premium: PackageRate; }
const DEFAULT_PKG_RATES: PackageRates = {
  standard: { sea: 350, air: 8 },
  discounted: { sea: 280, air: 6 },
  premium: { sea: 450, air: 12 },
};

const PACKAGE_OPTIONS: { value: CustomerPackage | ""; label: string }[] = [
  { value: "", label: "No package" },
  { value: "standard", label: "Standard" },
  { value: "discounted", label: "Discounted" },
  { value: "premium", label: "Premium" },
];

const PACKAGE_COLORS: Record<CustomerPackage, string> = {
  standard: "bg-gray-100 text-gray-700",
  discounted: "bg-blue-50 text-blue-700",
  premium: "bg-amber-50 text-amber-700",
};

interface CompanySettings {
  name: string;
  address: string;
  phone: string;
  email: string;
}

export default function AdminSettingsPage() {
  const { success, error } = useToast();
  const [activeTab, setActiveTab] = useState<"company" | "exchange" | "packages" | "warehouses">("company");

  // Company settings (localStorage)
  const [company, setCompany] = useState<CompanySettings>({
    name: "Pakkmaxx",
    address: "PAKKMAXX-9899-IRENE, Pakkmaxx Warehouse, Accra, Ghana",
    phone: "",
    email: "",
  });

  // Exchange rate settings
  const [defaultRate, setDefaultRate] = useState("12.5");
  const [shippingRatePerCbm, setShippingRatePerCbm] = useState("200");
  const [pkgRates, setPkgRates] = useState<PackageRates>(DEFAULT_PKG_RATES);

  // Warehouses
  const [warehouses, setWarehouses] = useState<WarehouseType[]>([]);
  const [loadingWarehouses, setLoadingWarehouses] = useState(false);
  const [warehouseForm, setWarehouseForm] = useState({ name: "", address: "", country: "", phone: "" });
  const [savingWarehouse, setSavingWarehouse] = useState(false);

  // Per-customer packages
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [savingCustomerId, setSavingCustomerId] = useState<string | null>(null);
  const [customerPackages, setCustomerPackages] = useState<Record<string, CustomerPackage | "">>({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem(RATES_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.usdToGhs) setDefaultRate(String(parsed.usdToGhs));
        if (parsed.shippingRatePerCbm) setShippingRatePerCbm(String(parsed.shippingRatePerCbm));
      }
    } catch {}
    const savedCompany = localStorage.getItem(COMPANY_KEY);
    if (savedCompany) {
      try { setCompany(JSON.parse(savedCompany)); } catch {}
    }
    const savedPkgRates = localStorage.getItem(PACKAGES_RATES_KEY);
    if (savedPkgRates) {
      try { setPkgRates(JSON.parse(savedPkgRates)); } catch {}
    }
  }, []);

  const saveCompany = () => {
    localStorage.setItem(COMPANY_KEY, JSON.stringify(company));
    success("Company settings saved");
  };

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

  const loadCustomers = useCallback(async (search?: string) => {
    setLoadingCustomers(true);
    try {
      const res = await axios.get("/api/customers", { params: { search } });
      const list: Customer[] = res.data.data;
      setCustomers(list);
      const pkgMap: Record<string, CustomerPackage | ""> = {};
      list.forEach((c) => {
        pkgMap[c.id] = c.package ?? "";
      });
      setCustomerPackages((prev) => ({ ...pkgMap, ...prev }));
    } catch {
      error("Failed to load customers");
    } finally {
      setLoadingCustomers(false);
    }
  }, [error]);

  useEffect(() => {
    if (activeTab === "packages") loadCustomers();
    if (activeTab === "warehouses") loadWarehouses();
  }, [activeTab, loadCustomers]);

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

  const saveCustomerPackage = async (customerId: string) => {
    const pkg = customerPackages[customerId];
    setSavingCustomerId(customerId);
    try {
      await axios.patch(`/api/customers/${customerId}`, {
        package: pkg || undefined,
      });
      success("Package saved");
    } catch {
      error("Failed to save package");
    } finally {
      setSavingCustomerId(null);
    }
  };

  const tabs = [
    { id: "company" as const, label: "Company", icon: Settings },
    { id: "exchange" as const, label: "Exchange Rates", icon: DollarSign },
    { id: "packages" as const, label: "Customer Packages", icon: Package },
    { id: "warehouses" as const, label: "Warehouses", icon: Warehouse },
  ];

  return (
    <div className="flex flex-col h-full">
      <Header title="Settings" subtitle="Manage system configuration" />

      <div className="flex-1 p-6 overflow-y-auto">
        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "bg-white shadow-sm text-gray-900"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Company Settings */}
        {activeTab === "company" && (
          <div className="max-w-xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="h-5 w-5 text-brand-600" />
                  Company Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  label="Company Name"
                  value={company.name}
                  onChange={(e) => setCompany({ ...company, name: e.target.value })}
                />
                <Input
                  label="Address"
                  value={company.address}
                  onChange={(e) => setCompany({ ...company, address: e.target.value })}
                />
                <Input
                  label="Phone"
                  value={company.phone}
                  onChange={(e) => setCompany({ ...company, phone: e.target.value })}
                />
                <Input
                  label="Email"
                  type="email"
                  value={company.email}
                  onChange={(e) => setCompany({ ...company, email: e.target.value })}
                />
              </CardContent>
            </Card>
            <Button onClick={saveCompany} className="flex items-center gap-2">
              <Save className="h-4 w-4" />
              Save Company Settings
            </Button>
          </div>
        )}

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
                <div className="grid grid-cols-2 gap-3">
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
                      <span className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize ${PACKAGE_COLORS[pkg]}`}>{pkg}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
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

        {/* Customer Packages */}
        {activeTab === "packages" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">
                  Assign a pricing package to each customer.
                </p>
                <div className="flex gap-2 mt-2">
                  {(["standard", "discounted", "premium"] as CustomerPackage[]).map((pkg) => (
                    <span key={pkg} className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize ${PACKAGE_COLORS[pkg]}`}>
                      {pkg}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <SearchBar
                  placeholder="Search customers..."
                  onSearch={(val) => {
                    setCustomerSearch(val);
                    loadCustomers(val);
                  }}
                  className="w-64"
                />
                <button
                  onClick={() => loadCustomers(customerSearch)}
                  className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            </div>

            <DataTable
              columns={[
                {
                  key: "name",
                  header: "Customer",
                  render: (c) => (
                    <div>
                      <p className="font-medium text-sm text-gray-900">{c.name}</p>
                      <code className="text-xs text-gray-400 font-mono">{c.shippingMark}</code>
                    </div>
                  ),
                },
                {
                  key: "email",
                  header: "Email",
                  render: (c) => <span className="text-sm text-gray-500">{c.email}</span>,
                },
                {
                  key: "currentPackage",
                  header: "Current Package",
                  render: (c) => c.package ? (
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize ${PACKAGE_COLORS[c.package]}`}>
                      {c.package}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">None</span>
                  ),
                },
                {
                  key: "package",
                  header: "Assign Package",
                  render: (c) => (
                    <select
                      value={customerPackages[c.id] ?? ""}
                      onChange={(e) =>
                        setCustomerPackages((prev) => ({ ...prev, [c.id]: e.target.value as CustomerPackage | "" }))
                      }
                      className="h-8 text-sm px-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      {PACKAGE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ),
                },
                {
                  key: "actions",
                  header: "",
                  render: (c) => (
                    <Button
                      size="sm"
                      variant="outline"
                      loading={savingCustomerId === c.id}
                      onClick={() => saveCustomerPackage(c.id)}
                    >
                      Save
                    </Button>
                  ),
                },
              ]}
              data={customers}
              keyExtractor={(c) => c.id}
              loading={loadingCustomers}
              emptyMessage="No customers found"
              emptyIcon={<Users className="h-10 w-10" />}
            />
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
                <div className="grid grid-cols-2 gap-3">
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
                          <button
                            onClick={() => deleteWarehouse(w.id)}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
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
