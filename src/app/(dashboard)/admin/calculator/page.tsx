"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { Calculator, Copy, Check, RefreshCw } from "lucide-react";

type FreightMode = "sea" | "air";

const DEFAULT_RATES = {
  seaRatePerCbm: 350,   // USD per CBM
  airRatePerKg: 8,       // USD per kg
  dutyPercent: 20,       // %
  agentFee: 50,          // USD flat
  ghsPerUsd: 15.5,
};

function InputField({
  label, value, onChange, prefix, suffix, type = "number", step = "any",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  type?: string;
  step?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <div className="flex items-center h-10 rounded-lg border border-gray-200 bg-white overflow-hidden focus-within:ring-2 focus-within:ring-brand-500">
        {prefix && (
          <span className="px-3 text-sm text-gray-500 border-r border-gray-200 bg-gray-50 h-full flex items-center shrink-0">
            {prefix}
          </span>
        )}
        <input
          type={type}
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 px-3 text-sm focus:outline-none bg-transparent"
        />
        {suffix && (
          <span className="px-3 text-sm text-gray-500 border-l border-gray-200 bg-gray-50 h-full flex items-center shrink-0">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

export default function CalculatorPage() {
  const [mode, setMode] = useState<FreightMode>("sea");
  const [copied, setCopied] = useState(false);

  // Inputs
  const [productCost, setProductCost] = useState("");
  const [chinaShipping, setChinaShipping] = useState("");
  const [cbm, setCbm] = useState("");
  const [weight, setWeight] = useState("");
  const [seaRate, setSeaRate] = useState(String(DEFAULT_RATES.seaRatePerCbm));
  const [airRate, setAirRate] = useState(String(DEFAULT_RATES.airRatePerKg));
  const [dutyPercent, setDutyPercent] = useState(String(DEFAULT_RATES.dutyPercent));
  const [agentFee, setAgentFee] = useState(String(DEFAULT_RATES.agentFee));
  const [ghsPerUsd, setGhsPerUsd] = useState(String(DEFAULT_RATES.ghsPerUsd));

  // Load saved exchange rate from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pakk_exchange_rates");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.ghsPerUsd) setGhsPerUsd(String(parsed.ghsPerUsd));
      }
    } catch { /* ignore */ }
  }, []);

  const n = (v: string) => parseFloat(v) || 0;

  const calc = useCallback(() => {
    const product = n(productCost);
    const china = n(chinaShipping);
    const intlFreight = mode === "sea" ? n(cbm) * n(seaRate) : n(weight) * n(airRate);
    const subtotal = product + china + intlFreight;
    const duty = subtotal * (n(dutyPercent) / 100);
    const agent = n(agentFee);
    const totalUsd = subtotal + duty + agent;
    const totalGhs = totalUsd * n(ghsPerUsd);

    return { product, china, intlFreight, subtotal, duty, agent, totalUsd, totalGhs };
  }, [productCost, chinaShipping, cbm, weight, seaRate, airRate, dutyPercent, agentFee, ghsPerUsd, mode]);

  const result = calc();

  const handleCopy = () => {
    const { product, china, intlFreight, duty, agent, totalUsd, totalGhs } = result;
    const rate = n(ghsPerUsd);
    const lines = [
      "===== LANDED COST SUMMARY =====",
      `Product Cost:          $${product.toFixed(2)}`,
      `China Shipping:        $${china.toFixed(2)}`,
      `Intl Freight (${mode === "sea" ? "Sea" : "Air"}):  $${intlFreight.toFixed(2)}`,
      `Customs Duty (${dutyPercent}%):   $${duty.toFixed(2)}`,
      `Agent Fees:            $${agent.toFixed(2)}`,
      "-------------------------------",
      `Total (USD):           $${totalUsd.toFixed(2)}`,
      `Total (GHS @ ${rate}):  GH₵${totalGhs.toFixed(2)}`,
      "===============================",
    ].join("\n");
    navigator.clipboard.writeText(lines).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleReset = () => {
    setProductCost(""); setChinaShipping(""); setCbm(""); setWeight("");
    setSeaRate(String(DEFAULT_RATES.seaRatePerCbm));
    setAirRate(String(DEFAULT_RATES.airRatePerKg));
    setDutyPercent(String(DEFAULT_RATES.dutyPercent));
    setAgentFee(String(DEFAULT_RATES.agentFee));
  };

  const hasValues = n(productCost) > 0 || n(chinaShipping) > 0 || n(cbm) > 0 || n(weight) > 0;

  return (
    <div className="flex flex-col h-full">
      <Header title="Landing Cost Calculator" subtitle="Estimate total landed cost for goods from China" />

      <div className="flex-1 p-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">

          {/* Inputs */}
          <div className="space-y-4">
            {/* Product Costs */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Product Costs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <InputField label="Product Cost (USD)" value={productCost} onChange={setProductCost} prefix="$" />
                <InputField label="China Domestic Shipping (USD)" value={chinaShipping} onChange={setChinaShipping} prefix="$" />
              </CardContent>
            </Card>

            {/* International Freight */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">International Freight</CardTitle>
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                    <button
                      onClick={() => setMode("sea")}
                      className={`px-3 py-1.5 font-medium transition-colors ${mode === "sea" ? "bg-brand-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}
                    >
                      Sea (CBM)
                    </button>
                    <button
                      onClick={() => setMode("air")}
                      className={`px-3 py-1.5 font-medium transition-colors ${mode === "air" ? "bg-brand-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}
                    >
                      Air (kg)
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {mode === "sea" ? (
                  <>
                    <InputField label="Volume (CBM)" value={cbm} onChange={setCbm} suffix="m³" />
                    <InputField label="Sea Freight Rate" value={seaRate} onChange={setSeaRate} prefix="$" suffix="/CBM" />
                  </>
                ) : (
                  <>
                    <InputField label="Weight (kg)" value={weight} onChange={setWeight} suffix="kg" />
                    <InputField label="Air Freight Rate" value={airRate} onChange={setAirRate} prefix="$" suffix="/kg" />
                  </>
                )}
                {mode === "sea" && n(cbm) > 0 && n(seaRate) > 0 && (
                  <p className="text-xs text-gray-500">
                    {n(cbm).toFixed(3)} m³ × ${n(seaRate)} = <span className="font-semibold text-gray-700">${result.intlFreight.toFixed(2)}</span>
                  </p>
                )}
                {mode === "air" && n(weight) > 0 && n(airRate) > 0 && (
                  <p className="text-xs text-gray-500">
                    {n(weight)} kg × ${n(airRate)} = <span className="font-semibold text-gray-700">${result.intlFreight.toFixed(2)}</span>
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Duties & Fees */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Duties & Fees</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <InputField label="Customs Duty %" value={dutyPercent} onChange={setDutyPercent} suffix="%" />
                <InputField label="Agent / Clearing Fees (USD)" value={agentFee} onChange={setAgentFee} prefix="$" />
              </CardContent>
            </Card>

            {/* Exchange Rate */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Exchange Rate</CardTitle>
              </CardHeader>
              <CardContent>
                <InputField label="GHS per 1 USD" value={ghsPerUsd} onChange={setGhsPerUsd} prefix="GH₵" suffix="/USD" />
              </CardContent>
            </Card>
          </div>

          {/* Results */}
          <div className="space-y-4">
            <Card className="sticky top-6">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Calculator className="h-4 w-4 text-brand-600" />
                    Cost Breakdown
                  </CardTitle>
                  <button
                    onClick={handleReset}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    title="Reset"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {[
                    { label: "Product Cost", value: result.product },
                    { label: "China Shipping", value: result.china },
                    { label: `Intl Freight (${mode === "sea" ? "Sea" : "Air"})`, value: result.intlFreight },
                    { label: `Customs Duty (${dutyPercent}%)`, value: result.duty },
                    { label: "Agent Fees", value: result.agent },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex items-center justify-between py-1.5 border-b border-gray-50">
                      <span className="text-sm text-gray-600">{label}</span>
                      <span className={`text-sm font-medium ${value > 0 ? "text-gray-900" : "text-gray-300"}`}>
                        ${value.toFixed(2)}
                      </span>
                    </div>
                  ))}

                  <div className="pt-3 space-y-3">
                    <div className="flex items-center justify-between p-3 bg-brand-50 rounded-xl">
                      <span className="text-sm font-semibold text-brand-700">Total (USD)</span>
                      <span className="text-lg font-bold text-brand-700">
                        ${result.totalUsd.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between p-3 bg-green-50 rounded-xl">
                      <span className="text-sm font-semibold text-green-700">Total (GHS)</span>
                      <span className="text-lg font-bold text-green-700">
                        {formatCurrency(result.totalGhs, "GHS")}
                      </span>
                    </div>
                  </div>

                  {hasValues && (
                    <button
                      onClick={handleCopy}
                      className="mt-4 w-full flex items-center justify-center gap-2 h-10 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      {copied ? (
                        <><Check className="h-4 w-4 text-green-600" /> Copied!</>
                      ) : (
                        <><Copy className="h-4 w-4" /> Copy Summary</>
                      )}
                    </button>
                  )}

                  {!hasValues && (
                    <p className="text-center text-xs text-gray-400 pt-4">
                      Enter values on the left to see the breakdown
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
