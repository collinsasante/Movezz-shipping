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
import { Plus, ShieldCheck, Trash2, Copy, CheckCheck, User, X } from "lucide-react";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

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

  const [profileUser, setProfileUser] = useState<AppUser | null>(null);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileForm, setProfileForm] = useState({ salary: "", hiredDate: "", notes: "" });

  const openProfile = (u: AppUser) => {
    const stored = localStorage.getItem(`pakk_staff_profile_${u.id}`);
    const parsed = stored ? JSON.parse(stored) : {};
    setProfileForm({ salary: parsed.salary ?? "", hiredDate: parsed.hiredDate ?? "", notes: parsed.notes ?? "" });
    setProfileEditing(false);
    setProfileUser(u);
  };

  const saveProfile = () => {
    if (!profileUser) return;
    localStorage.setItem(`pakk_staff_profile_${profileUser.id}`, JSON.stringify(profileForm));
    setProfileEditing(false);
  };

  const [form, setForm] = useState({
    email: "",
    role: "warehouse_staff" as "super_admin" | "warehouse_staff",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/users");
      setUsers((res.data.data as AppUser[]).filter((u) => u.role !== "customer"));
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
          onRowClick={openProfile}
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
              placeholder="user@movezz.com"
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

      {/* Staff profile modal */}
      {profileUser && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center">
                  <User className="h-5 w-5 text-brand-600" />
                </div>
                <div>
                  <p className="font-semibold text-gray-900 text-sm">{profileUser.email}</p>
                  <RoleBadge role={profileUser.role} />
                </div>
              </div>
              <button onClick={() => setProfileUser(null)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Info rows */}
            <div className="px-6 py-4 space-y-0 border-b border-gray-100">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-gray-400 font-medium mb-0.5">Joined</p>
                  <p className="text-gray-800">{formatDate(profileUser.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium mb-0.5">Last Login</p>
                  <p className="text-gray-800">{profileUser.lastLogin ? formatDate(profileUser.lastLogin) : "Never"}</p>
                </div>
                {profileForm.hiredDate && !profileEditing && (
                  <div>
                    <p className="text-xs text-gray-400 font-medium mb-0.5">Hire Date</p>
                    <p className="text-gray-800">{formatDate(profileForm.hiredDate)}</p>
                  </div>
                )}
                {profileForm.salary && !profileEditing && (
                  <div>
                    <p className="text-xs text-gray-400 font-medium mb-0.5">Salary / Rate</p>
                    <p className="text-gray-800">{profileForm.salary}</p>
                  </div>
                )}
              </div>
              {profileForm.notes && !profileEditing && (
                <p className="text-xs text-gray-500 mt-3 pt-3 border-t border-gray-100">{profileForm.notes}</p>
              )}
            </div>

            {/* Edit fields (only shown in editing mode) */}
            {profileEditing && (
              <div className="px-6 py-4 space-y-3">
                <Input
                  label="Salary / Rate"
                  placeholder="e.g. $2,000/mo or $25/hr"
                  value={profileForm.salary}
                  onChange={(e) => setProfileForm({ ...profileForm, salary: e.target.value })}
                />
                <Input
                  label="Hire Date"
                  type="date"
                  value={profileForm.hiredDate}
                  onChange={(e) => setProfileForm({ ...profileForm, hiredDate: e.target.value })}
                />
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    placeholder="Any notes about this staff member..."
                    value={profileForm.notes}
                    onChange={(e) => setProfileForm({ ...profileForm, notes: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                  />
                </div>
              </div>
            )}

            <div className="px-6 pb-5 flex gap-2">
              <button onClick={() => setProfileUser(null)} className="flex-1 py-2 border border-gray-200 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Close
              </button>
              {profileEditing ? (
                <button onClick={saveProfile} className="flex-1 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 transition-colors">
                  Save
                </button>
              ) : (
                <button onClick={() => setProfileEditing(true)} className="flex-1 py-2 bg-gray-900 text-white rounded-xl text-sm font-medium hover:bg-gray-700 transition-colors">
                  Edit Profile
                </button>
              )}
            </div>
          </div>
        </div>
      )}

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
