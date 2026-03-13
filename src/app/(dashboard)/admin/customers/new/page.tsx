"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { generateShippingMark } from "@/lib/utils";
import { PhoneInput } from "@/components/ui/PhoneInput";
import { ArrowLeft, Tag } from "lucide-react";
import axios from "axios";

const COMPANY_KEY = "pakk_company_settings";

export default function NewCustomerPage() {
  const router = useRouter();
  const { error } = useToast();
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [createdMark, setCreatedMark] = useState("");

  const [phoneCode, setPhoneCode] = useState("+1");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [defaultAddress, setDefaultAddress] = useState("Accra Ghana");
  const [form, setForm] = useState({
    name: "",
    email: "",
    notes: "",
    shippingAddress: "Accra Ghana",
  });

  useEffect(() => {
    try {
      const saved = localStorage.getItem(COMPANY_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.address) {
          setDefaultAddress(parsed.address);
          setForm((prev) => ({ ...prev, shippingAddress: parsed.address }));
        }
      }
    } catch {}
  }, []);

  const fullPhone = `${phoneCode}${phoneLocal}`;
  const preview = form.name && phoneLocal
    ? generateShippingMark(form.name, fullPhone)
    : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await axios.post("/api/customers", { ...form, phone: fullPhone, shippingAddress: form.shippingAddress || undefined });
      setEmailSent(res.data.data.emailSent ?? false);
      setCreatedMark(res.data.data.customer?.shippingMark ?? preview);
      setCreated(true);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to create customer"
        : "Failed to create customer";
      error("Error", msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="New Customer" subtitle="Create a new customer account" />

      <div className="flex-1 p-6 max-w-2xl">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Customers
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

              <PhoneInput
                label="WhatsApp Phone Number"
                code={phoneCode}
                local={phoneLocal}
                onCodeChange={setPhoneCode}
                onLocalChange={setPhoneLocal}
                required
              />

              <Input
                label="Email Address"
                type="email"
                placeholder="customer@example.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
              <Input
                label="Location"
                value={form.shippingAddress}
                onChange={(e) => setForm({ ...form, shippingAddress: e.target.value })}
                hint={`Default: ${defaultAddress}`}
              />
              <Textarea
                label="Notes (optional)"
                placeholder="Any special notes about this customer..."
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </CardContent>
          </Card>

          {/* Shipping Mark Preview */}
          {preview && (
            <Card className="border-brand-100 bg-brand-50">
              <CardContent className="pt-5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center">
                    <Tag className="h-5 w-5 text-brand-600" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-brand-600 mb-0.5">
                      Auto-generated Shipping Mark
                    </p>
                    <code className="text-lg font-black font-mono text-brand-900">
                      {preview}
                    </code>
                  </div>
                </div>
                <p className="text-xs text-brand-700 mt-3">
                  This shipping mark will be assigned to the customer and used
                  to label all their packages.
                </p>
              </CardContent>
            </Card>
          )}

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} className="flex-1">
              Create Customer Account
            </Button>
          </div>
        </form>
      </div>

      {/* Success modal */}
      {created && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-6 space-y-4">
            <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center mx-auto">
              <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            </div>
            <div className="text-center">
              <h3 className="font-bold text-gray-900 text-lg">Customer Created!</h3>
              <p className="text-sm text-gray-500 mt-1">
                Shipping mark: <code className="font-mono font-bold text-gray-800">{createdMark}</code>
              </p>
              {emailSent ? (
                <p className="text-sm text-green-600 mt-2">
                  A password setup email was sent to <span className="font-medium">{form.email}</span>.
                </p>
              ) : (
                <p className="text-sm text-amber-600 mt-2">
                  Email could not be sent. Ask the customer to use &quot;Forgot password&quot; on the login page.
                </p>
              )}
            </div>
            <button
              onClick={() => router.push("/admin/customers")}
              className="w-full py-2.5 bg-gray-900 text-white rounded-xl font-medium text-sm hover:bg-gray-700 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
