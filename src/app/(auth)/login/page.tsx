"use client";

import React, { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn, signInWithGoogle } from "@/lib/firebase";
import { useToast } from "@/components/ui/toast";
import { Eye, EyeOff } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import axios from "axios";

function GoogleIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { error: toastError } = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const redirect = searchParams?.get("redirect");

  const goToDashboard = (role: string) => {
    const defaultPath = role === "customer" ? "/customer" : "/admin";
    // Only allow internal relative redirects to prevent open redirect attacks
    if (redirect && redirect.startsWith("/") && !redirect.startsWith("//")) {
      return router.replace(redirect);
    }
    router.replace(defaultPath);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const fbUser  = await signIn(email, password);
      const idToken = await fbUser.getIdToken();
      const res     = await axios.post("/api/auth/verify", { idToken });
      goToDashboard(res.data.data.user.role);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Login failed"
        : err instanceof Error ? err.message : "Invalid email or password";
      toastError("Login failed", msg);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);
    try {
      const result  = await signInWithGoogle();
      const idToken = await result.user.getIdToken();
      const res = await axios
        .post("/api/auth/verify", { idToken })
        .catch((err) => {
          if (axios.isAxiosError(err) && err.response?.data?.code === "NOT_REGISTERED") return null;
          throw err;
        });
      if (res) {
        goToDashboard(res.data.data.user.role);
      } else {
        toastError("Account not found", "Your account hasn't been set up yet. Contact your administrator.");
      }
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "";
      const msg = raw.includes("popup-closed")
        ? "Sign-in cancelled"
        : axios.isAxiosError(err)
        ? err.response?.data?.error ?? "Google sign-in failed"
        : "Google sign-in failed";
      toastError("Sign-in failed", msg);
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Brand at top */}
      <div className="flex items-center gap-2.5 px-10 pt-8">
        <Image src="/logowithouttext.png" alt="PAKKmax" width={28} height={28} className="rounded" />
        <span className="text-sm font-semibold text-gray-700 tracking-tight">PAKKmax</span>
      </div>

      {/* Form — vertically centred */}
      <div className="flex-1 flex items-center justify-center px-10">
        <div className="w-full max-w-sm">
          <h2 className="text-3xl font-bold text-gray-900 mb-1.5">Welcome Back</h2>
          <p className="text-sm text-gray-400 mb-8">Enter your email and password to access your account</p>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
              <input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full h-11 px-4 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full h-11 px-4 pr-11 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <label className="flex items-center gap-2 text-gray-500 cursor-pointer select-none">
                <input
                  type="checkbox"
                  defaultChecked
                  className="h-3.5 w-3.5 rounded border-gray-300 accent-gray-900"
                />
                Remember me
              </label>
              <Link href="/reset-password" className="text-gray-500 hover:text-gray-900 transition-colors">
                Forgot Password?
              </Link>
            </div>

            <button
              type="submit"
              disabled={loading || googleLoading}
              className="w-full h-11 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading || googleLoading}
            className="mt-3 w-full h-11 flex items-center justify-center gap-3 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {googleLoading ? (
              <svg className="h-4 w-4 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : <GoogleIcon />}
            Sign In with Google
          </button>
        </div>
      </div>

      {/* Bottom link */}
      <p className="text-center text-sm text-gray-400 pb-8">
        Need access?{" "}
        <span className="text-gray-700 font-medium">Contact your PAKKmax administrator.</span>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="h-screen w-screen flex bg-white overflow-hidden">
      <div className="w-full h-full flex overflow-hidden">
        {/* ── Left panel ── */}
        <div className="hidden lg:flex lg:w-[48%] flex-col justify-between p-10 relative overflow-hidden">
          {/* Background image */}
          <Image
            src="/auth-bg.png"
            alt=""
            fill
            className="object-cover"
            priority
          />
          {/* Dark overlay for text legibility */}
          <div className="absolute inset-0 bg-black/40" />

          {/* Top label */}
          <div className="relative z-10 flex items-center gap-3">
            <div className="h-px w-8 bg-white/25" />
            <span className="text-xs font-semibold tracking-widest text-white/40 uppercase">
              Our Mission
            </span>
          </div>

          {/* Bottom text */}
          <div className="relative z-10">
            <h1 className="text-4xl font-black text-white leading-[1.15] mb-4">
              Move Anything,<br />Anywhere<br />Reliably.
            </h1>
            <p className="text-sm text-white/50 leading-relaxed max-w-xs">
              Seamlessly shipping from China to Ghana. Track every package, every mile, every step of the way.
            </p>
          </div>
        </div>

        {/* ── Right panel ── */}
        <div className="flex-1 bg-white flex flex-col">
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center">
                <div className="w-8 h-8 rounded-full border-2 border-gray-200 border-t-gray-900 animate-spin" />
              </div>
            }
          >
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
