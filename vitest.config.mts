import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Test configuration for the characterization / regression safety net.
//
// SAFETY: every credential below is an obviously fake, test-only placeholder.
// They are set here (not read from the developer's environment) so that a
// real AIRTABLE_API_KEY / KEEPUP_API_KEY / FIREBASE_* / CLOUDINARY_* /
// RESEND_API_KEY / WHATSAPP_* value exported in the shell can never reach the
// code under test. tests/setup/setup.ts additionally blocks outbound network
// access and replaces every external SDK with an in-memory stand-in.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/setup.ts"],
    clearMocks: true,
    testTimeout: 15_000,
    env: {
      NODE_ENV: "test",
      TZ: "UTC", // date strings sent to Keepup depend on the local time zone
      AIRTABLE_API_KEY: "test-only-airtable-key",
      AIRTABLE_BASE_ID: "appTESTONLY000000",
      KEEPUP_API_KEY: "test-only-keepup-key",
      RESEND_API_KEY: "test-only-resend-key",
      EMAIL_FROM: "Movezz Test <noreply@example.invalid>",
      CLOUDINARY_CLOUD_NAME: "test-only-cloud",
      CLOUDINARY_API_KEY: "test-only-cloudinary-key",
      CLOUDINARY_API_SECRET: "test-only-cloudinary-secret",
      FIREBASE_PROJECT_ID: "test-only-project",
      FIREBASE_CLIENT_EMAIL: "test-only@example.invalid",
      FIREBASE_PRIVATE_KEY: "test-only-not-a-real-key",
      NEXT_PUBLIC_FIREBASE_API_KEY: "test-only-firebase-web-key",
      WHATSAPP_PHONE_NUMBER_ID: "",
      WHATSAPP_ACCESS_TOKEN: "",
      APP_URL: "https://app.example.invalid",
    },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      reporter: ["text-summary", "json-summary"],
    },
  },
});
