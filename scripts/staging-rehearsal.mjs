#!/usr/bin/env node
// Repeatable staging rehearsal on a DISPOSABLE non-production PostgreSQL (see docs/MIGRATION-IMPORT.md, "Staging rehearsal").
//   MOVEZZ_REHEARSAL_ADMIN_URL=postgres://postgres@127.0.0.1:54329/postgres node scripts/staging-rehearsal.mjs [--scale 1,2,5,10] [--verified none|partial] [--repeat 2]
// Creates databases named mvz_rehearsal_*, imports a generated REALISTIC (source-code-derived) snapshot, reconciles, backs up, restores, verifies,
// drops everything, and prints one JSON metrics object per cycle. It never reads any env var of a live integration (the guard refuses if one is set).
import { rehearse } from "./lib/rehearsal.mjs";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.env.MOVEZZ_REHEARSAL_ADMIN_URL;
if (!url) { console.error("MOVEZZ_REHEARSAL_ADMIN_URL is required (a superuser URL on a local / non-production server)"); process.exit(1); }
const scales = arg("--scale", "1").split(",").map(Number); const repeat = Number(arg("--repeat", "1")); const verified = arg("--verified", "none");
try {
  for (let r = 0; r < repeat; r++) for (const scale of scales) {
    const m = await rehearse({ adminUrl: url, scale, verified, environmentClass: process.env.MOVEZZ_IMPORT_ENVIRONMENT ?? "local" });
    console.log(JSON.stringify(m));
  }
} catch (e) { console.error(`rehearsal failed: ${e.message}`); process.exit(1); }
