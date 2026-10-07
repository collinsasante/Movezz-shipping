// Client-side: sign in with email + password and establish the normal session
// (Firebase ID token → /api/auth/verify → HttpOnly auth-token cookie).
import axios from "axios";
import { signIn } from "@/lib/firebase";
import type { AppUser } from "@/types";

const USER_CACHE_KEY = "pakk_user_cache";

export async function startSession(idToken: string): Promise<AppUser> {
  const res = await axios.post("/api/auth/verify", { idToken });
  const user = res.data.data.user as AppUser;
  try { localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user)); } catch {}
  return user;
}

export async function signInAndStartSession(email: string, password: string): Promise<AppUser> {
  const fbUser = await signIn(email, password);
  return startSession(await fbUser.getIdToken());
}

export function dashboardPathFor(role: AppUser["role"]): string {
  return role === "customer" ? "/customer" : "/admin";
}
