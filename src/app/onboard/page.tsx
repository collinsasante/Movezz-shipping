"use client";

export const dynamic = "force-dynamic";

import React, { useState } from "react";
import Image from "next/image";
import axios from "axios";
import { COUNTRY_CODES } from "@/lib/countryCodes";

export default function OnboardPage() {
  const [step, setStep] = useState<"form" | "success">("form");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [phoneCode, setPhoneCode] = useState("+233");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [phone2Code, setPhone2Code] = useState("+233");
  const [phone2Local, setPhone2Local] = useState("");
  const [form, setForm] = useState({
    name: "",
    email: "",
    existingMark: "",
    location: "",
    notes: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await axios.post("/api/onboard", {
        ...form,
        phone: `${phoneCode}${phoneLocal}`,
        phone2: phone2Local ? `${phone2Code}${phone2Local}` : undefined,
      });
      setStep("success");
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Something went wrong"
        : "Something went wrong";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (step === "success") {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm text-center space-y-5">
          <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto">
            <svg className="h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Check Your Email</h2>
            <p className="text-sm text-gray-500 mt-2 leading-relaxed">
              Your account has been created. We&apos;ve sent a password setup link to{" "}
              <span className="font-medium text-gray-700">{form.email}</span>.
            </p>
          </div>
          <div className="bg-blue-50 rounded-xl p-4 text-left space-y-2">
            <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Next steps</p>
            <ul className="text-sm text-gray-600 space-y-1.5 mt-1">
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">1.</span>Open the email from De-MOVEZZ LOGISTICS</li>
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">2.</span>Click the password setup link</li>
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">3.</span>Set your password and log in</li>
            </ul>
          </div>
          <p className="text-xs text-gray-400">
            Didn&apos;t receive the email? Check your spam folder or{" "}
            <a href="/reset-password" className="text-gray-700 font-medium hover:underline">request a new link</a>.
          </p>
          <a
            href="/login"
            className="block w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors leading-[44px]"
          >
            Go to Login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Brand header */}
      <div className="flex items-center gap-2.5 px-6 pt-8 pb-4">
        <Image src="/Logo.jpeg" alt="De-MOVEZZ LOGISTICS" width={28} height={28} className="rounded" />
        <span className="text-sm font-semibold text-gray-700 tracking-tight">De-MOVEZZ LOGISTICS</span>
      </div>

      <div className="flex-1 flex items-start justify-center px-6 py-8">
        <div className="w-full max-w-md">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-1.5">Create Your Account</h1>
            <p className="text-sm text-gray-400 leading-relaxed">
              Fill in your details below. Once reviewed, your login will be set up
              and a password link will be sent to your email.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Full Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Full Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="e.g. Collins Mensah"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                className="w-full h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
              />
            </div>

            {/* Phone 1 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">WhatsApp Phone Number <span className="text-red-500">*</span></label>
              <div className="flex gap-2">
                <select
                  value={phoneCode}
                  onChange={(e) => setPhoneCode(e.target.value)}
                  className="h-11 px-3 rounded-lg bg-gray-100 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0 shrink-0"
                >
                  {COUNTRY_CODES.map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
                <input
                  type="tel"
                  placeholder="0244111651"
                  value={phoneLocal}
                  onChange={(e) => setPhoneLocal(e.target.value)}
                  required
                  className="flex-1 h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
                />
              </div>
            </div>

            {/* Phone 2 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Alternative Phone Number
                <span className="ml-1.5 text-xs font-normal text-gray-400">(optional)</span>
              </label>
              <div className="flex gap-2">
                <select
                  value={phone2Code}
                  onChange={(e) => setPhone2Code(e.target.value)}
                  className="h-11 px-3 rounded-lg bg-gray-100 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0 shrink-0"
                >
                  {COUNTRY_CODES.map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
                <input
                  type="tel"
                  placeholder="0244111651"
                  value={phone2Local}
                  onChange={(e) => setPhone2Local(e.target.value)}
                  className="flex-1 h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
                />
              </div>
            </div>

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Email Address <span className="text-red-500">*</span></label>
              <input
                type="email"
                placeholder="you@example.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                className="w-full h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
              />
            </div>

            {/* Existing Shipping Mark */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Existing Shipping Mark
                <span className="ml-1.5 text-xs font-normal text-gray-400">(if you have one)</span>
              </label>
              <input
                type="text"
                placeholder="e.g. MOVEZZ-CM1651"
                value={form.existingMark}
                onChange={(e) => setForm({ ...form, existingMark: e.target.value.toUpperCase() })}
                className="w-full h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0 font-mono"
              />
            </div>

            {/* Location */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Location <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="e.g. Accra, Ghana"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                required
                className="w-full h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Notes
                <span className="ml-1.5 text-xs font-normal text-gray-400">(optional)</span>
              </label>
              <textarea
                placeholder="Anything else we should know..."
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                className="w-full px-4 py-3 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0 resize-none"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-2.5">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
            >
              {loading ? "Submitting..." : "Submit Registration"}
            </button>
          </form>

          <p className="text-center text-xs text-gray-400 mt-8">
            Already have an account?{" "}
            <a href="/login" className="text-gray-700 font-medium hover:underline">Sign in</a>
          </p>
        </div>
      </div>
    </div>
  );
}
