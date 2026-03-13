"use client";

import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { Calculator, Package, Anchor, Wind, ChevronDown } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { CustomerPackage } from "@/types";
import axios from "axios";

type Tab = "estimator" | "cbm";
type DimUnit = "cm" | "inches";

interface PackageRate { sea: number; air: number; }
interface PackageRates { standard: PackageRate; discounted: PackageRate; premium: PackageRate; special?: PackageRate; }

const DEFAULT_PKG_RATES: PackageRates = {
  standard: { sea: 350, air: 8 },
  discounted: { sea: 280, air: 6 },
  premium: { sea: 450, air: 12 },
};

const PACKAGE_META: Record<CustomerPackage, { label: string; color: string }> = {
  standard: { label: "Basic Shipping", color: "bg-gray-100 text-gray-700" },
  discounted: { label: "Business Shipping", color: "bg-blue-50 text-blue-700" },
  premium: { label: "Enterprise Shipping", color: "bg-amber-50 text-amber-700" },
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
    <div className={`flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0`}>
      <span className={`text-sm ${highlight ? "font-semibold text-gray-900" : "text-gray-500"}`}>{label}</span>
      <span className={`text-sm ${highlight ? "font-bold text-brand-700" : "text-gray-800"}`}>{value}</span>
    </div>
  );
}

