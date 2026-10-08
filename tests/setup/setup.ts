// Global test setup. Runs before every test file.
//
// Purpose: make it IMPOSSIBLE for the suite to reach a real external service.
//  1. Outbound network access (fetch) is blocked.
//  2. Every external SDK / integration module is replaced by an in-memory stand-in:
//       airtable, resend, cloudinary, @/lib/firebase-admin, @/lib/keepup, @/lib/email
//  3. Fake credentials are injected by vitest.config.ts (never the developer's env).
//
// Tests that need the REAL implementation of an integration module (for example
// the Keepup HTTP client) load it explicitly with vi.importActual() and stub fetch themselves.
import { vi, afterEach } from "vitest";
import { state } from "../helpers/state";

// ---- 1. Network guard ------------------------------------------------------
const blockedFetch = (input: unknown) => {
  const target = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
  state().blockedNetworkCalls.push(target);
  throw new Error(
    `[test-safety] Outbound network access is blocked in tests (attempted: ${target}). ` +
      `Mock the integration instead of calling it.`
  );
};
globalThis.fetch = blockedFetch as unknown as typeof fetch;

// ---- 2. External SDK stand-ins --------------------------------------------
vi.mock("airtable", async () => await import("../helpers/fakeAirtable"));

vi.mock("resend", () => {
  class Resend {
    constructor(_apiKey?: string) {}
    emails = {
      send: async (payload: { from?: string; to: string[]; subject: string; html: string }) => {
        const g = globalThis as unknown as Record<string, { sentEmails: unknown[] } | undefined>;
        g["__MOVEZZ_TEST_STATE__"]?.sentEmails.push(payload);
        return { data: { id: "test-email-id" }, error: null };
      },
    };
  }
  return { Resend };
});

vi.mock("cloudinary", () => ({
  v2: {
    config: () => undefined,
    utils: { api_sign_request: () => "test-only-signature" },
  },
}));

vi.mock("@/lib/firebase-admin", async () => {
  const { state } = await import("../helpers/state");
  return {
    // Token -> identity registry (see tests/helpers/world.ts: asUser()).
    verifyIdToken: vi.fn(async (token: string) => {
      const id = state().tokens.get(token);
      if (!id) throw new Error("INVALID_ID_TOKEN");
      return { uid: id.uid, email: id.email, emailVerified: id.emailVerified ?? true, sub: id.uid };
    }),
    createFirebaseUser: vi.fn(async (email: string) => ({ uid: `fb-${email}` })),
    deleteFirebaseUser: vi.fn(async () => undefined),
    getFirebaseUserByEmail: vi.fn(async () => null),
    getFirebaseUser: vi.fn(async () => null),
    generatePasswordResetLink: vi.fn(async () => "https://app.example.invalid/auth/action?mode=resetPassword&oobCode=test"),
    generateEmailVerificationLink: vi.fn(async () => "https://app.example.invalid/auth/action?mode=verifyEmail&oobCode=test"),
    setCustomClaims: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/keepup", () => ({
  createKeepupSale: vi.fn(async () => ({ saleId: "KU-TEST-1", link: "https://keepup.example.invalid/s/KU-TEST-1" })),
  getKeepupSale: vi.fn(async () => ({ totalAmount: 0, amountPaid: 0, balanceDue: 0 })),
  fetchKeepupShareLink: vi.fn(async () => null),
  recordKeepupPayment: vi.fn(async () => undefined),
  updateKeepupSale: vi.fn(async () => undefined),
  cancelKeepupSale: vi.fn(async () => undefined),
  refundKeepupSale: vi.fn(async () => undefined),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => undefined),
  sendWelcomeEmail: vi.fn(async () => undefined),
  sendInvoiceCreatedEmail: vi.fn(async () => undefined),
  sendPaymentConfirmedEmail: vi.fn(async () => undefined),
  sendItemStatusEmail: vi.fn(async () => undefined),
  sendPasswordResetEmail: vi.fn(async () => undefined),
  sendEmailVerificationEmail: vi.fn(async () => undefined),
  sendPartialPaymentEmail: vi.fn(async () => undefined),
}));

// ---- 3. Per-test hygiene ----------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks(); // undo vi.spyOn(globalThis, "fetch") etc.
  vi.useRealTimers();
});
