"use client";

export const dynamic = "force-dynamic";

import React, { useState } from "react";
import axios from "axios";
import { signInWithGoogle, signIn, createFirebaseUser, sendVerificationEmail, getIdToken, signOut } from "@/lib/firebase";

// Activation of an APPROVED registration (Phase 7G). The applicant creates their OWN Firebase login (their own password, or Google),
// verifies their e-mail, and the server activates the account from the verified token. No password ever reaches our servers.
export default function ActivatePage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "create">("create");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const activateWith = async (user: Awaited<ReturnType<typeof signIn>>) => {
    await user.reload();
    if (!user.emailVerified) {
      await sendVerificationEmail(user).catch(() => {});
      setMessage("We sent a verification link to your e-mail. Open it, then come back here and press Activate again.");
      return;
    }
    const token = await getIdToken(user);
    try {
      await axios.post("/api/auth/activate", {}, { headers: { Authorization: `Bearer ${token}` } });
      window.location.href = "/login";
    } catch (e) {
      const status = axios.isAxiosError(e) ? e.response?.status : 0;
      setError(status === 404 ? "No approved registration was found for this e-mail. Please wait for approval, or contact support."
        : status === 409 ? "Your registration needs attention from our team. Please contact support." : "Activation failed. Please try again.");
      await signOut().catch(() => {});
    }
  };

  const run = async (fn: () => Promise<Awaited<ReturnType<typeof signIn>>>) => {
    setBusy(true); setError(""); setMessage("");
    try { await activateWith(await fn()); } catch { setError("Could not sign you in. Check your details and try again."); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-white flex items-start justify-center px-6 py-16">
      <div className="w-full max-w-sm space-y-5">
        <h1 className="text-2xl font-bold text-gray-900">Activate your login</h1>
        <p className="text-sm text-gray-500">Use the same e-mail address you registered with. Your registration must already be approved.</p>
        <button disabled={busy} onClick={() => run(async () => (await signInWithGoogle()).user)}
          className="w-full h-11 border border-gray-200 rounded-lg text-sm font-semibold hover:bg-gray-50 disabled:opacity-50">Continue with Google</button>
        <div className="text-center text-xs text-gray-400">or</div>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full h-11 border border-gray-200 rounded-lg px-3 text-sm" />
        <input type="password" placeholder={mode === "create" ? "Choose your own password" : "Your password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "create" ? "new-password" : "current-password"}
          className="w-full h-11 border border-gray-200 rounded-lg px-3 text-sm" />
        <button disabled={busy || !email || password.length < 8}
          onClick={() => run(() => (mode === "create" ? createFirebaseUser(email, password) : signIn(email, password)))}
          className="w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 disabled:opacity-50">
          {mode === "create" ? "Create login and activate" : "Activate"}
        </button>
        <button className="text-xs text-gray-500 underline" onClick={() => setMode(mode === "create" ? "signin" : "create")}>
          {mode === "create" ? "I already created my login (e.g. after verifying my e-mail)" : "Create a new login instead"}
        </button>
        {message && <p className="text-sm text-blue-600">{message}</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
