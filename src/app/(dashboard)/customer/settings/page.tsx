"use client";

import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/context/AuthContext";
import { User, Lock, Tag, MapPin, Warehouse } from "lucide-react";
import axios from "axios";
import type { Warehouse as WarehouseType } from "@/types";

export default function CustomerSettingsPage() {
  const { appUser } = useAuth();
  const { success, error } = useToast();
  const [activeTab, setActiveTab] = useState<"profile" | "security">("profile");

  const [form, setForm] = useState({
    name: appUser?.customerName ?? "",
    phone: "",
    email: appUser?.email ?? "",
    shippingAddress: appUser?.shippingAddress ?? "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [preferredWarehouse, setPreferredWarehouse] = useState<WarehouseType | null>(null);

  const [resetSent, setResetSent] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);

  // Load preferred warehouse from localStorage
  useEffect(() => {
    const savedId = localStorage.getItem("pakk_preferred_warehouse");
    if (!savedId) return;
    axios.get("/api/warehouses").then((res) => {
      const list: WarehouseType[] = res.data.data;
      const match = list.find((w) => w.id === savedId);
      if (match) setPreferredWarehouse(match);
    }).catch(() => {});
  }, []);

  // Load fresh customer data to get phone + notes
  useEffect(() => {
    if (!appUser?.customerId) return;
    axios.get(`/api/customers/${appUser.customerId}`).then((res) => {
      const c = res.data.data;
      setForm((prev) => ({
        ...prev,
        name: c.name ?? prev.name,
        phone: c.phone ?? "",
        shippingAddress: c.shippingAddress ?? "",
        notes: c.notes ?? "",
      }));
    }).catch(() => {});
  }, [appUser?.customerId]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appUser?.customerId) return;
    setSaving(true);
    try {
      await axios.patch(`/api/customers/${appUser.customerId}`, {
        name: form.name || undefined,
        phone: form.phone || undefined,
        notes: form.notes || undefined,
        shippingAddress: form.shippingAddress || undefined,
      });
      success("Profile updated");
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to update profile"
        : "Failed to update profile";
      error("Error", msg);
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordReset = async () => {
    setSendingReset(true);
    try {
      const { sendPasswordResetEmail, getAuth } = await import("firebase/auth");
      const auth = getAuth();
      await sendPasswordResetEmail(auth, appUser?.email ?? "");
      setResetSent(true);
      success("Password reset email sent", `Check ${appUser?.email}`);
    } catch {
      error("Failed to send reset email");
    } finally {
      setSendingReset(false);
    }
  };

  const tabs = [
    { id: "profile" as const, label: "My Profile", icon: User },
    { id: "security" as const, label: "Security", icon: Lock },
  ];

  return (
    <div className="flex flex-col h-full">
      <Header title="Settings" subtitle="Manage your account preferences" />

      <div className="flex-1 p-6 overflow-y-auto">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "bg-white shadow-sm text-gray-900"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Profile Tab */}
        {activeTab === "profile" && (
          <div className="max-w-xl space-y-5">
            {appUser?.shippingMark && (
              <div className="bg-brand-50 border border-brand-100 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center shrink-0">
                    <Tag className="h-5 w-5 text-brand-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-brand-600 mb-0.5">Your Shipping Mark</p>
                    <code className="text-sm font-black font-mono text-brand-900 break-all">
                      {preferredWarehouse ? `${preferredWarehouse.name}, ${appUser.shippingMark}` : appUser.shippingMark}
                    </code>
                  </div>
                </div>
                {preferredWarehouse && (
                  <div className="flex items-start gap-2 text-xs text-brand-700 border-t border-brand-100 pt-2">
                    <Warehouse className="h-3.5 w-3.5 mt-0.5 shrink-0 text-brand-500" />
                    <span>{preferredWarehouse.address}{preferredWarehouse.phone ? ` · ${preferredWarehouse.phone}` : ""}</span>
                  </div>
                )}
                <p className="text-xs text-brand-600">
                  Write this on every package you send. Change your warehouse in <a href="/customer/items" className="underline">My Items</a>.
                </p>
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5 text-brand-600" />
                  Profile Information
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveProfile} className="space-y-4">
                  <Input
                    label="Full Name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Your full name"
                  />
                  <Input
                    label="Email"
                    type="email"
                    value={form.email}
                    disabled
                    hint="Email cannot be changed. Contact support if needed."
                  />
                  <Input
                    label="WhatsApp Phone"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+1 555 123 4567"
                    hint="Include country code"
                  />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      <span className="flex items-center gap-1.5"><MapPin className="h-4 w-4 text-gray-400" />Your Delivery Address</span>
                    </label>
                    <textarea
                      value={form.shippingAddress}
                      onChange={(e) => setForm({ ...form, shippingAddress: e.target.value })}
                      placeholder="Your Ghana delivery address (street, city, region)"
                      rows={3}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                    />
                    <p className="text-xs text-gray-400 mt-1">Where you want packages delivered in Ghana</p>
                  </div>
                  <Button type="submit" loading={saving} className="w-full">
                    Save Profile
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Security Tab */}
        {activeTab === "security" && (
          <div className="max-w-xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Lock className="h-5 w-5 text-brand-600" />
                  Password
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-gray-500">
                  We&apos;ll send a password reset link to <strong>{appUser?.email}</strong>.
                </p>
                {resetSent ? (
                  <div className="p-3 bg-green-50 border border-green-100 rounded-xl">
                    <p className="text-sm text-green-700 font-medium">Reset email sent! Check your inbox.</p>
                  </div>
                ) : (
                  <Button variant="outline" loading={sendingReset} onClick={handlePasswordReset}>
                    Send Password Reset Email
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Account Info</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Email</span>
                  <span className="text-gray-900 font-medium">{appUser?.email}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Account type</span>
                  <span className="text-gray-900 font-medium capitalize">Customer</span>
                </div>
                {appUser?.package && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Package</span>
                    <span className="text-gray-900 font-medium capitalize">{appUser.package}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
