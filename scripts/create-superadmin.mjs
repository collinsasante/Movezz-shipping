/**
 * Bootstrap script — creates the first superadmin account.
 * Run once: node scripts/create-superadmin.mjs
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_FIREBASE_API_KEY
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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
const EMAIL = "mr.asantee@gmail.com";
const ROLE  = "super_admin";
const TEMP_PASSWORD = "MOVEZZ-Admin2025!";

// ── Step 1: Create Firebase user ──────────────────────────────
console.log(`\n[1/2] Creating Firebase user for ${EMAIL} ...`);

const fbRes = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: TEMP_PASSWORD }),
  }
);

const fbData = await fbRes.json();

if (!fbRes.ok) {
  const msg = fbData?.error?.message ?? JSON.stringify(fbData);
  if (msg.includes("EMAIL_EXISTS")) {
    console.warn("  Firebase user already exists — will still try to create Airtable record.");
    // Fetch existing UID
    const lookupRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: TEMP_PASSWORD, returnSecureToken: true }),
      }
    );
    const lookupData = await lookupRes.json();
    if (!lookupRes.ok) {
      console.error("  Could not sign in to get existing UID:", lookupData?.error?.message);
      process.exit(1);
    }
    fbData.localId = lookupData.localId;
  } else {
    console.error("  Firebase error:", msg);
    process.exit(1);
  }
}

const uid = fbData.localId;
console.log(`  ✓ Firebase UID: ${uid}`);

// ── Step 2: Create Airtable Users record ──────────────────────
console.log(`\n[2/2] Creating Airtable Users record ...`);

const atRes = await fetch(
  `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Users`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        FirebaseUID: uid,
        Email: EMAIL,
        Role: ROLE,
        LastLogin: new Date().toISOString(),
      },
    }),
  }
);

const atData = await atRes.json();

if (!atRes.ok) {
  const msg = atData?.error?.message ?? JSON.stringify(atData);
  console.error("  Airtable error:", msg);
  process.exit(1);
}

console.log(`  ✓ Airtable record ID: ${atData.id}`);

// ── Done ──────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════╗
║           Superadmin Created Successfully        ║
╠══════════════════════════════════════════════════╣
║  Email    : ${EMAIL.padEnd(36)}║
║  Password : ${TEMP_PASSWORD.padEnd(36)}║
║  Role     : ${ROLE.padEnd(36)}║
╚══════════════════════════════════════════════════╝

→ Log in, then change the password immediately.
`);
