"use client";

import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { Calculator, ArrowLeftRight, Package, Anchor, Wind } from "lucide-react";

type Tab = "estimator" | "cbm" | "currency";
type DimUnit = "cm" | "inches";

const DEFAULT_RATES = { seaRatePerCbm: 350, airRatePerKg: 8, ghsPerUsd: 15.5 };

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
        {prefix && (
          <span className="px-3 text-sm text-gray-400 border-r border-gray-100 bg-gray-50 h-full flex items-center shrink-0">{prefix}</span>
        )}
        <input
          type="number"
          step="any"
          min="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "0"}
          className="flex-1 px-3 text-sm focus:outline-none bg-transparent"
        />
        {suffix && (
          <span className="px-3 text-sm text-gray-400 border-l border-gray-100 bg-gray-50 h-full flex items-center shrink-0">{suffix}</span>
        )}
      </div>
    </div>
  );
}

function ResultRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0 ${highlight ? "font-semibold" : ""}`}>
      <span className={`text-sm ${highlight ? "text-gray-900" : "text-gray-500"}`}>{label}</span>
      <span className={`text-sm ${highlight ? "text-brand-700" : "text-gray-800"}`}>{value}</span>
    </div>
  );
}

export default function CustomerCalculatorPage() {
  const [tab, setTab] = useState<Tab>("estimator");
  const [rates, setRates] = useState(DEFAULT_RATES);

  // Estimator
  const [dimUnit, setDimUnit] = useState<DimUnit>("cm");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [qty, setQty] = useState("1");

  // CBM standalone
  const [cbmL, setCbmL] = useState("");
  const [cbmW, setCbmW] = useState("");
  const [cbmH, setCbmH] = useState("");
  const [cbmUnit, setCbmUnit] = useState<DimUnit>("cm");
  const [cbmQty, setCbmQty] = useState("1");

  // Currency
  const [usdAmount, setUsdAmount] = useState("");
  const [ghsAmount, setGhsAmount] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("pakk_exchange_rates");
      if (saved) {
        const p = JSON.parse(saved);
        setRates((prev) => ({
          seaRatePerCbm: p.shippingRatePerCbm ?? prev.seaRatePerCbm,
          airRatePerKg: prev.airRatePerKg,
          ghsPerUsd: p.ghsPerUsd ?? prev.ghsPerUsd,
        }));
      }
    } catch { /* ignore */ }
  }, []);

  const n = (v: string) => parseFloat(v) || 0;
  const factor = (u: DimUnit) => u === "inches" ? 16.387064 : 1;

  // Estimator calculations
  const cbmValue = (() => {
    const l = n(length), w = n(width), h = n(height), q = Math.max(1, n(qty));
    if (!l || !w || !h) return 0;
    return (l * w * h * factor(dimUnit)) / 1_000_000 * q;
  })();
  const seaCost = cbmValue > 0 ? cbmValue * rates.seaRatePerCbm : 0;
  const airCost = n(weight) > 0 ? n(weight) * Math.max(1, n(qty)) * rates.airRatePerKg : 0;
  const seaGhs = seaCost * rates.ghsPerUsd;
  const airGhs = airCost * rates.ghsPerUsd;
  const cheaper = seaCost > 0 && airCost > 0 ? (seaCost < airCost ? "sea" : "air") : null;

  // CBM tab
  const cbmResult = (() => {
    const l = n(cbmL), w = n(cbmW), h = n(cbmH), q = Math.max(1, n(cbmQty));
    if (!l || !w || !h) return null;
    const single = (l * w * h * factor(cbmUnit)) / 1_000_000;
    return { single, total: single * q };
  })();

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "estimator", label: "Shipping Estimator", icon: <Package className="h-4 w-4" /> },
    { id: "cbm", label: "CBM Calculator", icon: <Calculator className="h-4 w-4" /> },
    { id: "currency", label: "Currency", icon: <ArrowLeftRight className="h-4 w-4" /> },
  ];

  return (
    <div className="flex flex-col h-full">
      <Header title="My Calculator" subtitle="Estimate shipping costs and convert currencies" />

      <div className="flex-1 p-4 md:p-6 overflow-y-auto">
        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl mb-6 w-full max-w-lg">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-medium transition-colors ${
                tab === t.id ? "bg-white text-brand-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.icon}
              <span className="hidden sm:inline">{t.label}</span>
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
                      <button
                        key={u}
                        onClick={() => setDimUnit(u)}
                        className={`px-2.5 py-1 font-medium transition-colors ${dimUnit === u ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Length" value={length} onChange={setLength} suffix={dimUnit} />
                  <Field label="Width" value={width} onChange={setWidth} suffix={dimUnit} />
                  <Field label="Height" value={height} onChange={setHeight} suffix={dimUnit} />
                </div>
                <Field label="Quantity (packages)" value={qty} onChange={setQty} placeholder="1" />
              </div>

              <div className="bg-white border border-gray-100 rounded-2xl p-5 space-y-4">
                <p className="text-sm font-semibold text-gray-800">Weight (for Air estimate)</p>
                <Field label="Total weight" value={weight} onChange={setWeight} suffix="kg" placeholder="e.g. 5" />
                <p className="text-xs text-gray-400">Per package — will be multiplied by quantity</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Sea card */}
              <div className={`bg-white border rounded-2xl p-5 transition-all ${cheaper === "sea" ? "border-brand-300 ring-2 ring-brand-100" : "border-gray-100"}`}>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center">
                    <Anchor className="h-4 w-4 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">Sea Freight</p>
                    <p className="text-xs text-gray-400">Based on volume (CBM)</p>
                  </div>
                  {cheaper === "sea" && (
                    <span className="ml-auto text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">Cheaper</span>
                  )}
                </div>
                {cbmValue > 0 ? (
                  <div className="space-y-0">
                    <ResultRow label="Volume" value={`${cbmValue.toFixed(4)} m³`} />
                    <ResultRow label={`Rate ($${rates.seaRatePerCbm}/m³)`} value={`× ${cbmValue.toFixed(4)}`} />
                    <ResultRow label="Sea Cost (USD)" value={`$${seaCost.toFixed(2)}`} highlight />
                    <ResultRow label="Sea Cost (GHS)" value={`GH₵${seaGhs.toFixed(2)}`} highlight />
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-3">Enter dimensions above</p>
                )}
              </div>

              {/* Air card */}
              <div className={`bg-white border rounded-2xl p-5 transition-all ${cheaper === "air" ? "border-brand-300 ring-2 ring-brand-100" : "border-gray-100"}`}>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-xl bg-purple-50 flex items-center justify-center">
                    <Wind className="h-4 w-4 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">Air Freight</p>
                    <p className="text-xs text-gray-400">Based on weight (kg)</p>
                  </div>
                  {cheaper === "air" && (
                    <span className="ml-auto text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">Cheaper</span>
                  )}
                </div>
                {airCost > 0 ? (
                  <div className="space-y-0">
                    <ResultRow label="Weight" value={`${(n(weight) * Math.max(1, n(qty))).toFixed(2)} kg`} />
                    <ResultRow label={`Rate ($${rates.airRatePerKg}/kg)`} value={`× ${(n(weight) * Math.max(1, n(qty))).toFixed(2)}`} />
                    <ResultRow label="Air Cost (USD)" value={`$${airCost.toFixed(2)}`} highlight />
                    <ResultRow label="Air Cost (GHS)" value={`GH₵${airGhs.toFixed(2)}`} highlight />
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-3">Enter weight above</p>
                )}
              </div>

              <p className="text-xs text-gray-400 text-center">
                Rates are estimates. Final charges confirmed at warehouse.
              </p>
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
                    <button
                      key={u}
                      onClick={() => setCbmUnit(u)}
                      className={`px-2.5 py-1 font-medium transition-colors ${cbmUnit === u ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
                    >
                      {u}
                    </button>
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

            {cbmResult && (
              <div className="bg-brand-50 border border-brand-100 rounded-2xl p-5 space-y-3">
                <p className="text-xs font-semibold text-brand-600 uppercase tracking-wide">Result</p>
                <ResultRow label="CBM per package" value={`${cbmResult.single.toFixed(6)} m³`} />
                {n(cbmQty) > 1 && (
                  <ResultRow label={`Total (× ${n(cbmQty)})`} value={`${cbmResult.total.toFixed(6)} m³`} highlight />
                )}
                {n(cbmQty) <= 1 && (
                  <div className="pt-1 border-t border-brand-100">
                    <p className="text-lg font-bold text-brand-700">{cbmResult.single.toFixed(4)} m³</p>
                  </div>
                )}
                <div className="pt-2 border-t border-brand-100 space-y-1">
                  <p className="text-xs text-brand-600 font-medium">Estimated sea shipping cost:</p>
                  <p className="text-sm font-bold text-brand-800">
                    ${(cbmResult.total * rates.seaRatePerCbm).toFixed(2)} USD &nbsp;·&nbsp; GH₵{(cbmResult.total * rates.seaRatePerCbm * rates.ghsPerUsd).toFixed(2)}
                  </p>
                </div>
              </div>
            )}

            {!cbmResult && (
              <div className="bg-gray-50 border border-gray-100 rounded-2xl p-8 text-center">
                <Calculator className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                <p className="text-sm text-gray-400">Enter dimensions to calculate CBM</p>
              </div>
            )}
          </div>
        )}

        {/* Currency Converter */}
        {tab === "currency" && (
          <div className="max-w-sm space-y-4">
            <div className="bg-white border border-gray-100 rounded-2xl p-5 space-y-5">
              <div>
                <p className="text-sm font-semibold text-gray-800 mb-1">Exchange Rate</p>
                <p className="text-xs text-gray-400">1 USD = {rates.ghsPerUsd} GHS</p>
              </div>

              <Field
                label="Amount in USD ($)"
                value={usdAmount}
                onChange={(v) => {
                  setUsdAmount(v);
                  setGhsAmount(v ? (parseFloat(v) * rates.ghsPerUsd).toFixed(2) : "");
                }}
                prefix="$"
                placeholder="e.g. 100"
              />

              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-gray-100" />
                <ArrowLeftRight className="h-4 w-4 text-gray-300" />
                <div className="flex-1 h-px bg-gray-100" />
              </div>

              <Field
                label="Amount in GHS (GH₵)"
                value={ghsAmount}
                onChange={(v) => {
                  setGhsAmount(v);
                  setUsdAmount(v ? (parseFloat(v) / rates.ghsPerUsd).toFixed(2) : "");
                }}
                prefix="GH₵"
                placeholder="e.g. 1550"
              />
            </div>

            {n(usdAmount) > 0 && (
              <div className="bg-green-50 border border-green-100 rounded-2xl p-5 space-y-2">
                <p className="text-xs font-semibold text-green-600 uppercase tracking-wide">Result</p>
                <p className="text-2xl font-bold text-green-700">GH₵{(n(usdAmount) * rates.ghsPerUsd).toFixed(2)}</p>
                <p className="text-xs text-green-600">${n(usdAmount).toFixed(2)} USD at {rates.ghsPerUsd} rate</p>
              </div>
            )}

            <p className="text-xs text-gray-400 text-center">
              Rate set by Pakkmaxx. May differ from bank rates.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
