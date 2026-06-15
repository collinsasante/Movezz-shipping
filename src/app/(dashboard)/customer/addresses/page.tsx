"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/toast";
import type { Warehouse } from "@/types";
import { Copy, CheckCheck, Check } from "lucide-react";
import axios from "axios";

const DEFAULT_WAREHOUSE = { id: "__default__", name: "Guangzhou", address: "广州市花都区秀全街茶碑路8号519仓", phone: "13246840530", isActive: true, createdAt: "" };

export default function CustomerAddressesPage() {
  const { appUser } = useAuth();
  const { error } = useToast();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | null>(null);
  const [copiedWarehouseId, setCopiedWarehouseId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get("/api/warehouses");
      const list: Warehouse[] = res.data.data ?? [];
      const withDefault = list.length > 0 ? list : [DEFAULT_WAREHOUSE as Warehouse];
      setWarehouses(withDefault);
      const saved = localStorage.getItem("pakk_preferred_warehouse");
      const serverPref = appUser?.preferredWarehouseId;
      const preferred = saved ?? serverPref ?? null;
      const match = preferred ? withDefault.find((w) => w.id === preferred) : null;
      const resolved = match ?? withDefault[0];
      setSelectedWarehouseId(resolved?.id ?? null);
      if (!saved && resolved) localStorage.setItem("pakk_preferred_warehouse", resolved.id);
    } catch {
      setWarehouses([DEFAULT_WAREHOUSE as Warehouse]);
      setSelectedWarehouseId(DEFAULT_WAREHOUSE.id);
    } finally {
      setLoading(false);
    }
  }, [error]);

  useEffect(() => { load(); }, [load]);

  const selectWarehouse = (id: string) => {
    setSelectedWarehouseId(id);
    localStorage.setItem("pakk_preferred_warehouse", id);
    axios.patch("/api/customers/me/warehouse", { warehouseId: id }).catch(() => {});
  };

  const copyWarehouseAddress = (w: Warehouse) => {
    const mark = appUser?.shippingMark ? ` (${appUser.shippingMark})` : "";
    const text = `${w.address}${mark}\nTel: ${w.phone}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedWarehouseId(w.id);
      setTimeout(() => setCopiedWarehouseId(null), 2000);
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Shipping Addresses" subtitle="Select your preferred warehouse" />

      <div className="flex-1 p-4 sm:p-6 overflow-y-auto max-w-lg">
        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-28 bg-gray-100 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : warehouses.length === 0 ? (
          <div className="text-center py-16 text-gray-400 text-sm">No addresses available</div>
        ) : (
          <div className="space-y-3">
            {warehouses.map((w) => {
              const isSelected = w.id === selectedWarehouseId;
              const isCopied = copiedWarehouseId === w.id;
              const mark = appUser?.shippingMark ? ` (${appUser.shippingMark})` : "";

              return (
                <button
                  key={w.id}
                  onClick={() => selectWarehouse(w.id)}
                  className={`w-full text-left rounded-2xl border-2 p-4 transition-all ${
                    isSelected
                      ? "border-brand-500 bg-brand-50"
                      : "border-gray-100 bg-white hover:border-gray-200"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* Left: info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-sm font-semibold ${isSelected ? "text-brand-700" : "text-gray-900"}`}>
                          {w.name}
                        </span>
                        {isSelected && (
                          <span className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-600 bg-brand-100 rounded-full px-2 py-0.5">
                            <Check className="h-3 w-3" />
                            Selected
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 font-mono break-all leading-snug">
                        {w.address}{mark}
                      </p>
                      {w.phone && (
                        <p className="text-xs text-gray-400 mt-1">Tel: {w.phone}</p>
                      )}
                    </div>

                    {/* Right: copy button */}
                    <button
                      onClick={(e) => { e.stopPropagation(); copyWarehouseAddress(w); }}
                      className={`shrink-0 flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-colors ${
                        isCopied
                          ? "bg-green-100 text-green-600"
                          : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                      }`}
                      title="Copy address"
                    >
                      {isCopied
                        ? <><CheckCheck className="h-3.5 w-3.5" /> Copied</>
                        : <><Copy className="h-3.5 w-3.5" /> Copy</>
                      }
                    </button>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
