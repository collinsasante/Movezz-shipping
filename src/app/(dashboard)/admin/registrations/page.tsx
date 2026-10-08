"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { useToast } from "@/components/ui/toast";
import { RefreshCw, UserPlus, Check, X } from "lucide-react";
import axios from "axios";

// Registration requests (Phase 7G): a customer asks to register, a super_admin approves or rejects, and the approved
// customer then activates their own login. Requests are historical records: they are never deleted.
interface Registration {
  id: string; name: string; email: string; phone: string | null; phone2: string | null; existing_mark: string | null;
  location: string | null; notes: string | null; status: "pending" | "approved" | "rejected" | "activated" | "cancelled";
  rejection_reason: string | null; created_at: string;
}
type Filter = "pending" | "approved" | "rejected" | "activated" | "all";
const FILTERS: Filter[] = ["pending", "approved", "activated", "rejected", "all"];
const BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700", approved: "bg-blue-100 text-blue-700", activated: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700", cancelled: "bg-gray-100 text-gray-600",
};

export default function RegistrationsPage() {
  const { success, error } = useToast();
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchRegistrations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/admin/registrations", { params: filter !== "all" ? { status: filter } : {} });
      setRegistrations(res.data.data);
    } catch {
      error("Error", "Failed to load registrations");
    } finally {
      setLoading(false);
    }
  }, [filter, error]);

  useEffect(() => { fetchRegistrations(); }, [fetchRegistrations]);

  const act = async (id: string, body: { action: "approve" } | { action: "reject"; reason: string }) => {
    setBusy(id);
    try {
      await axios.patch(`/api/admin/registrations/${id}`, body);
      success(body.action === "approve" ? "Approved" : "Rejected", body.action === "approve" ? "The customer can now activate their login." : "The request was kept for the record.");
      await fetchRegistrations();
    } catch (e) {
      error("Error", axios.isAxiosError(e) && e.response?.data?.error ? String(e.response.data.error) : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const reject = (id: string) => {
    const reason = window.prompt("Reason for rejecting this request (required):");
    if (reason && reason.trim()) act(id, { action: "reject", reason: reason.trim() });
  };

  return (
    <div className="flex flex-col h-full">
      <Header title="Registrations" subtitle="Requests from the onboarding form, waiting for approval" />
      <div className="flex-1 p-6 overflow-auto">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {FILTERS.map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${filter === f ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                {f}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchRegistrations} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-2 transition-colors">
              <RefreshCw className="h-4 w-4" />Refresh
            </button>
            <a href="/onboard" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-2 transition-colors">
              <UserPlus className="h-4 w-4" />Open Form
            </a>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20"><div className="w-8 h-8 rounded-full border-2 border-gray-200 border-t-gray-900 animate-spin" /></div>
        ) : registrations.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-3"><UserPlus className="h-6 w-6 text-gray-400" /></div>
            <p className="text-sm text-gray-500">No {filter !== "all" ? filter : ""} registrations.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {registrations.map((reg) => (
              <div key={reg.id} className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-start gap-4">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900">{reg.name}</span>
                    {reg.existing_mark && <code className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-mono">{reg.existing_mark}</code>}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${BADGE[reg.status] ?? BADGE.cancelled}`}>{reg.status}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-gray-500">
                    <span>{reg.phone}</span>{reg.phone2 && <span>{reg.phone2}</span>}<span>{reg.email}</span><span>{reg.location}</span>
                  </div>
                  {reg.notes && <p className="text-xs text-gray-400 italic">{reg.notes}</p>}
                  {reg.rejection_reason && <p className="text-xs text-red-500">Rejected: {reg.rejection_reason}</p>}
                  <p className="text-xs text-gray-300">{reg.created_at ? new Date(reg.created_at).toLocaleString() : ""}</p>
                </div>
                {reg.status === "pending" && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button disabled={busy === reg.id} onClick={() => act(reg.id, { action: "approve" })}
                      className="flex items-center gap-1.5 text-sm font-medium text-white bg-gray-900 hover:bg-gray-700 px-3 py-2 rounded-lg transition-colors disabled:opacity-50">
                      <Check className="h-4 w-4" />Approve
                    </button>
                    <button disabled={busy === reg.id} onClick={() => reject(reg.id)}
                      className="flex items-center gap-1.5 text-sm text-gray-700 border border-gray-200 hover:bg-gray-50 px-3 py-2 rounded-lg transition-colors disabled:opacity-50">
                      <X className="h-4 w-4" />Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
