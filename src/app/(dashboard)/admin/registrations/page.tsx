"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Header } from "@/components/layout/Header";
import { useToast } from "@/components/ui/toast";
import { ClipboardCopy, Check, RefreshCw, UserPlus } from "lucide-react";
import axios from "axios";
import type { PendingRegistration } from "@/lib/airtable";

type Filter = "Pending" | "Created" | "All";

function CopyButton({ reg }: { reg: PendingRegistration }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = [
      `Name: ${reg.name}`,
      `Phone: ${reg.phone}`,
      reg.phone2 ? `Phone 2: ${reg.phone2}` : null,
      `Email: ${reg.email}`,
      reg.existingMark ? `Existing Mark: ${reg.existingMark}` : null,
      `Location: ${reg.location}`,
      reg.notes ? `Notes: ${reg.notes}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={copy}
      title="Copy to clipboard"
      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function CreateAccountButton({
  reg,
  onCreated,
}: {
  reg: PendingRegistration;
  onCreated: (id: string, shippingMark: string) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [shippingMark, setShippingMark] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const create = async () => {
    setState("loading");
    setErrMsg("");
    const payload = {
      name: reg.name,
      phone: reg.phone,
      email: reg.email,
      shippingAddress: reg.location || undefined,
      notes: reg.notes || undefined,
    };
    console.log("[CreateAccount] sending payload:", payload);
    try {
      const res = await axios.post("/api/customers", payload);
      console.log("[CreateAccount] response:", res.status, res.data);
      const mark = res.data.data?.customer?.shippingMark ?? "";
      setShippingMark(mark);
      setState("done");
      onCreated(reg.id, mark);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Failed to create account"
        : "Failed to create account";
      console.error("[CreateAccount] error:", msg, axios.isAxiosError(err) ? err.response?.data : err);
      setErrMsg(msg);
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-green-50 text-green-700 font-medium">
        <Check className="h-3.5 w-3.5" />
        {shippingMark || "Created"}
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-xs text-red-600">{errMsg}</span>
        <button onClick={create} className="text-xs text-red-600 underline hover:no-underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={create}
        disabled={state === "loading"}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-700 transition-colors disabled:opacity-50"
      >
        {state === "loading" ? (
          <div className="h-3.5 w-3.5 rounded-full border border-white border-t-transparent animate-spin" />
        ) : (
          <UserPlus className="h-3.5 w-3.5" />
        )}
        {state === "loading" ? "Creating..." : "Create Account"}
      </button>
      <span className="text-[10px] text-gray-400 text-right leading-tight">
        {reg.phone} · {reg.email}
      </span>
    </div>
  );
}

export default function RegistrationsPage() {
  const { success, error } = useToast();
  const [registrations, setRegistrations] = useState<PendingRegistration[]>([]);
  const [filter, setFilter] = useState<Filter>("Pending");
  const [loading, setLoading] = useState(true);

  const fetchRegistrations = useCallback(async () => {
    setLoading(true);
    try {
      const params = filter !== "All" ? { status: filter } : {};
      const res = await axios.get("/api/admin/registrations", { params });
      setRegistrations(res.data.data);
    } catch {
      error("Error", "Failed to load registrations");
    } finally {
      setLoading(false);
    }
  }, [filter, error]);

  useEffect(() => {
    fetchRegistrations();
  }, [fetchRegistrations]);

  const handleCreated = useCallback(async (id: string, shippingMark: string) => {
    console.log("[handleCreated] marking registration as created:", id, shippingMark);
    try {
      const patchRes = await axios.patch(`/api/admin/registrations/${id}`);
      console.log("[handleCreated] patch response:", patchRes.status, patchRes.data);
      success("Account created", shippingMark ? `Shipping mark: ${shippingMark}` : undefined);
      setRegistrations((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "Created" } : r))
      );
    } catch (err) {
      console.error("[handleCreated] patch failed:", axios.isAxiosError(err) ? err.response?.data : err);
    }
  }, [success]);

  const pending = registrations.filter((r) => r.status === "Pending").length;

  return (
    <div className="flex flex-col h-full">
      <Header
        title="Registrations"
        subtitle="Customer self-registration submissions"
      />

      <div className="flex-1 p-6 overflow-auto">
        {/* Filter tabs + actions row */}
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {(["Pending", "Created", "All"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  filter === f
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {f}
                {f === "Pending" && pending > 0 && (
                  <span className="ml-1.5 bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5">
                    {pending}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchRegistrations}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-2 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <a
              href="/onboard"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-2 transition-colors"
            >
              <UserPlus className="h-4 w-4" />
              Open Form
            </a>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-gray-200 border-t-gray-900 animate-spin" />
          </div>
        ) : registrations.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-3">
              <UserPlus className="h-6 w-6 text-gray-400" />
            </div>
            <p className="text-sm text-gray-500">No {filter !== "All" ? filter.toLowerCase() : ""} registrations yet.</p>
            <p className="text-xs text-gray-400 mt-1">Share the registration form link with your customers.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {registrations.map((reg) => (
              <div
                key={reg.id}
                className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-start gap-4"
              >
                {/* Status dot */}
                <div className="shrink-0 mt-1">
                  <span
                    className={`inline-flex h-2.5 w-2.5 rounded-full ${
                      reg.status === "Pending" ? "bg-amber-400" : "bg-green-500"
                    }`}
                  />
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900">{reg.name}</span>
                    {reg.existingMark && (
                      <code className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-mono">
                        {reg.existingMark}
                      </code>
                    )}
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        reg.status === "Pending"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {reg.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-gray-500">
                    <span>{reg.phone}</span>
                    {reg.phone2 && <span>{reg.phone2}</span>}
                    <span>{reg.email}</span>
                    <span>{reg.location}</span>
                  </div>
                  {reg.notes && (
                    <p className="text-xs text-gray-400 italic">{reg.notes}</p>
                  )}
                  <p className="text-xs text-gray-300">
                    {reg.submittedAt ? new Date(reg.submittedAt).toLocaleString() : ""}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <CopyButton reg={reg} />
                  {reg.status === "Pending" && (
                    <CreateAccountButton reg={reg} onCreated={handleCreated} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
