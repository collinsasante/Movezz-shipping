# Cutover checklist — NOTHING BELOW HAS BEEN PERFORMED IN PRODUCTION
Evidence per blocker (PASS/FAIL/BLOCKED/NOT TESTED, environment, result): `docs/CUTOVER-EVIDENCE.md`. Route status: `docs/ROUTE-MIGRATION.md`.

Labels: VL verified locally · RPV requires production verification · BDR business decision required · CO cutover-time action.
**Status after Phase 7L:** every Airtable-backed API route now has a PostgreSQL implementation behind `MOVEZZ_DATA_BACKEND=postgres` (`docs/ROUTE-MIGRATION.md`); production is still Airtable. Remaining blockers are business decisions (B1/B1b/B2) and production verification (Workers→PostgreSQL connectivity, real-export staging run, browser test of the UI on the PostgreSQL backend).

## 1. Blocker matrix
| Issue | Blocks cutover? | Why | Minimal solution |
|---|---|---|---|
| Remaining Airtable routes | **Resolved in code (VL)** | all 34 Airtable-backed routes ported (Phase 7L, `docs/ROUTE-MIGRATION.md`); the UI has not been exercised in a browser against PostgreSQL | browser/staging pass before cutover (RPV) |
| Historical financials (B1) | **YES (BDR)** | Airtable orders hold only an ambiguous `InvoiceAmount`; no currency, FX, discount or total is derivable, so the importer quarantines every order (fail-closed, VL) | Owner chooses the verified source (recommended: a Keepup export of invoices with currency, discount, FX and GHS total) and supplies `Verified*` data |
| Historical payments | **YES (BDR)** with B1 | Airtable has none; payments must not be fabricated | Same verified source; or import invoices only when the source gives payments |
| Operational data without orders | Does NOT block by itself | customers, items, containers, rates, settings import independently; orders are quarantined | Owner may approve "orders/invoices stay in Airtable as a read-only archive" and `excluded` resolutions (BDR) |
| Historical logins (B2) | No code blocker | The path exists and is tested (VL): a super_admin runs `admin_create_user` with a verified Firebase uid; registration deliberately refuses imported customers (MV015) so nobody can claim a customer by e-mail | CO runbook §5; owner approves how ownership is verified out of band |
| Quarantine (B4) | Resolved in code (VL) | `scripts/db-quarantine.mjs` + migration 0017: list, summary, append-only `excluded` / `corrected_in_new_snapshot` decisions with reason and actor; no data edits | Operators must resolve or accept every blocking row before import approval |
| Legacy carton tier (B3a) | No | Display metadata of historical cartons; derived from the customer's package and marked as derived; current pricing does not read it | Leave as is |
| Historical cancellation reason/time (B3b) | No | Airtable orders are never "Cancelled", so there is nothing to import; native cancellation is enforced going forward | Leave as is; owner is told cancelled history is not in Airtable |
| Production backup | **YES (CO)** | Plain dumps contain `movezz_sec.actor_keys` (VL finding) | Policy in §6 |
| Actor signing key | **YES (CO)** | Disposable keys are fine for staging only | Production refuses a missing, short or non-random key (VL, `actorKeyFromEnv`); provisioning from a secret store is an RPV deployment requirement (§6) |
| PostgreSQL connectivity from the Workers runtime | **YES (RPV)** | The app uses `pg` with `DATABASE_URL`; connectivity from Cloudflare Workers (e.g. a pooled/Hyperdrive endpoint) was never verified | Verify in staging before any cutover |

## 2. Cutover dependency map
| Dependency | Current source | Target | Cutover change? | Status |
|---|---|---|---|---|
| Registration, admin registrations, activate, onboard | PostgreSQL | PostgreSQL | no | VL |
| All other business routes (see §3) | Airtable | PostgreSQL | **yes** | not done |
| Auth (Firebase) | Firebase (verify route is Airtable-user based) | Firebase uid → `users` row | yes | partly (4 routes) |
| Keepup | live Keepup via Airtable route | mock gateway + worker, disabled by default | enable CO, after a controlled test | VL (mock only) |
| E-mail / WhatsApp | direct | outbox + worker, mock sender | enable CO | VL (mock only) |
| Cloudinary (`upload/sign`) | Cloudinary | unchanged | no | unchanged |
| Cloudflare / OpenNext | Pages/Workers | unchanged | env vars `DATABASE_URL`, `ACTOR_CONTEXT_KEY`, flags | RPV |
| Workers (keepup, outbox) | n/a | scheduled, disabled by default | enable CO | VL |

