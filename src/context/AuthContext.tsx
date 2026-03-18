"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import { auth, onIdTokenChanged, signOut, type User } from "@/lib/firebase";
import type { AppUser } from "@/types";
import axios from "axios";

interface AuthContextValue {
  firebaseUser: User | null;
  appUser: AppUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  firebaseUser: null,
  appUser: null,
  loading: true,
  signOut: async () => {},
  refreshUser: async () => {},
});

const USER_CACHE_KEY = "pakk_user_cache";

function loadCachedUser(): AppUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? (JSON.parse(raw) as AppUser) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(() => loadCachedUser());
  const [loading, setLoading] = useState(true);
  // Track whether Firebase has ever resolved to a real user this session
  const authResolved = useRef(false);

  const fetchAppUser = useCallback(async (user: User) => {
    try {
      // Force-refresh the Firebase token to ensure it's never expired when sent to the server
      const idToken = await user.getIdToken(true);
      const res = await axios.post("/api/auth/verify", { idToken });
      if (res.data.success) {
        setAppUser(res.data.data.user);
        try { localStorage.setItem(USER_CACHE_KEY, JSON.stringify(res.data.data.user)); } catch {}
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const code = err.response?.data?.code;
        if (status === 401) {
          // Token is genuinely invalid — sign out
          setAppUser(null);
          try { localStorage.removeItem(USER_CACHE_KEY); } catch {}
          await signOut().catch(() => {});
        } else if (status === 404 && code === "NOT_REGISTERED") {
          // Not in the system — sign out
          setAppUser(null);
          await signOut().catch(() => {});
        }
        // 500 or other transient errors: do NOT sign out — keep the current session alive
      }
      // Network errors or non-Axios errors: do nothing, user stays logged in
    }
  }, []);

  const refreshUser = useCallback(async () => {
    if (firebaseUser) {
      await fetchAppUser(firebaseUser);
    }
  }, [firebaseUser, fetchAppUser]);

  useEffect(() => {
    // onIdTokenChanged fires on sign-in, sign-out, AND every time Firebase
    // silently refreshes the ID token (~every 59 min). This keeps the HttpOnly
    // cookie up-to-date so users are never kicked out mid-session.
    const unsubscribe = onIdTokenChanged(auth, async (user) => {
      setFirebaseUser(user);

      if (user) {
        authResolved.current = true;
        await fetchAppUser(user);
      } else {
        // No Firebase user — check if there's a cookie session
        try {
          const res = await axios.get("/api/auth/verify-cookie");
          if (res.data.success) {
            authResolved.current = true;
            setAppUser(res.data.data);
            try { localStorage.setItem(USER_CACHE_KEY, JSON.stringify(res.data.data)); } catch {}
          } else if (authResolved.current) {
            // Was authenticated this session — this is a genuine sign-out
            setAppUser(null);
            try { localStorage.removeItem(USER_CACHE_KEY); } catch {}
          }
          // else: first null before Firebase restored on mobile — keep cached user
        } catch {
          // Network/server error on cookie check — keep cached user, don't sign out
          // Firebase will fire again with the user once it restores from IndexedDB
        }
      }

      setLoading(false);
    });

    return () => unsubscribe();
  }, [fetchAppUser]);

  const handleSignOut = useCallback(async () => {
    try {
      await axios.delete("/api/auth/verify");
      await signOut();
      setFirebaseUser(null);
      setAppUser(null);
      try { localStorage.removeItem(USER_CACHE_KEY); } catch {}
      window.location.href = "/login";
    } catch {
      // sign out error
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        appUser,
        loading,
        signOut: handleSignOut,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
