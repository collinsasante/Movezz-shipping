"use client";

export const dynamic = "force-dynamic";

import React, { useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import axios from "axios";
import { CheckCircle, Loader2, MailCheck } from "lucide-react";
import { COUNTRY_CODES } from "@/lib/countryCodes";
import { PasswordFields } from "@/components/auth/PasswordFields";
import { passwordPolicyError } from "@/lib/password-policy";
import { authErrorMessage } from "@/lib/auth-errors";
import { signInAndStartSession, dashboardPathFor } from "@/lib/client-session";

const inputClass =
  "w-full h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0";

type Phase = "idle" | "creating" | "signing-in";

interface Result {
  email: string;
  signedIn: boolean;
  dashboard: string;
  verificationEmailSent: boolean;
  alreadyRegistered: boolean;
}

function SignupSuccess({ result }: { result: Result }) {
  const router = useRouter();
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [resendMsg, setResendMsg] = useState("");

  const resendEmail = async () => {
    setResend("sending");
    setResendMsg("");
    try {
      const res = await axios.post("/api/auth/send-verification");
      setResend("sent");
      setResendMsg(res.data.data?.alreadyVerified ? "Your email is already verified." : "Verification email sent.");
    } catch (err) {
      setResend("error");
      setResendMsg(authErrorMessage(err, "Couldn't send the email. You can try again from your dashboard."));
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm text-center space-y-5">
        <div className="w-16 h-16 bg-green-50 rounded-2xl flex items-center justify-center mx-auto">
          <CheckCircle className="h-8 w-8 text-green-600" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-gray-900">
            {result.alreadyRegistered ? "Your account is ready" : "Account created successfully"}
          </h2>
          {result.signedIn ? (
            <p className="text-sm text-gray-500 mt-2 leading-relaxed">
              You&apos;re signed in.
              {result.verificationEmailSent && (
                <>
                  {" "}We&apos;ve sent a verification email to{" "}
                  <span className="font-medium text-gray-700 break-all">{result.email}</span>.
                </>
              )}
            </p>
          ) : (
            <p className="text-sm text-gray-500 mt-2 leading-relaxed">
              We couldn&apos;t sign you in automatically. Sign in with{" "}
              <span className="font-medium text-gray-700 break-all">{result.email}</span> and the password you just chose.
            </p>
          )}
        </div>

        {result.signedIn && !result.alreadyRegistered && (
          <div className="bg-blue-50 rounded-xl p-4 text-left space-y-2">
            <div className="flex items-start gap-2">
              <MailCheck className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
              <p className="text-sm text-gray-600">
                Please verify your email to keep your account secure. You can keep using the app in the meantime.
              </p>
            </div>
            <button
              type="button"
              onClick={resendEmail}
              disabled={resend === "sending" || resend === "sent"}
              className="text-sm font-semibold text-blue-700 hover:underline disabled:opacity-60 disabled:no-underline inline-flex items-center gap-1.5"
            >
              {resend === "sending" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {result.verificationEmailSent ? "Resend verification email" : "Send verification email"}
            </button>
            {resendMsg && (
              <p className={`text-xs ${resend === "error" ? "text-red-600" : "text-gray-500"}`} aria-live="polite">
                {resendMsg}
              </p>
            )}
          </div>
        )}

        {result.signedIn ? (
          <button
            type="button"
            onClick={() => router.replace(result.dashboard)}
            className="block w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors"
          >
            Continue to dashboard
          </button>
        ) : (
          <a
            href="/login"
            className="block w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors leading-[44px]"
          >
            Go to Sign In
          </a>
        )}
      </div>
    </div>
  );
}

export default function OnboardPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [phoneCode, setPhoneCode] = useState("+233");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [phone2Code, setPhone2Code] = useState("+233");
  const [phone2Local, setPhone2Local] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [form, setForm] = useState({
    name: "",
    email: "",
    location: "",
    notes: "",
  });
  // Blocks double-submits before React re-renders the disabled button
  const submitting = useRef(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    setError("");

    const policyErr = passwordPolicyError(password);
    if (policyErr) { setError(policyErr); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }

    submitting.current = true;
    setPhase("creating");
    const email = form.email.trim().toLowerCase();
    try {
      const res = await axios.post("/api/onboard", {
        ...form,
        email,
        password,
        phone: `${phoneCode}${phoneLocal}`,
        phone2: phone2Local ? `${phone2Code}${phone2Local}` : undefined,
      });
      const data = res.data.data as { verificationEmailSent: boolean; alreadyRegistered: boolean };

      // Account exists now — sign in through the normal session flow
      setPhase("signing-in");
      let signedIn = false;
      let dashboard = "/customer";
      try {
        const user = await signInAndStartSession(email, password);
        signedIn = true;
        dashboard = dashboardPathFor(user.role);
      } catch {
        // Account was created; the success screen sends them to /login instead
      }
      setPassword("");
      setConfirm("");
      setResult({ email, signedIn, dashboard, ...data });
    } catch (err: unknown) {
      setError(authErrorMessage(err));
    } finally {
      submitting.current = false;
      setPhase("idle");
    }
  };

  if (result) return <SignupSuccess result={result} />;

  const busy = phase !== "idle";

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
            <h1 className="text-3xl font-bold text-gray-900 mb-1.5">Create your account</h1>
            <p className="text-sm text-gray-400 leading-relaxed">
              Fill in your details and choose a password. You&apos;ll be signed in straight away
              and get your shipping mark.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Full Name */}
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1.5">Full Name <span className="text-red-500">*</span></label>
              <input
                id="name"
                type="text"
                placeholder="e.g. Collins Mensah"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                autoComplete="name"
                className={inputClass}
              />
            </div>

            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">Email Address <span className="text-red-500">*</span></label>
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                autoComplete="email"
                className={inputClass}
              />
            </div>

            {/* Password + confirm */}
            <PasswordFields
              password={password}
              confirm={confirm}
              onPasswordChange={setPassword}
              onConfirmChange={setConfirm}
            />

            {/* Phone 1 */}
            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1.5">WhatsApp Phone Number <span className="text-red-500">*</span></label>
              <div className="flex gap-2">
                <select
                  value={phoneCode}
                  onChange={(e) => setPhoneCode(e.target.value)}
                  aria-label="Country code"
                  className="h-11 px-3 rounded-lg bg-gray-100 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0 shrink-0"
                >
                  {COUNTRY_CODES.map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
                <input
                  id="phone"
                  type="tel"
                  placeholder="0244111651"
                  value={phoneLocal}
                  onChange={(e) => setPhoneLocal(e.target.value)}
                  required
                  autoComplete="tel-national"
                  className="flex-1 min-w-0 h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
                />
              </div>
            </div>

            {/* Phone 2 */}
            <div>
              <label htmlFor="phone2" className="block text-sm font-medium text-gray-700 mb-1.5">
                Alternative Phone Number
                <span className="ml-1.5 text-xs font-normal text-gray-400">(optional)</span>
              </label>
              <div className="flex gap-2">
                <select
                  value={phone2Code}
                  onChange={(e) => setPhone2Code(e.target.value)}
                  aria-label="Alternative phone country code"
                  className="h-11 px-3 rounded-lg bg-gray-100 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0 shrink-0"
                >
                  {COUNTRY_CODES.map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
                <input
                  id="phone2"
                  type="tel"
                  placeholder="0244111651"
                  value={phone2Local}
                  onChange={(e) => setPhone2Local(e.target.value)}
                  className="flex-1 min-w-0 h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
                />
              </div>
            </div>

            {/* Location */}
            <div>
              <label htmlFor="location" className="block text-sm font-medium text-gray-700 mb-1.5">Location <span className="text-red-500">*</span></label>
              <input
                id="location"
                type="text"
                placeholder="e.g. Accra, Ghana"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                required
                className={inputClass}
              />
            </div>

            {/* Notes */}
            <div>
              <label htmlFor="notes" className="block text-sm font-medium text-gray-700 mb-1.5">
                Notes
                <span className="ml-1.5 text-xs font-normal text-gray-400">(optional)</span>
              </label>
              <textarea
                id="notes"
                placeholder="Anything else we should know..."
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                className="w-full px-4 py-3 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0 resize-none"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-2.5">{error}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2 inline-flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {phase === "creating" ? "Creating your account…" : phase === "signing-in" ? "Signing you in…" : "Create account"}
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
