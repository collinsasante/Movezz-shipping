"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Star, ExternalLink, Pencil, Check, X } from "lucide-react";
import type { Supplier } from "@/types";
import axios from "axios";

const CATEGORIES = [
  "Electronics", "Clothing", "Footwear", "Beauty", "Home & Garden",
  "Toys", "Sports", "Auto Parts", "Food & Supplements", "Other",
];
const PLATFORMS = ["1688", "Alibaba", "AliExpress", "Taobao", "DHgate", "Pinduoduo", "WeChat", "Other"];
const CONTACT_METHODS = ["WeChat", "WhatsApp", "Phone", "Email", "Other"];

function StarRating({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  const [hover, setHover] = useState(0);
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange?.(s === value ? 0 : s)}
          onMouseEnter={() => onChange && setHover(s)}
          onMouseLeave={() => onChange && setHover(0)}
          className={onChange ? "p-0.5 cursor-pointer" : "p-0.5 cursor-default"}
        >
          <Star
            className={`h-5 w-5 transition-colors ${
              s <= (hover || value) ? "fill-amber-400 text-amber-400" : "text-gray-200"
            }`}
          />
        </button>
      ))}
    </div>
  );
}

export default function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { error, success } = useToast();
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    category: "",
    platform: "",
    platformLink: "",
    contact: "",
    contactMethod: "",
    rating: 0,
    notes: "",
  });

  useEffect(() => {
    axios.get(`/api/suppliers/${id}`)
      .then((res) => {
        const s: Supplier = res.data.data;
        setSupplier(s);
        setForm({
          name: s.name,
          category: s.category ?? "",
          platform: s.platform ?? "",
          platformLink: s.platformLink ?? "",
          contact: s.contact ?? "",
          contactMethod: s.contactMethod ?? "",
          rating: s.rating ?? 0,
          notes: s.notes ?? "",
        });
      })
      .catch(() => error("Failed to load supplier"))
      .finally(() => setLoading(false));
  }, [id, error]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await axios.patch(`/api/suppliers/${id}`, {
        name: form.name,
        category: form.category || undefined,
        platform: form.platform || undefined,
        platformLink: form.platformLink || undefined,
        contact: form.contact || undefined,
        contactMethod: form.contactMethod || undefined,
        rating: form.rating || undefined,
        notes: form.notes || undefined,
      });
      setSupplier(res.data.data);
      setEditing(false);
      success("Supplier updated");
    } catch {
      error("Failed to update supplier");
    } finally {
      setSaving(false);
    }
  };

  const set = (key: string, val: string | number) => setForm((p) => ({ ...p, [key]: val }));

  if (loading) return (
    <div className="flex flex-col h-full">
      <Header title="Supplier" subtitle="" />
      <div className="flex-1 p-6 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" />
      </div>
    </div>
  );

  if (!supplier) return null;

  return (
    <div className="flex flex-col h-full">
      <Header
        title={supplier.name}
        subtitle={`${supplier.supplierId}${supplier.category ? ` · ${supplier.category}` : ""}`}
      />

      <div className="flex-1 p-6 max-w-2xl">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-4">
            <CardTitle>Supplier Details</CardTitle>
            {!editing ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                  {saving ? "Saving..." : "Save"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
              {editing ? (
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              ) : (
                <p className="text-sm font-semibold text-gray-900">{supplier.name}</p>
              )}
            </div>

            {/* Category + Platform */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
                {editing ? (
                  <select
                    value={form.category}
                    onChange={(e) => set("category", e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                  >
                    <option value="">Select category</option>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <p className="text-sm text-gray-700">{supplier.category ?? "—"}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Platform</label>
                {editing ? (
                  <select
                    value={form.platform}
                    onChange={(e) => set("platform", e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                  >
                    <option value="">Select platform</option>
                    {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <div className="flex items-center gap-1">
                    <p className="text-sm text-gray-700">{supplier.platform ?? "—"}</p>
                    {supplier.platformLink && !editing && (
                      <a href={supplier.platformLink} target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:text-brand-700">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Platform Link (edit mode only) */}
            {editing && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Platform Link</label>
                <input
                  type="url"
                  value={form.platformLink}
                  onChange={(e) => set("platformLink", e.target.value)}
                  placeholder="https://..."
                  className="w-full h-10 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            )}

            {/* Contact + Method */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Contact</label>
                {editing ? (
                  <input
                    type="text"
                    value={form.contact}
                    onChange={(e) => set("contact", e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                ) : (
                  <p className="text-sm text-gray-700">{supplier.contact ?? "—"}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Contact Method</label>
                {editing ? (
                  <select
                    value={form.contactMethod}
                    onChange={(e) => set("contactMethod", e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                  >
                    <option value="">Select method</option>
                    {CONTACT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <p className="text-sm text-gray-700">{supplier.contactMethod ?? "—"}</p>
                )}
              </div>
            </div>

            {/* Rating */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Rating</label>
              <StarRating value={editing ? form.rating : (supplier.rating ?? 0)} onChange={editing ? (v) => set("rating", v) : undefined} />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
              {editing ? (
                <textarea
                  value={form.notes}
                  onChange={(e) => set("notes", e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                />
              ) : (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{supplier.notes || "—"}</p>
              )}
            </div>

            {/* Meta */}
            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs text-gray-400">Added by {supplier.createdBy ?? "—"}</p>
            </div>
          </CardContent>
        </Card>

        <div className="mt-4">
          <Button variant="outline" onClick={() => router.push("/admin/suppliers")}>
            Back to Suppliers
          </Button>
        </div>
      </div>
    </div>
  );
}
