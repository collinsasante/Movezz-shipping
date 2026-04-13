// ============================================================
// FIREBASE AUTH - Server-side only (no firebase-admin SDK)
// Uses jose + Google REST APIs — zero heavy Node.js dependencies
// ============================================================
import { SignJWT, importPKCS8 } from "jose";

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
  if (!val) { /* env var missing: ${key} */ }
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
// ── Token Verification via Firebase REST API ─────────────────────────────────
// Local JWT verification (jose) has crypto compatibility issues in Cloudflare
// Workers. Instead, we ask Firebase's own servers to validate the token —
// this is authoritative, handles key rotation automatically, and detects
// revoked tokens.

export async function verifyIdToken(idToken: string) {
  // Use dot-notation so Next.js inlines this at build time
  // eslint-disable-next-line prefer-destructuring
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || getEnvVar("NEXT_PUBLIC_FIREBASE_API_KEY");
  if (!apiKey) throw new Error("NEXT_PUBLIC_FIREBASE_API_KEY is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  let resp: Response;
  try {
    resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
        signal: controller.signal,
      }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const err = (await resp.json()) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Firebase lookup failed: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    users?: Array<{ localId: string; email?: string }>;
  };
  const user = data.users?.[0];
  if (!user) throw new Error("No user found for token");

  return {
    uid: user.localId,
    email: user.email,
    sub: user.localId,
  };
}

// ── Service Account OAuth Token (in-memory cache) ────────────────────────────

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getAdminToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresAt > now + 5 * 60_000) {
    return _cachedToken.token;
  }

  const privateKey = getPrivateKey();
  const clientEmail = getClientEmail();
  if (!privateKey || !clientEmail) {
    throw new Error(
      `Firebase service account not configured — FIREBASE_PRIVATE_KEY=${privateKey ? "set" : "MISSING"}, FIREBASE_CLIENT_EMAIL=${clientEmail ? "set" : "MISSING"}`
    );
  }

  const key = await importPKCS8(privateKey, "RS256");
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

export async function getFirebaseUserByEmail(email: string): Promise<{ localId: string; email: string } | null> {
  const token = await getAdminToken();
  const resp = await fetch(`${getBaseUrl()}/accounts:lookup`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: [email] }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { users?: Array<{ localId: string; email: string }> };
  return data.users?.[0] ?? null;
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
 * Generates a Firebase email verification link WITHOUT sending Firebase's own email.
 * Uses the admin token + returnOobLink=true so we can send our custom HTML email instead.
 */
export async function generateEmailVerificationLink(email: string): Promise<string> {
  const token = await getAdminToken();
  const resp = await fetch(`${getBaseUrl()}/accounts:sendOobCode`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestType: "VERIFY_EMAIL",
      email,
      returnOobLink: true,
    }),
  });

  if (!resp.ok) {
    const err = (await resp.json()) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? "Failed to generate verification link");
  }

  const data = (await resp.json()) as { oobLink?: string };
  if (!data.oobLink) throw new Error("No verification link returned");
  return data.oobLink;
}

/**
 * Generates a Firebase password reset link WITHOUT sending Firebase's own email.
 * Uses the admin token + returnOobLink=true so we can send our custom HTML email instead.
 */
export async function generatePasswordResetLink(email: string): Promise<string> {
  const token = await getAdminToken();
  const resp = await fetch(`${getBaseUrl()}/accounts:sendOobCode`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestType: "PASSWORD_RESET",
      email,
      returnOobLink: true,
    }),
  });

  if (!resp.ok) {
    const err = (await resp.json()) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? "Failed to generate password reset link");
  }

  const data = (await resp.json()) as { oobLink?: string };
  if (!data.oobLink) throw new Error("No password reset link returned");
  return data.oobLink;
}

// setCustomClaims is a no-op — roles are sourced from Airtable, not JWT claims
export async function setCustomClaims(
  _uid: string,
  _claims: Record<string, unknown>
): Promise<void> {
  // Intentionally empty: auth.ts reads roles from Airtable Users table
}
