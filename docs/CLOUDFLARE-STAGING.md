# Cloudflare staging deployment (prepared, NOT performed)

**Status: BLOCKED — no staging Cloudflare project, credentials or staging PostgreSQL endpoint are available in this environment** (no `CLOUDFLARE_*`/`CF_*` variables, no wrangler login, no `DATABASE_URL`). Nothing was deployed anywhere; production Cloudflare was not contacted.

## What the code does today (VL = verified locally, RPV = requires Cloudflare verification)
| Topic | State |
|---|---|
| Backend / DB settings are read from `process.env` **and** from the Worker context (`src/lib/env.ts`): `MOVEZZ_DATA_BACKEND`, `DATABASE_URL`, `DATABASE_SSL`, `ACTOR_CONTEXT_KEY`, `REGISTRATION_THROTTLE_PEPPER`, `MOVEZZ_LOG` | VL (unit tests). Needed because `process.env` is only populated after the first request on this project's compatibility date. |
| Connections never outlive a checkout on Workers (`maxUses: 1`) | VL in workerd (the shared pool hangs the second request) |
| Optional Hyperdrive binding `HYPERDRIVE` is used when `DATABASE_URL` is absent | VL (unit); RPV on Cloudflare |
| Raw TCP from the OpenNext bundle: `pg` needs `pg-cloudflare`, which exports its socket implementation only under the **`workerd` condition**; `open-next.config.ts` has `useWorkerdCondition: false`, so the live build resolves it to an empty module | RPV — **unverified**. A standalone Worker (`scripts/cf-pg-probe`) with the default workerd condition connects (VL in workerd). |
| Hyperdrive does not remove the need for sockets inside the Worker (the Worker still speaks the PostgreSQL protocol to Hyperdrive through `pg`), so the `workerd` condition question applies to both paths | analysis |

Supported architecture with the existing dependencies: **Worker → `pg` (+ `pg-cloudflare`) → Hyperdrive (or a TLS endpoint) → PostgreSQL.** No other database technology is proposed.

## Procedure once staging exists (owner provides: a Cloudflare account/project that is *not* the live one, a staging PostgreSQL with TLS reachable from Cloudflare — or a Hyperdrive config for it)
1. Staging database: create a fresh database, `MIGRATION_DATABASE_URL=… node scripts/db-migrate.mjs up && … grants`, `SELECT movezz_sec.set_actor_key(…)` with a **staging-only** random key, bootstrap a staging admin (`scripts/db-bootstrap-admin.mjs`), seed fictional data only (`scripts/ui-staging/seed.sql`).
2. Probe first (no app code): `cd scripts/cf-pg-probe && wrangler deploy` to a *staging* account with `wrangler secret put DATABASE_URL`; `curl https://<probe>/probe` must return `{"ok":true…}`; run `/pool?mode=fresh` several times. Delete the probe afterwards.
3. App bundle: `opennextjs-cloudflare build --openNextConfigPath open-next.staging.config.ts` (workerd condition ON; the live config is untouched), then `wrangler deploy --config wrangler.staging.toml`. Set secrets with `wrangler secret put` (never in files). If the build with the live condition (`false`) also connects, record that — it decides whether production's config must change at cutover.
4. Smoke (one authenticated read, one harmless write): sign in with a **staging** Firebase project, `GET /api/dashboard/admin`, create a supplier, read it back; check `wrangler tail` for errors and for any credential in logs; confirm no request reached Airtable (`Airtable is disabled` would appear if it did).
5. Record Worker runtime, OpenNext configuration, PostgreSQL connectivity, authenticated route and result in `docs/CUTOVER-EVIDENCE.md`; `wrangler delete` the staging Worker, rotate the staging secrets.

## Hard rules
Staging credentials only; never the live Pages project, DNS or production variables; never a production database URL (the probe and the importer refuse production-looking names); no destructive SQL in the probe.
