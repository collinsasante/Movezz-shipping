// Maps Firebase client SDK / API errors to messages that are safe to show users.
import axios from "axios";

const FIREBASE_MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/invalid-login-credentials": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/invalid-email": "Please enter a valid email address.",
  "auth/user-disabled": "This account has been disabled. Contact support.",
  "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "auth/network-request-failed": "Network error. Check your connection and try again.",
  "auth/weak-password": "Please choose a stronger password.",
  "auth/expired-action-code": "This link has expired.",
  "auth/invalid-action-code": "This link is invalid or has already been used.",
  "auth/popup-closed-by-user": "Sign-in cancelled.",
  "auth/cancelled-popup-request": "Sign-in cancelled.",
  "auth/popup-blocked": "Your browser blocked the sign-in popup. Allow popups and try again.",
  "auth/account-exists-with-different-credential":
    "An account already exists with this email. Sign in with your password instead.",
};

export function firebaseErrorCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

/** A user-facing message for an error from Firebase or one of our API routes. */
export function authErrorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (axios.isAxiosError(err)) {
    if (err.response?.status === 429) return "Too many attempts. Please wait a few minutes and try again.";
    return err.response?.data?.error ?? (err.response ? fallback : FIREBASE_MESSAGES["auth/network-request-failed"]);
  }
  return FIREBASE_MESSAGES[firebaseErrorCode(err)] ?? fallback;
}
