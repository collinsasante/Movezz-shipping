// ============================================================
// FIREBASE AUTH - Server-side only (no firebase-admin SDK)
// Uses jose + Google REST APIs — zero heavy Node.js dependencies
// ============================================================
import { createLocalJWKSet, jwtVerify, SignJWT, importPKCS8 } from "jose";
import type { JWTVerifyOptions } from "jose";

// Cloudflare context is stored in AsyncLocalStorage by OpenNext's init.js.
// Reading directly from it is more reliable than process.env inside Workers,
// because process.env is only populated on the first request.
function getCfEnv(): Record<string, string | undefined> {
  const ctx = (globalThis as Record<symbol, unknown>)[
    Symbol.for("__cloudflare-context__")
  ] as { env?: Record<string, string> } | undefined;
  return ctx?.env ?? {};
}

function getEnvVar(key: string): string {
  const val = process.env[key] ?? getCfEnv()[key] ?? "";
  if (!val) console.error(`[firebase-admin] env var missing: ${key}`);
  return val;
}

const getProjectId = () => getEnvVar("FIREBASE_PROJECT_ID");
const getClientEmail = () => getEnvVar("FIREBASE_CLIENT_EMAIL");
const getPrivateKey = () => {
  const raw = getEnvVar("FIREBASE_PRIVATE_KEY");
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
};
const getBaseUrl = () => `https://identitytoolkit.googleapis.com/v1/projects/${getProjectId()}`;

// ── JWKS via global fetch (createRemoteJWKSet uses https.get which unenv doesn't support)
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let _jwksCache: { keys: object[] } | null = null;
let _jwksCacheTime = 0;
const JWKS_TTL = 6 * 60 * 60 * 1000; // 6 h

async function getJWKS() {
  const now = Date.now();
  if (_jwksCache && now - _jwksCacheTime < JWKS_TTL) return _jwksCache;
  const resp = await fetch(JWKS_URL);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  _jwksCache = (await resp.json()) as { keys: object[] };
  _jwksCacheTime = now;
  return _jwksCache;
}

// ── Token Verification ────────────────────────────────────────────────────────

export async function verifyIdToken(idToken: string) {
  const projectId = getProjectId();
  const jwks = await getJWKS();
  const keySet = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
  const opts: JWTVerifyOptions = {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  };
  const { payload } = await jwtVerify(idToken, keySet, opts);
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

  const key = await importPKCS8(getPrivateKey(), "RS256");
  const nowSec = Math.floor(now / 1000);

  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/identitytoolkit",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(getClientEmail())
    .setSubject(getClientEmail())
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
  const resp = await fetch(`${getBaseUrl()}/accounts`, {
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
  const resp = await fetch(`${getBaseUrl()}/accounts:batchDelete`, {
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
  const resp = await fetch(`${getBaseUrl()}/accounts:lookup`, {
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
