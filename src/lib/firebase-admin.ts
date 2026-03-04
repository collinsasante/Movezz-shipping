// ============================================================
// FIREBASE AUTH - Server-side only (no firebase-admin SDK)
// Uses jose + Google REST APIs — zero heavy Node.js dependencies
// ============================================================
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from "jose";

console.log("[firebase-admin] loading module...");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID!;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL!;
const RAW_KEY = process.env.FIREBASE_PRIVATE_KEY ?? "";
const PRIVATE_KEY = RAW_KEY.includes("\\n") ? RAW_KEY.replace(/\\n/g, "\n") : RAW_KEY;

const BASE_URL = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}`;

console.log("[firebase-admin] env check — PROJECT_ID:", PROJECT_ID ? "✓" : "MISSING", "| CLIENT_EMAIL:", CLIENT_EMAIL ? "✓" : "MISSING", "| PRIVATE_KEY:", PRIVATE_KEY ? "✓" : "MISSING");

// Google's public JWKS for verifying Firebase ID tokens
const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
);

// ── Token Verification ────────────────────────────────────────────────────────

export async function verifyIdToken(idToken: string) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
  });
  return {
    uid: payload.sub as string,
    email: payload["email"] as string | undefined,
    ...payload,
  };
}

// ── Service Account OAuth Token (in-memory cache) ────────────────────────────

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getAdminToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresAt > now + 60_000) {
    return _cachedToken.token;
  }

  const key = await importPKCS8(PRIVATE_KEY, "RS256");
  const nowSec = Math.floor(now / 1000);

  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/identitytoolkit",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(CLIENT_EMAIL)
    .setSubject(CLIENT_EMAIL)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(key);

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!resp.ok || !data.access_token) {
    throw new Error("Failed to obtain admin access token");
  }

  _cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };
  return _cachedToken.token;
}

// ── User Management ───────────────────────────────────────────────────────────

export async function createFirebaseUser(email: string, password: string) {
  const token = await getAdminToken();
  const resp = await fetch(`${BASE_URL}/accounts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!resp.ok) {
    const err = (await resp.json()) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? "Failed to create user");
  }

  const data = (await resp.json()) as { localId: string };
  return { uid: data.localId };
}

export async function deleteFirebaseUser(uid: string) {
  const token = await getAdminToken();
  const resp = await fetch(`${BASE_URL}/accounts:batchDelete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ localIds: [uid], force: true }),
  });

  if (!resp.ok) {
    const err = (await resp.json()) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? "Failed to delete user");
  }
}

export async function getFirebaseUser(uid: string) {
  const token = await getAdminToken();
  const resp = await fetch(`${BASE_URL}/accounts:lookup`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ localId: [uid] }),
  });

  if (!resp.ok) throw new Error("Failed to get user");

  const data = (await resp.json()) as {
    users?: Array<{ localId: string; email: string }>;
  };
  return data.users?.[0] ?? null;
}

// ── Email ─────────────────────────────────────────────────────────────────────

/**
 * Sends a Firebase "set / reset your password" email to the given address.
 * Uses the public Web API key — no admin token needed.
 */
export async function sendPasswordResetEmail(email: string): Promise<void> {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
    }
  );
  if (!resp.ok) {
    const err = (await resp.json()) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? "Failed to send password reset email");
  }
}

// setCustomClaims is a no-op — roles are sourced from Airtable, not JWT claims
export async function setCustomClaims(
  _uid: string,
  _claims: Record<string, unknown>
): Promise<void> {
  // Intentionally empty: auth.ts reads roles from Airtable Users table
}
