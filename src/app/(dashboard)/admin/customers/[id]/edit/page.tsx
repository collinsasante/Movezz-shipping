"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ArrowLeft } from "lucide-react";
import axios from "axios";

export default function EditCustomerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { success, error } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    notes: "",
    status: "active" as "active" | "inactive",
    shippingType: "" as "air" | "sea" | "",
  });

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get(`/api/customers/${id}`);
        const c = res.data.data;
        setForm({
          name: c.name ?? "",
          phone: c.phone ?? "",
          email: c.email ?? "",
          notes: c.notes ?? "",
          status: c.status ?? "active",
          shippingType: c.shippingType ?? "",
        });
      } catch {
        error("Failed to load customer");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, error]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form, shippingType: form.shippingType || undefined };
      await axios.patch(`/api/customers/${id}`, payload);
      success("Customer updated");
      router.push(`/admin/customers/${id}`);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to update customer"
        : "Failed to update customer";
      error("Error", msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="Edit Customer" subtitle="Update customer details" />

      <div className="flex-1 p-6 max-w-2xl">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <form onSubmit={handleSubmit} className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Customer Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label="Full Name"
                placeholder="e.g. Collins Mensah"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="WhatsApp Phone Number"
                  placeholder="+1 555 123 4567"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  required
                  hint="Include country code (e.g. +86 for China)"
                />
                <Input
                  label="Email Address"
                  type="email"
                  placeholder="customer@example.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Select
                  label="Status"
                  value={form.status}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      status: e.target.value as "active" | "inactive",
                    })
                  }
                  options={[
                    { value: "active", label: "Active" },
                    { value: "inactive", label: "Inactive" },
                  ]}
                />
                <Select
                  label="Shipping Type"
                  value={form.shippingType}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      shippingType: e.target.value as "air" | "sea" | "",
                    })
                  }
                  options={[
                    { value: "", label: "Not set" },
                    { value: "air", label: "Air Freight" },
                    { value: "sea", label: "Sea Freight" },
                  ]}
                />
              </div>
              <Textarea
                label="Notes (optional)"
                placeholder="Any special notes about this customer..."
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </CardContent>
          </Card>

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saving} className="flex-1">
              Save Changes
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
