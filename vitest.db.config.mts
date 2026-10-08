import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// PostgreSQL integration tests. They need a disposable PostgreSQL 16 server:
//   scripts/db-local.sh start && npm run test:db          (or point MOVEZZ_TEST_PG_URL at any LOCAL throwaway server)
// Each test file creates its own empty database, applies db/migrations from scratch, and drops it afterwards.
// tests/db/helpers.ts refuses any non-local host. Without MOVEZZ_TEST_PG_URL the suites are skipped (and say so).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: "test", TZ: "UTC" },
  },
});
