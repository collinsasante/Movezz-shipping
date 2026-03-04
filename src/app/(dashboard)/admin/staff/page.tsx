"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
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
import { formatDate } from "@/lib/utils";
import type { AppUser, UserRole } from "@/types";
import { Plus, ShieldCheck, Trash2, Copy, CheckCheck, DollarSign, Save } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

const RATES_LS_KEY = "pakk_exchange_rates";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  warehouse_staff: "Agent",
  customer: "Customer",
};

function RoleBadge({ role }: { role: string }) {
  const colors =
    role === "super_admin"
      ? "bg-brand-100 text-brand-700"
      : role === "customer"
      ? "bg-green-100 text-green-700"
      : "bg-amber-100 text-amber-700";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${colors}`}
    >
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

export default function StaffPage() {
  const { success, error } = useToast();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [createdEmail, setCreatedEmail] = useState<string>("");
  const [emailSent, setEmailSent] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);

  const [form, setForm] = useState({
    email: "",
    role: "warehouse_staff" as "super_admin" | "warehouse_staff",
  });

  const [rates, setRates] = useState({ usdToGhs: "", shippingRatePerCbm: "" });
  const [ratesSaved, setRatesSaved] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(RATES_LS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setRates({
          usdToGhs: parsed.usdToGhs?.toString() ?? "",
          shippingRatePerCbm: parsed.shippingRatePerCbm?.toString() ?? "",
        });
      }
    } catch {}
  }, []);

  const saveRates = () => {
    const usdToGhs = parseFloat(rates.usdToGhs);
    const shippingRatePerCbm = parseFloat(rates.shippingRatePerCbm);
    if (isNaN(usdToGhs) || isNaN(shippingRatePerCbm)) {
      error("Invalid rates", "Please enter valid numbers");
      return;
    }
    localStorage.setItem(RATES_LS_KEY, JSON.stringify({ usdToGhs, shippingRatePerCbm }));
    setRatesSaved(true);
    success("Rates saved", "Exchange rates updated successfully");
    setTimeout(() => setRatesSaved(false), 2000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/users");
      setUsers(res.data.data);
    } catch {
      error("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [error]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (u: AppUser) => {
    setDeletingId(u.id);
    try {
      await axios.delete(`/api/users/${u.id}`, {
        data: { firebaseUid: u.firebaseUid },
      });
      success("Account deleted", u.email);
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
    } catch {
      error("Failed to delete account");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const openDialog = () => {
    setForm({ email: "", role: "warehouse_staff" });
    setDialogOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await axios.post("/api/users", form);
      setDialogOpen(false);
      setCreatedPassword(res.data.data?.tempPassword ?? null);
      setCreatedEmail(form.email);
      setEmailSent(res.data.data?.emailSent ?? false);
      load();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to create user"
        : "Failed to create user";
      error("Error", msg);
    } finally {
      setSaving(false);
    }
  };

  const copyPassword = () => {
    if (createdPassword) {
      navigator.clipboard.writeText(createdPassword);
      setCopiedPass(true);
      setTimeout(() => setCopiedPass(false), 2000);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Header
        title="User Management"
        subtitle="Manage all accounts: admins, staff, and customers"
      />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {/* Billing Details */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center">
              <DollarSign className="h-4 w-4 text-green-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Billing Details</h2>
              <p className="text-xs text-gray-500">Used for automatic CBM cost calculations</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <Input
              label="USD → GHS Rate"
              type="number"
              step="0.01"
              placeholder="e.g. 15.50"
              value={rates.usdToGhs}
              onChange={(e) => setRates({ ...rates, usdToGhs: e.target.value })}
              hint="How many GHS per 1 USD"
            />
            <Input
              label="Shipping Rate (USD per CBM)"
              type="number"
              step="0.01"
              placeholder="e.g. 200"
              value={rates.shippingRatePerCbm}
              onChange={(e) => setRates({ ...rates, shippingRatePerCbm: e.target.value })}
              hint="Cost in USD for 1 cubic metre"
            />
          </div>
          <Button size="sm" onClick={saveRates}>
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {ratesSaved ? "Saved!" : "Save Rates"}
          </Button>
        </div>

        {/* Staff list */}
        <div className="flex items-center justify-end">
          <Button onClick={openDialog}>
            <Plus className="h-4 w-4 mr-2" />
            Invite User
          </Button>
        </div>

        <DataTable
          columns={[
            {
              key: "email",
              header: "Email",
              render: (u) => (
                <span className="text-sm font-medium text-gray-900">
                  {u.email}
                </span>
              ),
            },
            {
              key: "role",
              header: "Role",
              render: (u) => <RoleBadge role={u.role} />,
            },
            {
              key: "customerName",
              header: "Customer",
              render: (u) => (
                <span className="text-sm text-gray-500">
                  {u.customerName ?? "—"}
                </span>
              ),
            },
            {
              key: "createdAt",
              header: "Created",
              render: (u) => (
                <span className="text-xs text-gray-500">
                  {formatDate(u.createdAt)}
                </span>
              ),
            },
            {
              key: "lastLogin",
              header: "Last Login",
              render: (u) => (
                <span className="text-xs text-gray-500">
                  {u.lastLogin ? formatDate(u.lastLogin) : "Never"}
                </span>
              ),
            },
            {
              key: "actions",
              header: "",
              render: (u) => (
                <div
                  className="flex items-center gap-1 justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {confirmDeleteId === u.id ? (
                    <>
                      <span className="text-xs text-red-600 mr-1">Delete?</span>
                      <button
                        onClick={() => handleDelete(u)}
                        disabled={deletingId === u.id}
                        className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                      >
                        {deletingId === u.id ? "..." : "Yes"}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                      >
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(u.id)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      title="Delete account"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ),
            },
          ]}
          data={users}
          keyExtractor={(u) => u.id}
          loading={loading}
          emptyMessage="No users found"
          emptyIcon={<ShieldCheck className="h-12 w-12" />}
        />
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite User</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <Input
              label="Email Address"
              type="email"
              placeholder="user@pakkmaxx.com"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              autoComplete="off"
            />

            <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
              A temporary password will be auto-generated and shown after creation.
            </p>

            <Select
              label="Role"
              value={form.role}
              onChange={(e) =>
                setForm({
                  ...form,
                  role: e.target.value as "super_admin" | "warehouse_staff",
                })
              }
              required
              options={[
                { value: "warehouse_staff", label: "Agent" },
                { value: "super_admin", label: "Super Admin" },
              ]}
            />

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Invite User
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Temp password modal */}
      {createdPassword && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-6 space-y-4">
            <div className="text-center">
              <h3 className="font-bold text-gray-900 text-lg">User Created!</h3>
              {emailSent ? (
                <p className="text-sm text-gray-500 mt-1">
                  A password setup email has been sent to{" "}
                  <span className="font-medium text-gray-700">{createdEmail}</span>.
                  They will receive a link to set their own password.
                </p>
              ) : (
                <p className="text-sm text-gray-500 mt-1">
                  Email could not be sent. Share this temporary password with the user manually.
                </p>
              )}
            </div>
            <div className="bg-gray-50 rounded-xl p-3 flex items-center justify-between gap-3">
              <div>
                {emailSent && (
                  <p className="text-xs text-gray-400 mb-1">Fallback password (if email fails)</p>
                )}
                <code className="font-mono text-base font-bold text-gray-900 tracking-wider">{createdPassword}</code>
              </div>
              <button onClick={copyPassword} className="text-gray-400 hover:text-brand-600 transition-colors shrink-0">
                {copiedPass ? <CheckCheck className="h-5 w-5 text-green-500" /> : <Copy className="h-5 w-5" />}
              </button>
            </div>
            <button
              onClick={() => setCreatedPassword(null)}
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
