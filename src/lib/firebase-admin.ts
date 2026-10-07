// ============================================================
// FIREBASE AUTH - Server-side only (no firebase-admin SDK)
// Uses WebCrypto + Google REST APIs — works in Cloudflare Workers
// (jose's Node.js path uses crypto.sign which unenv hasn't implemented)
// ============================================================

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
    users?: Array<{ localId: string; email?: string; emailVerified?: boolean; disabled?: boolean }>;
  };
  const user = data.users?.[0];
  if (!user) throw new Error("No user found for token");
  // Firebase already refuses to issue tokens to disabled accounts; this also
  // cuts off a token that was issued before the account was disabled.
  if (user.disabled) throw new Error("USER_DISABLED");

  return {
    uid: user.localId,
    email: user.email,
    emailVerified: user.emailVerified === true,
    sub: user.localId,
  };
}

/** True when a Firebase error message means the account is disabled. */
export function isDisabledAccountError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("USER_DISABLED");
}

/**
 * Checks an email + password against Firebase and returns the account's UID.
 * Used by signup to recover a Firebase account whose Airtable records were
 * never created: knowing the password proves the caller owns that login.
 * Throws with Firebase's error code (e.g. INVALID_LOGIN_CREDENTIALS, USER_DISABLED).
 */
export async function verifyPassword(email: string, password: string): Promise<{ uid: string }> {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || getEnvVar("NEXT_PUBLIC_FIREBASE_API_KEY");
  if (!apiKey) throw new Error("NEXT_PUBLIC_FIREBASE_API_KEY is not configured");

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: false }),
    }
  );
  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Firebase sign-in failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { localId: string };
  return { uid: data.localId };
}

/**
 * A long random password nobody is told. Accounts created on someone's behalf
 * (admin-created customers) get one of these; the owner sets their real
 * password through the one-time activation link.
 */
export function generateUnusablePassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
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

  // Use WebCrypto (crypto.subtle) directly — jose's Node.js path calls
  // crypto.sign which unenv hasn't implemented in Cloudflare Workers.
  const pemBody = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const derBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    derBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const nowSec = Math.floor(now / 1000);
  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({
    iss: clientEmail,
    sub: clientEmail,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/identitytoolkit",
    iat: nowSec,
    exp: nowSec + 3600,
  });
  const signingInput = `${header}.${payload}`;
  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const sig = btoa(Array.from(new Uint8Array(sigBytes), (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const assertion = `${signingInput}.${sig}`;

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

export async function getFirebaseUserByEmail(
  email: string
): Promise<{ localId: string; email: string; emailVerified?: boolean; disabled?: boolean } | null> {
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
  const data = (await resp.json()) as {
    users?: Array<{ localId: string; email: string; emailVerified?: boolean; disabled?: boolean }>;
  };
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
    users?: Array<{ localId: string; email: string; emailVerified?: boolean; disabled?: boolean }>;
  };
  return data.users?.[0] ?? null;
}

// ── Email ─────────────────────────────────────────────────────────────────────

export function getAppUrl(): string {
  const url =
    process.env.APP_URL ??
    getCfEnv()["APP_URL"] ??
    "https://ship.gomovezz.com";
  // Never let a localhost value escape to production email links
  if (url.includes("localhost")) return "https://ship.gomovezz.com";
  return url;
}

// Rewrites a Firebase-hosted oobLink to our custom /auth/action page,
// preserving the oobCode, apiKey, and lang params Firebase embedded.
function rewriteToCustomDomain(oobLink: string, mode: string, intent?: string): string {
  try {
    const src = new URL(oobLink);
    const oobCode = src.searchParams.get("oobCode");
    const apiKey = src.searchParams.get("apiKey");
    const lang = src.searchParams.get("lang") ?? "en";
    if (!oobCode) return oobLink;
    const dest = new URL(`${getAppUrl()}/auth/action`);
    dest.searchParams.set("mode", mode);
    dest.searchParams.set("oobCode", oobCode);
    if (apiKey) dest.searchParams.set("apiKey", apiKey);
    dest.searchParams.set("lang", lang);
    // intent only changes the page's wording; the oobCode is what's checked
    if (intent) dest.searchParams.set("intent", intent);
    return dest.toString();
  } catch {
    return oobLink;
  }
}

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
  return rewriteToCustomDomain(data.oobLink, "verifyEmail");
}

/**
 * Generates a Firebase password reset link WITHOUT sending Firebase's own email.
 * Uses the admin token + returnOobLink=true so we can send our custom HTML email instead.
 */
export async function generatePasswordResetLink(
  email: string,
  intent?: "activate"
): Promise<string> {
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
  return rewriteToCustomDomain(data.oobLink, "resetPassword", intent);
}

/**
 * One-time account activation link for an account created on the customer's
 * behalf. It is a Firebase password-reset code (single use, expires, only
 * reaches the owner's inbox) shown on the activation page instead of the
 * reset page. The Firebase account is already linked to the right Customer
 * by UID, so activating never relies on matching emails.
 */
export async function generateAccountActivationLink(email: string): Promise<string> {
  return generatePasswordResetLink(email, "activate");
}

// setCustomClaims is a no-op — roles are sourced from Airtable, not JWT claims
export async function setCustomClaims(
  _uid: string,
  _claims: Record<string, unknown>
): Promise<void> {
  // Intentionally empty: auth.ts reads roles from Airtable Users table
}
