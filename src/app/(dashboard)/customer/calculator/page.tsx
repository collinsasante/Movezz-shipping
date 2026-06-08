"use client";

import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { Calculator, Package, ChevronDown } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { CustomerPackage } from "@/types";
import axios from "axios";

type DimUnit = "cm" | "inches";

interface PackageRate { sea: number; air: number; }
interface PackageRates { basic: PackageRate; business: PackageRate; enterprise: PackageRate; special?: PackageRate; }

const DEFAULT_PKG_RATES: PackageRates = {
  basic: { sea: 270, air: 8 },
  business: { sea: 280, air: 6 },
  enterprise: { sea: 450, air: 12 },
};

const PACKAGE_META: Record<CustomerPackage, { label: string; color: string }> = {
  basic: { label: "Basic", color: "bg-gray-100 text-gray-700" },
  business: { label: "Business", color: "bg-blue-50 text-blue-700" },
  enterprise: { label: "Enterprise", color: "bg-amber-50 text-amber-700" },
  special: { label: "Special", color: "bg-purple-50 text-purple-700" },
};

function Field({
  label, value, onChange, prefix, suffix, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  prefix?: string; suffix?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <div className="flex items-center h-11 rounded-xl border border-gray-200 bg-white overflow-hidden focus-within:ring-2 focus-within:ring-brand-500">
        {prefix && <span className="px-3 text-sm text-gray-400 border-r border-gray-100 bg-gray-50 h-full flex items-center shrink-0">{prefix}</span>}
        <input type="number" step="any" min="0" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? "0"} className="flex-1 px-3 text-sm focus:outline-none bg-transparent" />
        {suffix && <span className="px-3 text-sm text-gray-400 border-l border-gray-100 bg-gray-50 h-full flex items-center shrink-0">{suffix}</span>}
      </div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0">
      <span className={`text-sm ${highlight ? "font-semibold text-gray-900" : "text-gray-500"}`}>{label}</span>
      <span className={`text-sm ${highlight ? "font-bold text-brand-700" : "text-gray-800"}`}>{value}</span>
    </div>
  );
}

