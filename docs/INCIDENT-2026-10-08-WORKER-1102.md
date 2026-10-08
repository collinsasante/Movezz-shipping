# Incident 2026-10-08 — Cloudflare Worker Error 1102 on ship.gomovezz.com

**Status: OPEN — root cause NOT established. Production was not inspected, changed, rolled back or deployed by this session.**

| Field | Value |
|---|---|
| Incident | Cloudflare Worker Error 1102 ("Worker exceeded resource limits") |
| Ray ID | a4786691efe89342-ACC |
| First observed | 2026-10-08 21:57:20 UTC (reported by the owner) |
| Production hostname | ship.gomovezz.com |
| Production backend | Airtable (expected; **not verified** — no access to the Worker's variables/bindings) |
| Affected route | unknown (the report names the site, not a route) |
| Last known-good commit | **unknown** — needs the Cloudflare deployment list (see below). The repository's newest `main` commit is `3d615c4` (2026-09-15 21:33 UTC). |
| Current production commit | **unknown** — cannot be read from this environment |
| Deployment immediately preceding the incident | **unknown** from Cloudflare; from GitHub see "Verified from the repository" |
| Resource exceeded | **unknown** (CPU time, memory or another limit — Cloudflare logs needed) |
| Root cause | **not established; no hypothesis is asserted** |
| Fix / rollback required | undecided |
| Production data modified | NO (by this session; nothing was accessed) |
| Production environment modified | NO (by this session) |

## Why the investigation stopped (hard-stop conditions met)
* **No Cloudflare access**: no API token, account id, wrangler login or log access exists in this environment, so the deployed commit, deployment history, variables/bindings, `wrangler tail` output and the Ray ID cannot be read.
* **The live site is unreachable from here**: every request to `https://ship.gomovezz.com` (including `/api/health`) returns `403 Forbidden` with a 75-byte `text/plain` body *from the sandbox's egress proxy*, not from Cloudflare (no `cf-ray` header, not an HTML 1102 page). So no live route could be tested; this says nothing about the site's health.
* Therefore "what exactly is running" cannot be proven, and a rollback target cannot be named safely. Per the incident rules nothing was guessed or changed.

## Verified from the repository (facts only)
1. `.github/workflows/deploy.yml` deploys **only on push to `main`**; `ci.yml` (all other branches) has no secrets and no deploy step.
2. `origin/main` was fetched at 2026-10-08 ~21:58 UTC: tip `3d615c4` (2026-09-15), **the same commit that has been main throughout the PostgreSQL work**. No commit reached `main` near the incident, and none of the Phase 7 commits (`feature/postgres-foundation`, tip `5a6a7d0`) is on `main`.
3. The default for the PostgreSQL work is Airtable (`MOVEZZ_DATA_BACKEND` unset ⇒ Airtable); nothing on `main` reads `DATABASE_URL`, `ACTOR_CONTEXT_KEY` or a Hyperdrive binding. The recent Worker-environment changes (`src/lib/env.ts`, pool options) exist only on the feature branch.
4. **Not excluded**: a separate Cloudflare Pages *Git integration* (the repo has `npm run ci:build`, "Cloudflare Pages handles deployment itself") could build other branches or a different production branch than `deploy.yml` suggests; and a manual `npm run cf:deploy` from a developer machine would bypass GitHub entirely. Whether either happened is **unknown** and must be read from Cloudflare.
5. Statements in earlier phase reports that "production was not touched" are about *this session's* actions (no credentials were ever available here). They are not evidence about what other people or integrations deployed.

## What the owner/operator must check in Cloudflare (read-only first)
1. **Workers & Pages → the Pages project → Deployments**: which deployment is "Production", its commit hash/branch, time, and who/what triggered it (Git integration vs. wrangler/CI). Compare the timestamp with 21:57 UTC and look for a deployment in the preceding hours or days. Note the previous successful deployment.
2. **Settings → Builds & deployments**: production branch (must be `main`), build command (`npm run ci:build` or equivalent), and **Preview deployments** settings.
3. **Settings → Variables and Secrets / Functions → Bindings (Production)**: confirm `MOVEZZ_DATA_BACKEND` is **absent or `airtable`**, no `DATABASE_URL`/`HYPERDRIVE`, `AIRTABLE_*` present. Also Compatibility date / flags and "Usage model"/CPU limit.
4. **Logs**: Real-time Logs or `wrangler pages deployment tail` (and Workers Observability → filter by Ray ID `a4786691efe89342`). For the failing request record: URL path, method, CPU time, wall time, subrequest count, response status, exception. The 1102 page appears for *CPU time*, *memory* or *subrequest-related* limits — the logs decide which.
5. **Which routes fail** (safe GETs only): `/`, `/login`, `/api/health`, one static asset, one dashboard page. Universal failure points to the Worker bundle/initialisation or a platform issue; a single route points to that route's data processing.
6. **Cloudflare status page** for an incident in the same window.
7. **Recovery when a deployment is the cause**: in the Deployments list use **"Rollback to this deployment"** on the last known-good production deployment (the established Pages mechanism) — no code change and not the feature branch.

## Candidates that analysis cannot yet confirm or exclude (hypotheses, not findings)
These are properties of the Airtable-backed code on `main` that scale with data volume, so a *data-growth* cause is possible even with no deployment; none has been shown to be involved:
* `dashboardApi.getAdminStats` reads whole Customers, Items, Containers and Orders tables on each admin dashboard load; `/api/reports` reads whole Orders, Customers and Items; `/api/items` and `/api/orders` load every record and slice in memory; `activity-logs` reads the whole log table.
* The Airtable client retries/paginates inside the Worker; many sequential pages count as subrequests and CPU.
Only the Cloudflare log for the Ray ID can tell whether any of this is relevant. If it is, the fix belongs on a dedicated incident branch cut from the deployed commit, limited to that route (e.g. fetching only needed fields/pages), tested against a production-equivalent *fake Airtable* (`tests/unit/fakeAirtable.test.ts` pattern) and deployed only after approval.

## Verification performed
Repository-only (above). **No** production request succeeded, **no** Cloudflare or Airtable access, **no** write of any kind outside this repository's documentation.

## Remaining risk
The live site stays down/degraded until the deployment history is read and, if a deployment is implicated, rolled back in the Cloudflare dashboard. Until Cloudflare confirms the production Worker has no PostgreSQL variables, treat "production is Airtable-only" as *expected but unproven*.

## Regression protection (proposed, to be built once the cause is known)
* A CI check that fails if `MOVEZZ_DATA_BACKEND`/`DATABASE_URL`/`HYPERDRIVE` appear in `wrangler.toml` or `deploy.yml`.
* A deploy-time smoke test (`/api/health`, `/login`) with automatic rollback on 1102/5xx.
* Cloudflare alert on 1102/5xx rate; record CPU time per route.
