"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { auth } from "@/lib/firebase";
import {
  confirmPasswordReset,
  verifyPasswordResetCode,
  applyActionCode,
} from "firebase/auth";
import Image from "next/image";
import Link from "next/link";
import { Eye, EyeOff, CheckCircle, XCircle, Loader2 } from "lucide-react";

function SuccessRedirect({ message }: { message: string }) {
  const router = useRouter();
  const [count, setCount] = useState(3);

  useEffect(() => {
    if (count <= 0) { router.replace("/login"); return; }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [count, router]);

  return (
    <div className="text-center py-4">
      <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <CheckCircle className="h-7 w-7 text-green-600" />
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">Done!</h2>
      <p className="text-sm text-gray-500 mb-6">{message}</p>
      <p className="text-sm text-gray-400 mb-4">Redirecting to sign in in {count}…</p>
      <Link
        href="/login"
        className="inline-flex items-center justify-center h-11 px-8 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors"
      >
        Sign In now
      </Link>
    </div>
  );
}

// ── Reset Password view ──────────────────────────────────────────────────────

function ResetPasswordView({ oobCode }: { oobCode: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    verifyPasswordResetCode(auth, oobCode)
      .then((em) => {
        setEmail(em);
        setVerifying(false);
      })
      .catch(() => {
        setError("This password reset link is invalid or has expired. Please request a new one.");
        setVerifying(false);
      });
  }, [oobCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await confirmPasswordReset(auth, oobCode, password);
      setDone(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes("expired") ? "This link has expired. Please request a new password reset." : "Failed to reset password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (verifying) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        <p className="text-sm text-gray-500">Verifying reset link…</p>
      </div>
    );
  }

  if (done) {
    return <SuccessRedirect message="Your password has been changed successfully." />;
  }

  if (error && !email) {
    return (
      <div className="text-center py-4">
        <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <XCircle className="h-7 w-7 text-red-500" />
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Link expired</h2>
        <p className="text-sm text-gray-500 mb-6">{error}</p>
        <Link
          href="/reset-password"
          className="inline-flex items-center justify-center h-11 px-8 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors"
        >
          Request new link
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">Set new password</h2>
        <p className="text-sm text-gray-400">
          Creating password for <span className="font-medium text-gray-600">{email}</span>
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">New Password</label>
          <div className="relative">
            <input
              type={showPass ? "text" : "password"}
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              className="w-full h-11 px-4 pr-11 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              onClick={() => setShowPass(!showPass)}
            >
              {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm Password</label>
          <div className="relative">
            <input
              type={showConfirm ? "text" : "password"}
              placeholder="Repeat your password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              className="w-full h-11 px-4 pr-11 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              onClick={() => setShowConfirm(!showConfirm)}
            >
              {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Updating…" : "Set Password"}
        </button>
      </form>
    </>
  );
}

// ── Verify Email view ────────────────────────────────────────────────────────

function VerifyEmailView({ oobCode }: { oobCode: string }) {
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");

  useEffect(() => {
    applyActionCode(auth, oobCode)
      .then(() => setStatus("done"))
      .catch(() => setStatus("error"));
  }, [oobCode]);

  if (status === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        <p className="text-sm text-gray-500">Verifying your email…</p>
      </div>
    );
  }

  if (status === "done") {
    return <SuccessRedirect message="Your email address has been verified. You can now sign in." />;
  }

  return (
    <div className="text-center py-4">
      <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <XCircle className="h-7 w-7 text-red-500" />
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">Verification failed</h2>
      <p className="text-sm text-gray-500 mb-6">This verification link is invalid or has already been used.</p>
      <Link
        href="/login"
        className="inline-flex items-center justify-center h-11 px-8 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors"
      >
        Back to Sign In
      </Link>
    </div>
  );
}

// ── Main action handler ──────────────────────────────────────────────────────

function ActionContent() {
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode");
  const oobCode = searchParams.get("oobCode") ?? "";

  const renderBody = () => {
    if (!oobCode) {
      return (
        <div className="text-center py-4">
          <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <XCircle className="h-7 w-7 text-red-500" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Invalid link</h2>
          <p className="text-sm text-gray-500 mb-6">This link is missing required parameters.</p>
          <Link href="/login" className="text-sm text-gray-900 font-medium hover:underline">Back to Sign In</Link>
        </div>
      );
    }
    if (mode === "resetPassword") return <ResetPasswordView oobCode={oobCode} />;
    if (mode === "verifyEmail") return <VerifyEmailView oobCode={oobCode} />;
    return (
      <div className="text-center py-4">
        <p className="text-sm text-gray-500">Unknown action type.</p>
        <Link href="/login" className="text-sm text-gray-900 font-medium hover:underline mt-4 block">Back to Sign In</Link>
      </div>
    );
  };

  return (
    <div className="h-screen w-screen flex bg-white overflow-hidden">
      {/* Left panel */}
      <div
        className="hidden lg:flex lg:w-[48%] flex-col justify-between p-10 relative overflow-hidden"
        style={{
          background:
            "radial-gradient(ellipse 130% 90% at 90% 10%, rgba(30,100,255,0.55) 0%, transparent 55%)," +
            "radial-gradient(ellipse 100% 110% at 10% 90%, rgba(220,0,130,0.6) 0%, transparent 55%)," +
            "radial-gradient(ellipse 70% 70% at 55% 45%, rgba(140,0,220,0.45) 0%, transparent 55%)," +
            "radial-gradient(ellipse 60% 60% at 80% 70%, rgba(0,180,255,0.3) 0%, transparent 55%)," +
            "linear-gradient(145deg, #040010 0%, #0a0022 60%, #12002e 100%)",
        }}
      >
        <div className="relative z-10 flex items-center gap-3">
          <div className="h-px w-8 bg-white/25" />
          <span className="text-xs font-semibold tracking-widest text-white/40 uppercase">Pakkmaxx</span>
        </div>
        <div className="relative z-10">
          <h1 className="text-4xl font-black text-white leading-[1.15] mb-4">
            Move Anything,<br />Anywhere<br />Reliably.
          </h1>
          <p className="text-sm text-white/50 leading-relaxed max-w-xs">
            Seamlessly shipping from China to Ghana. Track every package, every mile, every step of the way.
          </p>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-10 pt-8">
          <Image src="/logowithouttext.png" alt="Pakkmaxx" width={36} height={36} className="rounded-lg" />
          <span className="text-sm font-semibold text-gray-700 tracking-tight">Pakkmaxx</span>
        </div>

        {/* Content */}
        <div className="flex-1 flex items-center justify-center px-10">
          <div className="w-full max-w-sm">
            {renderBody()}
          </div>
        </div>

        <p className="text-center text-sm text-gray-400 pb-8">
          <Link href="/login" className="hover:text-gray-700 transition-colors">← Back to Sign In</Link>
        </p>
      </div>
    </div>
  );
}

export default function AuthActionPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen flex items-center justify-center bg-white">
          <Loader2 className="h-8 w-8 animate-spin text-gray-300" />
        </div>
      }
    >
      <ActionContent />
    </Suspense>
  );
}