## 3. Airtable routes (classification derived from route names — owner to confirm the deferrable and dead sets)
* **Required for cutover:** items (+status, history), containers (+items, status, sync-items), cartons, sorting, orders (+create-invoice), customers, users, warehouses, suppliers, package-rates, special-rates, settings, dashboard/admin, dashboard/customer, auth/verify, auth/verify-cookie.
* **Can be deferred (if the owner agrees):** reports, activity-logs, orders/keepup-sync (stays disabled at cutover).
* **Dead/legacy candidates:** auth/signup and auth/reset-password if registration/Firebase now replace them (owner to confirm).
* Port only the repository calls; keep the UI and business behaviour; reuse `src/lib/db/*` (ownership, invoices, pricing, registration).

## 3b. Phase 7N status (details and environments in `docs/CUTOVER-EVIDENCE.md`)
PASS (local / local browser): staff navigation, invoice discount UI, Keepup state display, photo rules, registration, containers, customer login linking.
BLOCKED: real-export rehearsal (needs an export + staging PostgreSQL), Cloudflare staging test of the deployed bundle (`docs/CLOUDFLARE-STAGING.md`), production secrets/encrypted backups (`docs/SECRETS-AND-BACKUPS.md`), historical-data decision (owner only).

## 4. BEFORE CUTOVER
- [x] VL: migrations 0001–0019 (0018: photo re-host log; 0019: Keepup payment/cancel propagation), photo re-host tool, importer, reconciliation, rehearsal 1x–10x, backup/restore, identity chain, mock workers, quarantine resolution, production key validation
- [ ] Port the REQUIRED routes (§3) and re-run the characterization suite against PostgreSQL
- [ ] BDR: verified financial/payment source (B1) or approval of the "orders stay archived" option
- [ ] BDR: how ownership of each customer is verified before a login is linked (§5)
- [ ] RPV: staging run on a real read-only Airtable export (staging + `MOVEZZ_IMPORT_ALLOW_EXPORT=1`), then every blocking quarantine row resolved or accepted
- [ ] RPV: Workers → PostgreSQL connectivity, real volume and duration
- [ ] Backup and secrets policy applied (§6); workers configured but disabled; rollback plan rehearsed

## 5. Customer login linking (Phase 7M: `POST /api/customers/[id]/link-login`; evidence and operator workflow in `docs/CUTOVER-EVIDENCE.md` §4)
For each customer who should log in: (1) the customer creates a Firebase identity themselves (no passwords or accounts are created by Movezz); (2) a super_admin verifies ownership out of band (the owner defines how); (3) the super_admin runs `admin_create_user(customer, firebase uid, role=customer)` through the authenticated admin path. Inactive customers stay refused; e-mail alone is never trusted; the client never supplies a customer id; the action is audited by the actor stamp.

## 6. Backup and key policy (CO; RPV where noted)
* Backups: encrypted at rest with a key stored apart from the backup; access limited to named operators; take them with `pg_dump --exclude-table-data=movezz_sec.actor_keys` (VL: restored DB has 0 keys) or treat the whole dump as secret-key material.
* After a restore, provision a fresh actor key (`movezz_sec.set_actor_key`) before the app can act; verify schema, counts and reconciliation (VL procedure).
* Keys: random ≥32 bytes from the platform secret store (never in Git/env files); one key for the app, a separate one for the import (retired with `movezz_sec.retire_actor_key` after import); rotate on suspicion. The production secret manager was not available here, so this is a deployment requirement, not a verified fact (RPV).

## 7. DURING CUTOVER
Announce the maintenance window; make Airtable read-only (freeze) and take the final read-only export; offline dry-run; resolve/accept quarantine; business approval; import; reconcile; create customer logins (§5); switch the application and env vars; smoke tests (login per role, item list, invoice, payment); monitor logs (`MOVEZZ_LOG=json`).

## 8. AFTER CUTOVER
Customer login and ownership checks; invoice and payment checks; warehouse workflows; enable Keepup and notification workers only after a controlled test; error and reconciliation monitoring; decide on rollback within the agreed window (redeploy the previous build, repoint DNS, keep Airtable untouched; the database is forward-only, so restore from backup rather than reverse migrations).

## 9. PRODUCTION ACTIONS NOT PERFORMED
Production export, import, migration, DNS, environment variables, Firebase/Keepup/Cloudinary/Cloudflare access, deployment, merge, traffic switch, Airtable shutdown.

## 10. Procedure
The step-by-step cutover and rollback procedure with approval gates is `docs/CUTOVER-RUNBOOK.md` (documented, not executed, not proven in staging).
