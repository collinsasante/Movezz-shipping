"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { Boxes, ChevronDown, ChevronRight, ShoppingCart, Trash2, X, Plus } from "lucide-react";
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
import type { Item } from "@/types";

export interface CartonSummary {
  cartonNumber: string;
  items: Item[];
  cbm: number;
}

interface CartonCardProps {
  carton: CartonSummary;
  customerId: string;
  /** Customer's other eligible items (uninvoiced, unpacked, non-special) offered in the "Add items" picker. */
  addableItems: Item[];
  onChanged: () => void;
  defaultExpanded?: boolean;
}

export function CartonCard({ carton, customerId, addableItems, onChanged, defaultExpanded = false }: CartonCardProps) {
  const router = useRouter();
  const { success, error } = useToast();
  const [expanded, setExpanded] = useState(defaultExpanded);

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ length: "", width: "", height: "", weight: "", dimensionUnit: "cm" as "cm" | "inches" });
  const [savingEdit, setSavingEdit] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addSelected, setAddSelected] = useState<string[]>([]);
  const [savingAdd, setSavingAdd] = useState(false);

  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [dissolving, setDissolving] = useState(false);

  const first = carton.items[0];
  const totalPrice = carton.items.reduce((s, i) => s + (i.pkgEstShipping ?? 0), 0);

  const openEdit = () => {
    setEditForm({
      length: first?.cartonLength != null ? String(first.cartonLength) : "",
      width: first?.cartonWidth != null ? String(first.cartonWidth) : "",
      height: first?.cartonHeight != null ? String(first.cartonHeight) : "",
      weight: first?.cartonWeight != null ? String(first.cartonWeight) : "",
      dimensionUnit: first?.dimensionUnit ?? "cm",
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      await axios.patch(`/api/cartons/${carton.cartonNumber}`, {
        length: parseFloat(editForm.length) || undefined,
        width: parseFloat(editForm.width) || undefined,
        height: parseFloat(editForm.height) || undefined,
        weight: editForm.weight ? parseFloat(editForm.weight) || undefined : undefined,
        dimensionUnit: editForm.dimensionUnit,
      });
      success("Carton updated");
      setEditOpen(false);
      onChanged();
    } catch {
      error("Failed to update carton");
    } finally {
      setSavingEdit(false);
    }
  };

  const removeItem = async (itemId: string) => {
    setBusyItemId(itemId);
    try {
      await axios.patch(`/api/cartons/${carton.cartonNumber}`, { removeItemIds: [itemId] });
      success("Item removed from carton");
      onChanged();
    } catch {
      error("Failed to remove item from carton");
    } finally {
      setBusyItemId(null);
    }
  };

  const dissolve = async () => {
    setDissolving(true);
    try {
      await axios.delete(`/api/cartons/${carton.cartonNumber}`);
      success("Carton dissolved");
      onChanged();
    } catch {
      error("Failed to dissolve carton");
    } finally {
      setDissolving(false);
    }
  };

  const toggleAddSelected = (id: string) => {
    setAddSelected((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const submitAdd = async () => {
    if (addSelected.length === 0) return;
    setSavingAdd(true);
    try {
      await axios.patch(`/api/cartons/${carton.cartonNumber}`, { addItemIds: addSelected });
      success(`${addSelected.length} item(s) added to carton`);
      setAddOpen(false);
      setAddSelected([]);
      onChanged();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error ?? "Failed to add items" : "Failed to add items";
      error("Error", msg);
    } finally {
      setSavingAdd(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <button onClick={() => setExpanded((e) => !e)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          {expanded ? <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" /> : <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />}
          <Boxes className="h-4 w-4 text-brand-600 shrink-0" />
          <span className="font-semibold text-gray-900 text-sm">{carton.cartonNumber}</span>
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full shrink-0">
            {carton.items.length} item{carton.items.length !== 1 ? "s" : ""}
          </span>
          {carton.cbm > 0 && <span className="text-xs font-medium text-brand-600 shrink-0">{carton.cbm.toFixed(4)} m³</span>}
          {totalPrice > 0 && <span className="text-xs font-semibold text-brand-700 shrink-0">$ {totalPrice.toFixed(2)}</span>}
        </button>
        <Button
          size="sm"
          onClick={() => router.push(`/admin/orders/new?customerId=${customerId}&cartonNumber=${carton.cartonNumber}`)}
          className="shrink-0"
        >
          <ShoppingCart className="h-3.5 w-3.5 mr-1.5" />
          Create Invoice
        </Button>
      </div>

      {expanded && (
        <div className="border-t border-gray-100">
          <div className="flex items-center gap-4 px-4 py-2 bg-gray-50">
            <button onClick={openEdit} className="text-xs text-brand-600 hover:underline font-medium">
              Edit dimensions
            </button>
            {addableItems.length > 0 && (
              <button onClick={() => setAddOpen(true)} className="text-xs text-brand-600 hover:underline font-medium flex items-center gap-1">
                <Plus className="h-3 w-3" />
                Add items
              </button>
            )}
            <button
              onClick={dissolve}
              disabled={dissolving}
              className="ml-auto text-xs text-red-500 hover:text-red-700 flex items-center gap-1 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Dissolve
            </button>
          </div>
          <div className="divide-y divide-gray-50">
            {carton.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between px-4 py-2.5 gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-xs font-bold text-gray-700 mr-2">{item.itemRef}</span>
                  <span className="text-xs text-gray-500 truncate">{item.description}</span>
                </div>
                <button
                  onClick={() => removeItem(item.id)}
                  disabled={busyItemId === item.id}
                  title="Remove from carton"
                  className="text-gray-300 hover:text-red-500 shrink-0 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Edit dimensions */}
      <Dialog open={editOpen} onOpenChange={(o) => !o && setEditOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Carton {carton.cartonNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Select
              label="Unit"
              value={editForm.dimensionUnit}
              onChange={(e) => setEditForm({ ...editForm, dimensionUnit: e.target.value as "cm" | "inches" })}
              options={[{ value: "cm", label: "cm" }, { value: "inches", label: "inches" }]}
            />
            <div className="grid grid-cols-3 gap-2">
              <Input label="Length" type="number" min="0" step="0.01" value={editForm.length} onChange={(e) => setEditForm({ ...editForm, length: e.target.value })} />
              <Input label="Width" type="number" min="0" step="0.01" value={editForm.width} onChange={(e) => setEditForm({ ...editForm, width: e.target.value })} />
              <Input label="Height" type="number" min="0" step="0.01" value={editForm.height} onChange={(e) => setEditForm({ ...editForm, height: e.target.value })} />
            </div>
            <Input label="Carton Weight (kg, optional)" type="number" min="0" step="0.01" value={editForm.weight} onChange={(e) => setEditForm({ ...editForm, weight: e.target.value })} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={savingEdit}>Cancel</Button>
            <Button onClick={saveEdit} loading={savingEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add items */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && setAddOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Items to {carton.cartonNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-80 overflow-y-auto">
            {addableItems.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No eligible items to add</p>
            ) : (
              addableItems.map((item) => (
                <label
                  key={item.id}
                  className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer ${
                    addSelected.includes(item.id) ? "border-brand-200 bg-brand-50" : "border-gray-100 hover:bg-gray-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={addSelected.includes(item.id)}
                    onChange={() => toggleAddSelected(item.id)}
                    className="w-4 h-4 accent-brand-600 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{item.description || item.itemRef}</p>
                    <p className="text-xs text-gray-500">{item.itemRef} · {item.shippingType ?? "sea"} freight</p>
                  </div>
                </label>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={savingAdd}>Cancel</Button>
            <Button onClick={submitAdd} loading={savingAdd} disabled={addSelected.length === 0}>
              Add {addSelected.length || ""} item(s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
