"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/toast";
import type { Warehouse } from "@/types";
import { Warehouse as WarehouseIcon, Copy, CheckCheck } from "lucide-react";
import axios from "axios";

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
      const list: Warehouse[] = res.data.data;
      setWarehouses(list);
      const saved = localStorage.getItem("pakk_preferred_warehouse");
      const serverPref = appUser?.preferredWarehouseId;
      const preferred = saved ?? serverPref ?? null;
      const match = preferred ? list.find((w) => w.id === preferred) : null;
      const resolved = match ?? list[0] ?? null;
      setSelectedWarehouseId(resolved?.id ?? null);
      // Sync server preference to localStorage if localStorage was empty
      if (!saved && resolved) localStorage.setItem("pakk_preferred_warehouse", resolved.id);
    } catch {
      error("Failed to load warehouses");
    } finally {
      setLoading(false);
    }
  }, [error]);

  useEffect(() => { load(); }, [load]);

  const selectWarehouse = (id: string) => {
    setSelectedWarehouseId(id);
    localStorage.setItem("pakk_preferred_warehouse", id);
    // Also persist to Airtable so preference survives across devices
    axios.patch("/api/customers/me/warehouse", { warehouseId: id }).catch(() => {});
  };

  const selectedWarehouse = warehouses.find((w) => w.id === selectedWarehouseId) ?? null;

  const copyWarehouseAddress = (w: Warehouse) => {
    const mark = appUser?.shippingMark ? ` (${appUser.shippingMark})` : "";
    const text = `${w.address}${mark}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedWarehouseId(w.id);
      setTimeout(() => setCopiedWarehouseId(null), 2000);
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Addresses" subtitle="Warehouse locations you can ship to" />

      <div className="flex-1 p-6 space-y-4 overflow-y-auto max-w-2xl">
        {loading ? (
          <div className="h-10 bg-gray-100 rounded-lg animate-pulse" />
        ) : warehouses.length === 0 ? (
          <div className="text-center py-10 bg-white border border-gray-100 rounded-xl">
            <WarehouseIcon className="h-10 w-10 text-gray-200 mx-auto mb-2" />
            <p className="text-sm text-gray-400">No warehouses available</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-2">Select your preferred warehouse location.</p>
            <select
              value={selectedWarehouseId ?? ""}
              onChange={(e) => selectWarehouse(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>

            {selectedWarehouse && (
              <div className="p-4 rounded-xl border border-gray-200 bg-white">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{selectedWarehouse.name}</p>
                    <p className="text-sm text-gray-600 mt-0.5 break-all">
                      {selectedWarehouse.address}{appUser?.shippingMark ? ` (${appUser.shippingMark})` : ""}
                    </p>
                    {selectedWarehouse.phone && <p className="text-xs text-gray-500 mt-0.5">{selectedWarehouse.phone}</p>}
                  </div>
                  <button
                    onClick={() => copyWarehouseAddress(selectedWarehouse)}
                    className="shrink-0 p-1 rounded hover:bg-brand-100 transition-colors"
                    title="Copy address + shipping mark"
                  >
                    {copiedWarehouseId === selectedWarehouse.id
                      ? <CheckCheck className="h-4 w-4 text-green-500" />
                      : <Copy className="h-4 w-4" />
                    }
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
