"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { generateShippingMark } from "@/lib/utils";
import { ArrowLeft, Tag } from "lucide-react";
import axios from "axios";

const COUNTRY_CODES = [
  { code: "+1", label: "+1 (US/Canada)" },
  { code: "+44", label: "+44 (UK)" },
  { code: "+86", label: "+86 (China)" },
  { code: "+233", label: "+233 (Ghana)" },
  { code: "+234", label: "+234 (Nigeria)" },
  { code: "+254", label: "+254 (Kenya)" },
  { code: "+27", label: "+27 (S. Africa)" },
  { code: "+49", label: "+49 (Germany)" },
  { code: "+33", label: "+33 (France)" },
  { code: "+971", label: "+971 (UAE)" },
  { code: "+91", label: "+91 (India)" },
  { code: "+61", label: "+61 (Australia)" },
  { code: "+82", label: "+82 (South Korea)" },
  { code: "+81", label: "+81 (Japan)" },
];

export default function NewCustomerPage() {
  const router = useRouter();
  const { error } = useToast();
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [createdMark, setCreatedMark] = useState("");

  const [phoneCode, setPhoneCode] = useState("+1");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [form, setForm] = useState({
    name: "",
    email: "",
    notes: "",
  });

  const fullPhone = `${phoneCode}${phoneLocal}`;
  const preview = form.name && phoneLocal
    ? generateShippingMark(form.name, fullPhone)
    : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await axios.post("/api/customers", { ...form, phone: fullPhone });
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

              {/* Phone with country code */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  WhatsApp Phone Number
                </label>
                <div className="flex gap-2">
                  <select
                    value={phoneCode}
                    onChange={(e) => setPhoneCode(e.target.value)}
                    className="h-10 rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-brand-500 shrink-0"
                  >
                    {COUNTRY_CODES.map((cc) => (
                      <option key={cc.code} value={cc.code}>{cc.label}</option>
                    ))}
                  </select>
                  <input
                    type="tel"
                    placeholder="555 123 4567"
                    value={phoneLocal}
                    onChange={(e) => setPhoneLocal(e.target.value)}
                    required
                    className="flex-1 h-10 px-3 rounded-lg border border-gray-200 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <p className="mt-1 text-xs text-gray-400">Select your country code then enter the number</p>
              </div>

              <Input
                label="Email Address"
                type="email"
                placeholder="customer@example.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
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