export default function CustomerCalculatorPage() {
  const { appUser } = useAuth();
  const [pkgRates, setPkgRates] = useState<PackageRates>(DEFAULT_PKG_RATES);
  const [activePackage, setActivePackage] = useState<CustomerPackage | null>(null);
  const [showPkgPicker, setShowPkgPicker] = useState(false);
  const [savingPackage, setSavingPackage] = useState(false);

  const [cbmL, setCbmL] = useState("");
  const [cbmW, setCbmW] = useState("");
  const [cbmH, setCbmH] = useState("");
  const [cbmUnit, setCbmUnit] = useState<DimUnit>("cm");
  const [cbmQty, setCbmQty] = useState("1");

  useEffect(() => {
    try {
      const savedPkg = localStorage.getItem("pakk_package_rates");
      if (savedPkg) setPkgRates({ ...DEFAULT_PKG_RATES, ...JSON.parse(savedPkg) });
    } catch { /* ignore */ }
    if (appUser?.package) setActivePackage(appUser.package);
    // Fetch live rates from Airtable so configured rates always apply
    axios.get("/api/package-rates").then((res) => {
      if (res.data?.data) {
        const fetched = res.data.data;
        setPkgRates((prev) => ({ ...DEFAULT_PKG_RATES, ...prev, ...fetched }));
        try { localStorage.setItem("pakk_package_rates", JSON.stringify(fetched)); } catch {}
      }
    }).catch(() => {});
  }, [appUser?.package]);

  const handlePackageSwitch = async (pkg: CustomerPackage) => {
    setShowPkgPicker(false);
    if (!appUser?.customerId || pkg === activePackage) { setActivePackage(pkg); return; }
    setSavingPackage(true);
    try {
      await axios.patch(`/api/customers/${appUser.customerId}`, { package: pkg });
      setActivePackage(pkg);
    } catch { setActivePackage(pkg); }
    finally { setSavingPackage(false); }
  };

  const n = (v: string) => parseFloat(v) || 0;
  const factor = (u: DimUnit) => u === "inches" ? 16.387064 : 1;

  const activeMeta = activePackage
    ? (PACKAGE_META[activePackage] ?? { label: activePackage, color: "bg-gray-100 text-gray-700" })
    : null;
  const currentRates = (activePackage ? pkgRates[activePackage] : null) ?? pkgRates.basic ?? DEFAULT_PKG_RATES.basic;

  const cbmResult = (() => {
    const l = n(cbmL), w = n(cbmW), h = n(cbmH), q = Math.max(1, n(cbmQty));
    if (!l || !w || !h) return null;
    const single = (l * w * h * factor(cbmUnit)) / 1_000_000;
    return { single, total: single * q };
  })();

  return (
    <div className="flex flex-col h-full">
      <Header title="CBM Calculator" subtitle="Calculate the cubic volume of your packages" />

      <div className="flex-1 p-4 md:p-6 overflow-y-auto">
        {/* Package selector */}
        <div className="flex items-center justify-between mb-5">
          <div className="relative">
            <button
              onClick={() => setShowPkgPicker((v) => !v)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm hover:bg-gray-50 transition-colors"
            >
              <Package className="h-4 w-4 text-gray-400" />
              {activeMeta ? (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${activeMeta.color}`}>
                  {activeMeta.label}
                </span>
              ) : (
                <span className="text-xs text-gray-400">No package selected</span>
              )}
              <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
              {savingPackage && <span className="text-xs text-brand-500">Saving...</span>}
            </button>
            {showPkgPicker && (
              <div className="absolute top-full left-0 mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg z-10 overflow-hidden">
                {(Object.entries(PACKAGE_META) as [CustomerPackage, { label: string; color: string }][]).map(([pkg, meta]) => (
                  <button
                    key={pkg}
                    onClick={() => handlePackageSwitch(pkg)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50 transition-colors ${activePackage === pkg ? "bg-brand-50" : ""}`}
                  >
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.color}`}>{meta.label}</span>
                    {activePackage === pkg && <span className="ml-auto text-xs text-brand-500">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {activePackage && (
            <p className="text-xs text-gray-400">Sea: ${currentRates.sea}/CBM · Air: ${currentRates.air}/kg</p>
          )}
        </div>

        {/* CBM Calculator */}
        <div className="max-w-md space-y-4">
          <div className="bg-white border border-gray-100 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-800">Package Dimensions</p>
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                {(["cm", "inches"] as DimUnit[]).map((u) => (
                  <button key={u} onClick={() => setCbmUnit(u)} className={`px-2.5 py-1 font-medium transition-colors ${cbmUnit === u ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}>{u}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Length" value={cbmL} onChange={setCbmL} suffix={cbmUnit} />
              <Field label="Width" value={cbmW} onChange={setCbmW} suffix={cbmUnit} />
              <Field label="Height" value={cbmH} onChange={setCbmH} suffix={cbmUnit} />
            </div>
            <Field label="Quantity" value={cbmQty} onChange={setCbmQty} placeholder="1" />
          </div>
          {cbmResult ? (
            <div className="bg-brand-50 border border-brand-100 rounded-2xl p-5 space-y-3">
              <p className="text-xs font-semibold text-brand-600 uppercase tracking-wide">Result</p>
              <Row label="CBM per package" value={`${cbmResult.single.toFixed(6)} m³`} />
              {n(cbmQty) > 1 && <Row label={`Total (× ${n(cbmQty)})`} value={`${cbmResult.total.toFixed(6)} m³`} highlight />}
              {n(cbmQty) <= 1 && <p className="text-lg font-bold text-brand-700">{cbmResult.single.toFixed(4)} m³</p>}
              <div className="pt-2 border-t border-brand-100 space-y-1">
                <p className="text-xs text-brand-600 font-medium">Estimated sea shipping:</p>
                <p className="text-sm font-bold text-brand-800">${(cbmResult.total * currentRates.sea).toFixed(2)}</p>
              </div>
            </div>
          ) : (
            <div className="bg-gray-50 border border-gray-100 rounded-2xl p-8 text-center">
              <Calculator className="h-8 w-8 text-gray-200 mx-auto mb-2" />
              <p className="text-sm text-gray-400">Enter dimensions to calculate CBM</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
