"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ArrowLeft, Container } from "lucide-react";
import axios from "axios";

export default function NewContainerPage() {
  const router = useRouter();
  const { success, error } = useToast();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",       // Shipping Line (optional)
    trackingNumber: "",  // Container Number (mandatory)
    eta: "",
    description: "",
    notes: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await axios.post("/api/containers", {
        name: form.name || undefined,
        trackingNumber: form.trackingNumber,
        eta: form.eta || undefined,
        description: form.description || undefined,
        notes: form.notes || undefined,
      });
      success(
        "Container created!",
        `ID: ${res.data.data.containerId}`
      );
      router.push(`/admin/containers/${res.data.data.id}`);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to create container"
        : "Failed to create container";
      error("Error", msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="New Container" subtitle="Create a new shipping container" />

      <div className="flex-1 p-6 max-w-xl">
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
              <CardTitle className="flex items-center gap-2">
                <Container className="h-5 w-5 text-brand-600" />
                Container Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label="Container Number"
                placeholder="e.g. MSCU1234567"
                value={form.trackingNumber}
                onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })}
                required
                hint="The actual container number (mandatory)"
              />
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Shipping Line (optional)"
                  placeholder="e.g. MSC, Maersk, CMA CGM"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                <Input
                  label="Estimated Arrival (ETA)"
                  type="date"
                  value={form.eta}
                  onChange={(e) => setForm({ ...form, eta: e.target.value })}
                />
              </div>
              <Textarea
                label="Description (optional)"
                placeholder="Additional details about this container..."
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
              <Textarea
                label="Notes (optional)"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </CardContent>
          </Card>

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800">
            <p className="font-semibold mb-1">Next Steps After Creation:</p>
            <ol className="list-decimal list-inside space-y-1 text-blue-700">
              <li>Go to the container detail page</li>
              <li>Add items to the container</li>
              <li>Update status to "Shipped to Ghana" when departing</li>
              <li>When arrived, update to "Arrived in Ghana" — all items update automatically</li>
            </ol>
          </div>

          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} className="flex-1">
              Create Container
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