export default function CustomerCalculatorPage() {
  const { appUser } = useAuth();
  const [tab, setTab] = useState<Tab>("estimator");
  // Currency state kept for internal rate use
  const [ghsPerUsd, setGhsPerUsd] = useState(15.5);
  const [pkgRates, setPkgRates] = useState<PackageRates>(DEFAULT_PKG_RATES);
  const [activePackage, setActivePackage] = useState<CustomerPackage | null>(null);
  const [showPkgPicker, setShowPkgPicker] = useState(false);
  const [savingPackage, setSavingPackage] = useState(false);

  // Estimator
  const [dimUnit, setDimUnit] = useState<DimUnit>("cm");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [qty, setQty] = useState("1");

  // CBM
  const [cbmL, setCbmL] = useState(""); const [cbmW, setCbmW] = useState(""); const [cbmH, setCbmH] = useState("");
  const [cbmUnit, setCbmUnit] = useState<DimUnit>("cm"); const [cbmQty, setCbmQty] = useState("1");

  // Currency
  const [usdAmount, setUsdAmount] = useState(""); const [ghsAmount, setGhsAmount] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("pakk_exchange_rates");
      if (saved) { const p = JSON.parse(saved); if (p.ghsPerUsd) setGhsPerUsd(p.ghsPerUsd); }
      const savedPkg = localStorage.getItem("pakk_package_rates");
      if (savedPkg) setPkgRates({ ...DEFAULT_PKG_RATES, ...JSON.parse(savedPkg) });
    } catch { /* ignore */ }
    if (appUser?.package) setActivePackage(appUser.package);
  }, [appUser?.package]);

  const handlePackageSwitch = async (pkg: CustomerPackage) => {
    setShowPkgPicker(false);
    if (!appUser?.customerId || pkg === activePackage) { setActivePackage(pkg); return; }
    setSavingPackage(true);
    try {
      await axios.patch(`/api/customers/${appUser.customerId}`, { package: pkg });
      setActivePackage(pkg);
    } catch { /* ignore, still switch locally */ setActivePackage(pkg); }
    finally { setSavingPackage(false); }
  };

  const n = (v: string) => parseFloat(v) || 0;
  const factor = (u: DimUnit) => u === "inches" ? 16.387064 : 1;

  const activeMeta = activePackage
    ? (PACKAGE_META[activePackage] ?? { label: activePackage, color: "bg-gray-100 text-gray-700" })
    : null;
  const currentRates = (activePackage ? pkgRates[activePackage] : null) ?? pkgRates.standard ?? DEFAULT_PKG_RATES.standard;

  // Estimator
  const cbmValue = (() => {
    const l = n(length), w = n(width), h = n(height), q = Math.max(1, n(qty));
    if (!l || !w || !h) return 0;
    return (l * w * h * factor(dimUnit)) / 1_000_000 * q;
  })();
  const seaCost = cbmValue > 0 ? cbmValue * currentRates.sea : 0;
  const airCost = n(weight) > 0 ? n(weight) * Math.max(1, n(qty)) * currentRates.air : 0;
  const cheaper = seaCost > 0 && airCost > 0 ? (seaCost < airCost ? "sea" : "air") : null;

  // CBM
  const cbmResult = (() => {
    const l = n(cbmL), w = n(cbmW), h = n(cbmH), q = Math.max(1, n(cbmQty));
    if (!l || !w || !h) return null;
    const single = (l * w * h * factor(cbmUnit)) / 1_000_000;
    return { single, total: single * q };
  })();

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "estimator", label: "Shipping Estimator", icon: <Package className="h-4 w-4" /> },
    { id: "cbm", label: "CBM Calculator", icon: <Calculator className="h-4 w-4" /> },
  ];

  return (
    <div className="flex flex-col h-full">
      <Header title="My Calculator" subtitle="Estimate shipping costs and convert currencies" />

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

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl mb-6 w-full max-w-lg">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-medium transition-colors ${tab === t.id ? "bg-white text-brand-700 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              {t.icon}<span className="hidden sm:inline">{t.label}</span>
            </button>
          ))}
        </div>

        {/* Shipping Estimator */}
        {tab === "estimator" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-3xl">
            <div className="space-y-4">
              <div className="bg-white border border-gray-100 rounded-2xl p-5 space-y-4">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-gray-800">Package Dimensions</p>
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                    {(["cm", "inches"] as DimUnit[]).map((u) => (
                      <button key={u} onClick={() => setDimUnit(u)} className={`px-2.5 py-1 font-medium transition-colors ${dimUnit === u ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}>{u}</button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Length" value={length} onChange={setLength} suffix={dimUnit} />
                  <Field label="Width" value={width} onChange={setWidth} suffix={dimUnit} />
                  <Field label="Height" value={height} onChange={setHeight} suffix={dimUnit} />
                </div>
                <Field label="Quantity" value={qty} onChange={setQty} placeholder="1" />
              </div>
              <div className="bg-white border border-gray-100 rounded-2xl p-5 space-y-4">
                <p className="text-sm font-semibold text-gray-800">Weight (for Air estimate)</p>
                <Field label="Total weight per package" value={weight} onChange={setWeight} suffix="kg" />
              </div>
            </div>
            <div className="space-y-4">
              <div className={`bg-white border rounded-2xl p-5 transition-all ${cheaper === "sea" ? "border-brand-300 ring-2 ring-brand-100" : "border-gray-100"}`}>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center"><Anchor className="h-4 w-4 text-blue-600" /></div>
                  <div><p className="text-sm font-semibold text-gray-800">Sea Freight</p><p className="text-xs text-gray-400">${currentRates.sea}/CBM</p></div>
                  {cheaper === "sea" && <span className="ml-auto text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">Cheaper</span>}
                </div>
                {cbmValue > 0 ? (
                  <>
                    <Row label="Volume" value={`${cbmValue.toFixed(4)} m³`} />
                    <Row label="Sea Cost (USD)" value={`$${seaCost.toFixed(2)}`} highlight />
                    <Row label="Sea Cost (GHS)" value={`GH₵${(seaCost * ghsPerUsd).toFixed(2)}`} highlight />
                  </>
                ) : <p className="text-sm text-gray-400 text-center py-3">Enter dimensions above</p>}
              </div>
              <div className={`bg-white border rounded-2xl p-5 transition-all ${cheaper === "air" ? "border-brand-300 ring-2 ring-brand-100" : "border-gray-100"}`}>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-xl bg-purple-50 flex items-center justify-center"><Wind className="h-4 w-4 text-purple-600" /></div>
                  <div><p className="text-sm font-semibold text-gray-800">Air Freight</p><p className="text-xs text-gray-400">${currentRates.air}/kg</p></div>
                  {cheaper === "air" && <span className="ml-auto text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">Cheaper</span>}
                </div>
                {airCost > 0 ? (
                  <>
                    <Row label="Weight" value={`${(n(weight) * Math.max(1, n(qty))).toFixed(2)} kg`} />
                    <Row label="Air Cost (USD)" value={`$${airCost.toFixed(2)}`} highlight />
                    <Row label="Air Cost (GHS)" value={`GH₵${(airCost * ghsPerUsd).toFixed(2)}`} highlight />
                  </>
                ) : <p className="text-sm text-gray-400 text-center py-3">Enter weight above</p>}
              </div>
              <p className="text-xs text-gray-400 text-center">Estimates only. Final charges confirmed at warehouse.</p>
            </div>
          </div>
        )}

        {/* CBM Calculator */}
        {tab === "cbm" && (
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
                  <p className="text-sm font-bold text-brand-800">${(cbmResult.total * currentRates.sea).toFixed(2)} USD · GH₵{(cbmResult.total * currentRates.sea * ghsPerUsd).toFixed(2)}</p>
                </div>
              </div>
            ) : (
              <div className="bg-gray-50 border border-gray-100 rounded-2xl p-8 text-center">
                <Calculator className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                <p className="text-sm text-gray-400">Enter dimensions to calculate CBM</p>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
