"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import axios from "axios";
import { auth } from "@/lib/firebase";
import {
  confirmPasswordReset,
  verifyPasswordResetCode,
  applyActionCode,
} from "firebase/auth";
import Image from "next/image";
import Link from "next/link";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import { PasswordFields } from "@/components/auth/PasswordFields";
import { passwordPolicyError } from "@/lib/password-policy";
import { authErrorMessage, firebaseErrorCode } from "@/lib/auth-errors";
import { signInAndStartSession, dashboardPathFor } from "@/lib/client-session";

type Intent = "activate" | "reset";

function SuccessRedirect({ message, to = "/login", cta = "Sign In now" }: { message: string; to?: string; cta?: string }) {
  const router = useRouter();
  const [count, setCount] = useState(3);

  useEffect(() => {
    if (count <= 0) { router.replace(to); return; }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [count, router, to]);

  return (
    <div className="text-center py-4">
      <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <CheckCircle className="h-7 w-7 text-green-600" />
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">Done!</h2>
      <p className="text-sm text-gray-500 mb-6">{message}</p>
      <p className="text-sm text-gray-400 mb-4">Redirecting in {count}…</p>
      <Link
        href={to}
        replace
        className="inline-flex items-center justify-center h-11 px-8 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors"
      >
        {cta}
      </Link>
    </div>
  );
}

// Shown for expired / used / invalid links. Requests a fresh link by email
// through the reset endpoint, which never reveals whether the email exists.
function RequestNewLink({ intent, reason }: { intent: Intent; reason: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("sending");
    setError("");
    try {
      await axios.post("/api/auth/reset-password", { email: email.trim() });
      setState("sent");
    } catch (err) {
      setState("error");
      setError(authErrorMessage(err));
    }
  };

  return (
    <div className="text-center py-4">
      <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <XCircle className="h-7 w-7 text-red-500" />
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">
        {intent === "activate" ? "Activation link can't be used" : "Reset link can't be used"}
      </h2>
      <p className="text-sm text-gray-500 mb-6">{reason}</p>

      {state === "sent" ? (
        <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3" role="status">
          If an account exists for that email, we&apos;ve sent a new link. It expires in 1 hour.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3 text-left">
          <label htmlFor="relink-email" className="block text-sm font-medium text-gray-700">
            Send a new link to
          </label>
          <input
            id="relink-email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={state === "sending"}
            className="w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            {state === "sending" ? "Sending…" : "Send new link"}
          </button>
        </form>
      )}
    </div>
  );
}

function linkReason(err: unknown): string {
  return firebaseErrorCode(err) === "auth/expired-action-code"
    ? "This link has expired. Links are valid for 1 hour."
    : "This link is invalid or has already been used.";
}

// ── Set password view (account activation + password reset) ────────────────

function SetPasswordView({ oobCode, intent }: { oobCode: string; intent: Intent }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [verifying, setVerifying] = useState(true);
  const [linkError, setLinkError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ to: string; signedIn: boolean } | null>(null);
  const [error, setError] = useState("");
  const submittingRef = useRef(false);

  useEffect(() => {
    verifyPasswordResetCode(auth, oobCode)
      .then((em) => setEmail(em))
      .catch((err) => setLinkError(linkReason(err)))
      .finally(() => setVerifying(false));
  }, [oobCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const policyErr = passwordPolicyError(password);
    if (policyErr) { setError(policyErr); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }

    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await confirmPasswordReset(auth, oobCode, password);
    } catch (err: unknown) {
      const code = firebaseErrorCode(err);
      if (code === "auth/expired-action-code" || code === "auth/invalid-action-code") {
        setLinkError(linkReason(err));
      } else {
        setError(authErrorMessage(err, "Couldn't set your password. Please try again."));
      }
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    // Password is set (the one-time code is now spent). Sign in through the
    // normal session flow; if that fails, fall back to the sign-in page.
    try {
      const user = await signInAndStartSession(email, password);
      setDone({ to: dashboardPathFor(user.role), signedIn: true });
    } catch {
      setDone({ to: "/login", signedIn: false });
    } finally {
      setSubmitting(false);
    }
  };

  if (verifying) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        <p className="text-sm text-gray-500">Checking your link…</p>
      </div>
    );
  }

  if (done) {
    const what = intent === "activate" ? "Your account is activated" : "Your password has been changed";
    return done.signedIn ? (
      <SuccessRedirect message={`${what} and you're signed in.`} to={done.to} cta="Continue to dashboard" />
    ) : (
      <SuccessRedirect message={`${what}. Sign in with your new password.`} />
    );
  }

  if (linkError) return <RequestNewLink intent={intent} reason={linkError} />;

  return (
    <>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">
          {intent === "activate" ? "Activate your account" : "Set new password"}
        </h2>
        <p className="text-sm text-gray-400">
          {intent === "activate" ? "Create a password for " : "Choose a new password for "}
          <span className="font-medium text-gray-600 break-all">{email}</span>
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <PasswordFields
          password={password}
          confirm={confirm}
          onPasswordChange={setPassword}
          onConfirmChange={setConfirm}
          autoFocus
        />

        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Saving…" : intent === "activate" ? "Activate account" : "Set password"}
        </button>
      </form>
    </>
  );
}

// ── Verify Email view ────────────────────────────────────────────────────────

function VerifyEmailView({ oobCode }: { oobCode: string }) {
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    applyActionCode(auth, oobCode)
      .then(async () => {
        // Same browser as the signed-in session: refresh so the app shows it right away.
        // Another device picks it up when that tab regains focus (see EmailVerificationBanner).
        await auth.authStateReady().catch(() => {});
        if (auth.currentUser) {
          await auth.currentUser.reload().catch(() => {});
          setSignedIn(true);
        }
        setStatus("done");
      })
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
    return signedIn ? (
      <SuccessRedirect message="Your email address has been verified." to="/" cta="Continue to dashboard" />
    ) : (
      <SuccessRedirect message="Your email address has been verified. You can close this page or sign in." />
    );
  }

  return (
    <div className="text-center py-4">
      <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <XCircle className="h-7 w-7 text-red-500" />
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">Verification link can&apos;t be used</h2>
      <p className="text-sm text-gray-500 mb-6">
        It may have expired or already been used. If your email isn&apos;t verified yet, sign in and use
        &ldquo;Resend verification email&rdquo; on your dashboard.
      </p>
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
  const intent: Intent = searchParams.get("intent") === "activate" ? "activate" : "reset";

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
    if (mode === "resetPassword") return <SetPasswordView oobCode={oobCode} intent={intent} />;
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
          <span className="text-xs font-semibold tracking-widest text-white/40 uppercase">De-MOVEZZ LOGISTICS</span>
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
          <Image src="/Logo.jpeg" alt="De-MOVEZZ LOGISTICS" width={36} height={36} className="rounded-lg" />
          <span className="text-sm font-semibold text-gray-700 tracking-tight">De-MOVEZZ LOGISTICS</span>
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
