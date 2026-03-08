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
import { Settings, DollarSign, Users, Save, RefreshCw, Package } from "lucide-react";
import axios from "axios";

const RATES_KEY = "pakk_exchange_rates";
const COMPANY_KEY = "pakk_company_settings";

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
  const [activeTab, setActiveTab] = useState<"company" | "exchange" | "packages">("company");

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
  }, [activeTab, loadCustomers]);

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
          <div className="max-w-xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-brand-600" />
                  Default Exchange Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-gray-500">
                  Set the default USD → GHS exchange rate used for all invoices.
                </p>
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
                  label="Shipping Rate (USD per CBM)"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 200"
                  value={shippingRatePerCbm}
                  onChange={(e) => setShippingRatePerCbm(e.target.value)}
                  hint="Cost in USD for 1 cubic metre"
                />
                <div className="p-3 bg-brand-50 rounded-xl border border-brand-100">
                  <p className="text-sm text-brand-700">
                    Preview: <span className="font-bold">$100 USD = {(parseFloat(defaultRate) * 100 || 0).toFixed(2)} GHS</span>
                  </p>
                </div>
              </CardContent>
            </Card>
            <Button onClick={saveDefaultRate} className="flex items-center gap-2">
              <Save className="h-4 w-4" />
              Save Rates
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
      </div>
    </div>
  );
}
