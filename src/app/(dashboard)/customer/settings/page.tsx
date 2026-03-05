"use client";

import React, { useState } from "react";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/context/AuthContext";
import { User, Lock, Tag } from "lucide-react";
import axios from "axios";

export default function CustomerSettingsPage() {
  const { appUser } = useAuth();
  const { success, error } = useToast();
  const [activeTab, setActiveTab] = useState<"profile" | "security">("profile");

  const [form, setForm] = useState({
    name: appUser?.customerName ?? "",
    phone: "",
    email: appUser?.email ?? "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  const [resetSent, setResetSent] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appUser?.customerId) return;
    setSaving(true);
    try {
      await axios.patch(`/api/customers/${appUser.customerId}`, {
        name: form.name || undefined,
        phone: form.phone || undefined,
        notes: form.notes || undefined,
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
      // Use Firebase to send password reset to the customer's email
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
        {/* Tabs */}
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
            {/* Shipping Mark */}
            {appUser?.shippingMark && (
              <div className="bg-brand-50 border border-brand-100 rounded-xl p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center">
                    <Tag className="h-5 w-5 text-brand-600" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-brand-600 mb-0.5">Your Shipping Mark</p>
                    <code className="text-lg font-black font-mono text-brand-900">{appUser.shippingMark}</code>
                  </div>
                </div>
                <p className="text-xs text-brand-700 mt-2">
                  Use this mark to label all your packages sent to our warehouse.
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
                    <p className="text-sm text-green-700 font-medium">
                      Reset email sent! Check your inbox.
                    </p>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    loading={sendingReset}
                    onClick={handlePasswordReset}
                  >
                    Send Password Reset Email
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Account Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Email</span>
                  <span className="text-gray-900 font-medium">{appUser?.email}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Account type</span>
                  <span className="text-gray-900 font-medium capitalize">Customer</span>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
