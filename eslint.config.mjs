// ESLint 9 flat config (Next.js 16 removed `next lint`; `npm run lint` runs ESLint directly).
// Base: eslint-config-next core-web-vitals + typescript. Test files and tooling are linted with the same
// rules except where noted below.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react-hooks 7 added React-Compiler-era rules. They flag long-standing patterns (setState
    // inside effects, mutable timers in render) in ~40 places. Rewriting those changes component behavior, so
    // it is NOT part of the security remediation: they are reported as warnings and tracked in
    // docs/SECURITY-BASELINE.md ("ESLint"). Everything else stays at the shared config's severity.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/purity": "warn",
    },
  },
  {
    // The importer is plain .mjs (it runs as a CLI without a TypeScript runner). Its tests poke at loosely typed report objects and
    // deliberately hostile snapshots, so `any` is allowed in those test files only.
    files: ["tests/db/import-*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  globalIgnores([".next/**", ".open-next/**", "node_modules/**", "coverage/**", "out/**", "build/**", "next-env.d.ts", "public/**"]),
]);
