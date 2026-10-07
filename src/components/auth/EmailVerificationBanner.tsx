"use client";

// Non-blocking reminder to verify the account email. Never gates access.
import React, { useEffect, useState } from "react";
import axios from "axios";
import { MailWarning, X, Loader2, CheckCircle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { authErrorMessage } from "@/lib/auth-errors";

const DISMISS_KEY = "pakk_verify_banner_dismissed";

type SendState = "idle" | "sending" | "sent" | "error";

export function EmailVerificationBanner() {
  const { firebaseUser, emailVerified, reloadFirebaseUser } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [justVerified, setJustVerified] = useState(false);

  useEffect(() => {
    try { setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1"); } catch {}
  }, []);

  // Picks up a verification done in another tab or on another device
  useEffect(() => {
    if (emailVerified !== false) return;
    const onFocus = () => {
      reloadFirebaseUser().then((v) => { if (v) setJustVerified(true); });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [emailVerified, reloadFirebaseUser]);

  useEffect(() => {
    if (!justVerified) return;
    const t = setTimeout(() => setJustVerified(false), 5000);
    return () => clearTimeout(t);
  }, [justVerified]);

  if (justVerified) {
    return (
      <div role="status" className="shrink-0 bg-green-50 border-b border-green-100 px-4 py-2.5 flex items-center gap-2 text-sm text-green-800">
        <CheckCircle className="h-4 w-4 shrink-0" />
        Your email is verified. Thanks!
      </div>
    );
  }

  if (!firebaseUser || emailVerified !== false || dismissed) return null;

  const resend = async () => {
    setSendState("sending");
    setMessage("");
    try {
      const res = await axios.post("/api/auth/send-verification");
      if (res.data.data?.alreadyVerified) {
        await reloadFirebaseUser();
        setJustVerified(true);
        return;
      }
      setSendState("sent");
      setMessage(`Sent. Check ${firebaseUser.email} (and your spam folder).`);
    } catch (err) {
      setSendState("error");
      setMessage(authErrorMessage(err, "Couldn't send the email. Please try again later."));
    }
  };

  const checkNow = async () => {
    setChecking(true);
    const v = await reloadFirebaseUser();
    setChecking(false);
    if (v) setJustVerified(true);
    else setMessage("Not verified yet. Open the link in the email we sent you, then try again.");
  };

  const dismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch {}
  };

  return (
    <div role="region" aria-label="Email verification" className="shrink-0 bg-amber-50 border-b border-amber-100 px-4 py-2.5">
      <div className="flex items-start gap-3">
        <MailWarning className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 text-sm text-amber-900">
          <p>
            Please verify your email to secure your account. We sent a link to{" "}
            <span className="font-medium break-all">{firebaseUser.email}</span>.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            <button
              type="button"
              onClick={resend}
              disabled={sendState === "sending" || sendState === "sent"}
              className="font-semibold text-amber-800 hover:underline disabled:opacity-60 disabled:no-underline inline-flex items-center gap-1"
            >
              {sendState === "sending" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {sendState === "sent" ? "Email sent" : "Resend verification email"}
            </button>
            <button
              type="button"
              onClick={checkNow}
              disabled={checking}
              className="font-semibold text-amber-800 hover:underline disabled:opacity-60 inline-flex items-center gap-1"
            >
              {checking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              I&apos;ve verified
            </button>
          </div>
          {message && (
            <p className={`mt-1 text-xs ${sendState === "error" ? "text-red-700" : "text-amber-800"}`} aria-live="polite">
              {message}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="p-1 -m-1 text-amber-700 hover:text-amber-900"
          aria-label="Dismiss for now"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
