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
import { ArrowLeft, Tag, Copy, CheckCheck } from "lucide-react";
import axios from "axios";

export default function NewCustomerPage() {
  const router = useRouter();
  const { success, error } = useToast();
  const [loading, setLoading] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);

  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    notes: "",
  });

  const preview = form.name && form.phone
    ? generateShippingMark(form.name, form.phone)
    : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await axios.post("/api/customers", form);
      setTempPassword(res.data.data.tempPassword);
      setEmailSent(res.data.data.emailSent ?? false);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to create customer"
        : "Failed to create customer";
      error("Error", msg);
    } finally {
      setLoading(false);
    }
  };

  const copyPassword = () => {
    if (tempPassword) {
      navigator.clipboard.writeText(tempPassword);
      setCopiedPass(true);
      setTimeout(() => setCopiedPass(false), 2000);
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
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
            >
              Cancel
            </Button>
            <Button type="submit" loading={loading} className="flex-1">
              Create Customer Account
            </Button>
          </div>
        </form>
      </div>

      {/* Temp password success modal */}
      {tempPassword && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-6 space-y-4">
            <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center mx-auto">
              <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            </div>
            <div className="text-center">
              <h3 className="font-bold text-gray-900 text-lg">Customer Created!</h3>
              {emailSent ? (
                <p className="text-sm text-gray-500 mt-1">
                  A password setup email has been sent to{" "}
                  <span className="font-medium text-gray-700">{form.email}</span>.
                  The customer will receive a link to set their own password.
                </p>
              ) : (
                <p className="text-sm text-gray-500 mt-1">
                  Email could not be sent. Share this temporary password with the customer manually.
                </p>
              )}
            </div>
            <div className="bg-gray-50 rounded-xl p-3 flex items-center justify-between gap-3">
              <div>
                {emailSent && (
                  <p className="text-xs text-gray-400 mb-1">Fallback password (if email fails)</p>
                )}
                <code className="font-mono text-base font-bold text-gray-900 tracking-wider">{tempPassword}</code>
              </div>
              <button onClick={copyPassword} className="text-gray-400 hover:text-brand-600 transition-colors shrink-0">
                {copiedPass ? <CheckCheck className="h-5 w-5 text-green-500" /> : <Copy className="h-5 w-5" />}
              </button>
            </div>
            <button
              onClick={() => router.push("/admin/customers")}
              className="w-full py-2.5 bg-brand-600 text-white rounded-xl font-medium text-sm hover:bg-brand-700 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
