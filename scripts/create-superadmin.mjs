/**
 * Provision a super_admin — the only way to create the first admin account.
 * (The app never promotes anyone to super_admin on its own; later admins are
 * added from Admin → Staff by an existing super_admin.)
 *
 * Usage:
 *   npm run setup-admin -- admin@yourdomain.com
 *
 * If the email has no Firebase login yet, one is created with a random
 * one-time password that is printed once — sign in and change it.
 * If the login already exists, pass its current password so the script can
 * confirm you own it:
 *   EXISTING_PASSWORD='...' npm run setup-admin -- admin@yourdomain.com
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_FIREBASE_API_KEY
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { randomBytes } from "crypto";

// ── Load .env.local ───────────────────────────────────────────
const envPath = resolve(process.cwd(), ".env.local");
const envVars = {};
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    envVars[key] = value;
  }
} catch {
  console.error("Could not read .env.local — run this from the project root.");
  process.exit(1);
}

const FIREBASE_API_KEY = envVars["NEXT_PUBLIC_FIREBASE_API_KEY"];
const AIRTABLE_API_KEY = envVars["AIRTABLE_API_KEY"];
const AIRTABLE_BASE_ID = envVars["AIRTABLE_BASE_ID"];

if (!FIREBASE_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error(
    "Missing required env vars. Make sure these are set in .env.local:\n" +
    "  NEXT_PUBLIC_FIREBASE_API_KEY\n" +
    "  AIRTABLE_API_KEY\n" +
    "  AIRTABLE_BASE_ID"
  );
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────
const EMAIL = (process.argv[2] ?? "").trim().toLowerCase();
const ROLE = "super_admin";
const EXISTING_PASSWORD = process.env.EXISTING_PASSWORD;

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(EMAIL)) {
  console.error("Usage: npm run setup-admin -- admin@yourdomain.com");
  process.exit(1);
}

const airtable = (path, init = {}) =>
  fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

// ── Step 1: Firebase login ────────────────────────────────────
console.log(`\n[1/2] Firebase login for ${EMAIL} ...`);

let uid;
let tempPassword = null;

const generated = randomBytes(18).toString("base64url");
const fbRes = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: generated }),
  }
);
const fbData = await fbRes.json();

if (fbRes.ok) {
  uid = fbData.localId;
  tempPassword = generated;
  console.log(`  ✓ Created Firebase user ${uid}`);
} else if ((fbData?.error?.message ?? "").includes("EMAIL_EXISTS")) {
  if (!EXISTING_PASSWORD) {
    console.error(
      "  This email already has a Firebase login. Re-run with its current password:\n" +
      `    EXISTING_PASSWORD='...' npm run setup-admin -- ${EMAIL}`
    );
    process.exit(1);
  }
  const signInRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: EXISTING_PASSWORD, returnSecureToken: true }),
    }
  );
  const signInData = await signInRes.json();
  if (!signInRes.ok) {
    console.error("  Could not sign in with EXISTING_PASSWORD:", signInData?.error?.message);
    process.exit(1);
  }
  uid = signInData.localId;
  console.log(`  ✓ Using existing Firebase user ${uid}`);
} else {
  console.error("  Firebase error:", fbData?.error?.message ?? JSON.stringify(fbData));
  process.exit(1);
}

// ── Step 2: Airtable Users record ─────────────────────────────
console.log(`\n[2/2] Airtable Users record ...`);

const formula = encodeURIComponent(`{FirebaseUID} = '${uid.replace(/'/g, "''")}'`);
const existingRes = await airtable(`Users?filterByFormula=${formula}&maxRecords=1`);
const existingData = await existingRes.json();
if (!existingRes.ok) {
  console.error("  Airtable error:", existingData?.error?.message ?? JSON.stringify(existingData));
  process.exit(1);
}

const existing = existingData.records?.[0];
let recordId;
if (existing) {
  const currentRole = existing.fields?.Role;
  if (currentRole === ROLE) {
    console.log(`  ✓ Already a super_admin (record ${existing.id}) — nothing to do.`);
    process.exit(0);
  }
  if (existing.fields?.CustomerRecord?.length) {
    console.error("  This login belongs to a customer account. Use a separate email for the admin.");
    process.exit(1);
  }
  const upd = await airtable(`Users/${existing.id}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: { Role: ROLE } }),
  });
  if (!upd.ok) {
    console.error("  Airtable error:", (await upd.json())?.error?.message);
    process.exit(1);
  }
  recordId = existing.id;
  console.log(`  ✓ Promoted record ${recordId} from ${currentRole} to ${ROLE}`);
} else {
  const atRes = await airtable("Users", {
    method: "POST",
    body: JSON.stringify({
      fields: { FirebaseUID: uid, Email: EMAIL, Role: ROLE, LastLogin: new Date().toISOString() },
    }),
  });
  const atData = await atRes.json();
  if (!atRes.ok) {
    console.error("  Airtable error:", atData?.error?.message ?? JSON.stringify(atData));
    process.exit(1);
  }
  recordId = atData.id;
  console.log(`  ✓ Created record ${recordId}`);
}

// ── Done ──────────────────────────────────────────────────────
console.log(`\nSuper admin ready: ${EMAIL}`);
if (tempPassword) {
  console.log(`One-time password (shown once): ${tempPassword}`);
  console.log("→ Sign in, then change it (or use Forgot Password on the sign-in page).\n");
}
