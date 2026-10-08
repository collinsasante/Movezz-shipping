# Cutover evidence (Phases 7M–7N)

Status vocabulary: **PASS** / **BLOCKED** / **NOT TESTED** / **NOT APPLICABLE** (FAIL if a check failed). Environments used below: *local* (unit tests) · *local PostgreSQL* · *local workerd* · *local browser* (Chromium + the app on the PostgreSQL backend) · *staging PostgreSQL* (none exists) · *Cloudflare staging* (none exists) · *production* (never touched). Environments, strongest first:
*production* (never touched) · *Cloudflare staging* (none available) · *real Airtable export* (none available) · *staging-like local* (local PostgreSQL 16 + local workerd/Chromium, fictional data, mocked Firebase/e-mail/Keepup) · *unit/route tests*.
Production remains **not verified**; nothing below was run against production or with production credentials.

| # | Blocker | Status | Environment |
|---|---|---|---|
| 1 | Real Airtable-export rehearsal | **BLOCKED** | none (no export in the repository) |
| 2 | Browser/UI against PostgreSQL | **PASS** (admin/staff/customer core flow) with findings | staging-like local |
| 3 | Cloudflare Workers → PostgreSQL | **PASS in local workerd for the probe; BLOCKED for the real app bundle and Cloudflare staging** | local workerd |
| 4 | Customer login linking | **PASS** (operation + tests); operator workflow documented | route tests |
| 5 | First admin / secrets / backups | **PASS** (tooling) · **NOT TESTED** (production secret store, encrypted backups) | local |
| 6 | Payment idempotency at the UI/API boundary | **PASS** | route tests + browser |
| 7 | Historical-data decision (Option A / B) | **BLOCKED — business decision** | — |

## 1. Real Airtable-export rehearsal — BLOCKED
Evidence: the repository holds only generated fixtures (`tests/fixtures/migration/synthetic-*.json`, `realistic.mjs` — kind `fixture`, derived from `src/lib/airtable.ts`). No sanitised or approved export exists; the importer refuses a real `export` outside staging with `MOVEZZ_IMPORT_ALLOW_EXPORT=1`, and I did not (and may not) read the live Airtable base.
**Needed from the owner:** a read-only export of the Airtable base in the snapshot format (`docs/MIGRATION-IMPORT.md` §2), taken by an authorised person, stored outside the repository, plus approval to run it in a staging database.
What WAS run (fixture, not real data, scale 1x, `--verified partial`): 62 customers, 400 items, 90 orders, 8 containers in; dry-run wrote nothing; import 2.1 s (520 rec/s); reconcile 44/44; second import added 0 rows and left an identical fingerprint; `pg_dump` (signing keys excluded) restored into a new database with 17 migrations, equal signature and 44/44 reconciliation; the restored database holds 0 actor keys. Verdict NOT_READY because 60 of 90 orders have no verified financials (quarantined, not guessed). → *verified on a fixture only.*

## 2. Browser/UI — PASS with findings (`scripts/ui-staging/*`, Chromium, PostgreSQL backend, local)
Harness: fake Google identity stand-in for the browser and the server (no Firebase project), fictional seed, `scripts/ui-staging/reset.sh` + `start.sh` + `ui-run.mjs crawl|flow`.
* **Crawl**: 18 admin, 10 staff, 7 customer pages load with no JavaScript errors and no unexpected API errors. The only 4xx are the intended denials (staff → orders/reports/users: 403; customer reaching `/admin` is redirected to `/customer`).
* **Flow (all PASS)**: invoice form sums the server-priced items ($1,050 → GHS 13,125.00 at the frozen 12.5); the creator shows as an e-mail; a **double-clicked payment records once**; Partial then Paid with correct GHS balances; items cannot ship without a container; dashboard and report show the revenue; a customer sees and opens only their own invoice; another customer gets 404; **cancelling from the real screen** (which first calls `DELETE …/create-invoice`) cancels the invoice, keeps it as Cancelled and releases the item.
* **Bugs found and fixed**: creator shown as an internal id; a bare `0` rendered under the totals (discount was `0` instead of absent); the payment panel was hidden for orders without a Keepup sale; the cancel screen failed because `DELETE create-invoice` was refused (now a no-op).
* **Findings not changed (need a product decision, no code guessed)**: (a) warehouse staff still see the *Invoices*, *Reports* and *Staff* menu entries; they open empty because the API correctly denies them (D6) — hide them for staff at cutover; (b) after an invoice is issued the *Edit* screen can no longer change amount/discount/date (immutability): a discount must be given **when the invoice is created**, and the new-invoice form has no discount field — add one or accept cancel-and-reissue; (c) the *Record Payment* button stays visible on a Paid invoice (same as Airtable mode; the server refuses overpayment).
* Not exercised in the browser: Keepup screens (the worker is mocked/disabled), file upload (Cloudinary), the customer-creation form (needs Firebase Admin), repacking and container forms (covered by route tests only).

## 3. Cloudflare Workers → PostgreSQL
* **PASS (local workerd)**: `scripts/cf-pg-probe` (separate staging-only Worker, read-only `SELECT`, 5 s timeouts, request id in logs, no credentials in logs, refuses production-looking targets) connected to local PostgreSQL through workerd's TCP sockets and returned `ok`. Run: `DATABASE_URL=<staging url> npm run cf:probe`.
* **Finding (reproduced)**: a module-level connection pool **hangs the Worker on the second request** ("Worker's code had hung"); `maxUses: 1` pools work, including 3 concurrent requests. `createPool()` now uses per-checkout connections when `navigator.userAgent === "Cloudflare-Workers"` (unit-tested; Node behaviour unchanged).
* **BLOCKED — not verified for the real app**: `open-next.config.ts` has `useWorkerdCondition: false`, so `pg-cloudflare` resolves to `empty.js` in the OpenNext bundle (confirmed in `node_modules/pg-cloudflare/package.json`). Whether the deployed bundle can open a socket cannot be shown without a Cloudflare staging deployment; running the built `.open-next/worker.js` in plain `wrangler dev` failed for packaging reasons (`preview-props.json`), unrelated to PostgreSQL, because production uses `scripts/cf-pages-deploy.mjs`.
* **Minimum action** (needs Cloudflare staging access and approval, no architecture change): deploy the app to a staging Pages project with a staging PostgreSQL reachable from Cloudflare (Hyperdrive binding recommended, or a public TLS endpoint with an IP allow-list), set `MOVEZZ_DATA_BACKEND=postgres`, `DATABASE_URL`, `ACTOR_CONTEXT_KEY`, and call one authenticated route. If sockets fail, test `useWorkerdCondition: true` in staging first. Do **not** change that flag for the live Airtable deployment before the test.

## 4. Customer login linking — PASS
`POST /api/customers/[id]/link-login` (PostgreSQL backend, super_admin only). Tests (`tests/db/pg-routes-identity.test.ts`): needs a super_admin; body is exactly `{firebaseUid}` (any other key → 400); the identity is re-checked with Firebase and must have a **verified e-mail**; the customer must be active; one login per customer and one identity per user — a second customer, a second login or a used e-mail → 409, never merged; repeating the same link → 200 `alreadyLinked`; audited (`user.create`) with the verified actor; the customer can then sign in. No e-mail matching, no automatic claim, no revival of inactive customers.
**Operator workflow (cutover day)**: 1. the customer creates their own Firebase login (own password or Google) and verifies the e-mail; 2. a super_admin confirms out of band (phone/WhatsApp call to the number on file, invoice reference, etc. — the owner defines the check) that this person owns the customer record; 3. the super_admin sends the customer's Firebase uid (Firebase console) to `link-login` for that customer; 4. the customer signs in; 5. conflicts (409) are resolved by a person, case by case. Staff are created with `POST /api/users`; the first administrator with `scripts/db-bootstrap-admin.mjs`.

## 5. First admin, secrets, backups
* PASS (local): bootstrap needs the owner connection, a confirmed host, a valid e-mail and Firebase uid, creates no password, refuses duplicates (`tests/db/pg-bootstrap-admin.test.ts`). `ACTOR_CONTEXT_KEY`: production refuses a missing/short/non-random key (7K). Import actor key is separate and retired after import (documented 7K §6). Backups exclude `movezz_sec.actor_keys` (rehearsal: 0 keys after restore) and are restored with a freshly provisioned key.
* NOT TESTED: the production secret store, encrypted backup storage, backup access control, restore on the production host.

## 6. Payment idempotency — PASS
UI: one `Idempotency-Key` per intentional payment (new key if the amount changes or after success); invoice creation likewise; the Save button is disabled while a request is in flight. Tests (`tests/db/pg-payment-idempotency.test.ts`): same key + same payload → one payment and same result (also for retries after success); same key + different payload → 409; 5 concurrent identical requests → exactly one payment; separate keys → two payments; overpayment still 422. Browser: a triple click recorded GHS 5,000 once.

## 7. Historical data — BLOCKED (business decision, not guessed)
Option A: a verified Keepup export carrying invoice and payment provenance (currency, discount, FX, GHS total, payments). Option B: leave unverifiable historical orders/invoices in the Airtable archive and operate PostgreSQL on new transactions after cutover (customers, items, containers, rates are still imported; orders stay quarantined with an owner-approved `excluded` resolution). No evidence for Option A exists; nothing was invented (no FX, discounts, payments, totals, cancellation reasons, statuses or ownership).

## Test matrix (this phase)
PostgreSQL 646/646 · Airtable 661/661 · `tsc` clean · ESLint 0 errors · build compiles. Secret scan of tracked files: only documented placeholders.


---

# Phase 7N additions

## Blocker audit (end of 7N)
| Blocker | Status | Engineering can close it? | Needs owner/business decision? | Needs staging infrastructure? |
|---|---|---|---|---|
| Staff navigation shows money/admin entries | **PASS** (local browser) | done | no | no |
| Invoice discount UI | **PASS** (local unit + local PostgreSQL route tests + local browser build) | done | no (backend rule already approved) | no |
| Keepup state shown honestly | **PASS** (local browser) — real Keepup **NOT TESTED** (mock only by design) | done for the UI | real-Keepup test needs owner approval | Keepup sandbox |
| Photo upload rules / ownership | **PASS** (local PostgreSQL); real Cloudinary upload **NOT TESTED** | done | no | Cloudinary staging |
| Registration → approval; duplicates; no first-user admin | **PASS** (local browser + route tests); activation in a browser **NOT TESTED** (needs a Firebase project) | partly | no | Firebase staging |
| Container UI | **PASS** (local browser) | done | no | no |
| Customer login linking | **PASS** (local PostgreSQL) | done | owner defines the out-of-band ownership check | no |
| Real Airtable-export rehearsal | **BLOCKED** | procedure + safety checks ready | **yes: supply and approve an export** | a staging PostgreSQL |
| Cloudflare Workers → PostgreSQL (real bundle) | **BLOCKED** | prepared (env lookup, Hyperdrive fallback, staging config); not deployable here | account/approval to create a staging project | **yes** |
| Production secrets / encrypted backups / restore host | **BLOCKED** (requirements verified locally) | tooling done | storage and custodians | **yes** |
| Historical data (Option A / B) | **BLOCKED — owner only** | no | **yes** | no |

## 7N results
* **Staff navigation — PASS (local browser).** Staff see Dashboard, Customers, Items, Containers, Repacking, Sorting, Settings; no Invoices/Staff/Reports (sidebar and mobile bar). `src/lib/nav.ts` + `tests/unit/nav.test.ts` (fails closed while the role is unknown). Security is unchanged: the API still answers 403 to direct calls. Note for Airtable mode: this navigation change ships only when this branch is deployed.
* **Invoice discount UI — PASS (local).** Only a super_admin sees the control (USD, reason required once > 0, subtotal/discount/total shown, helper `src/lib/discount.ts`); the server stays authoritative. Tests: `tests/unit/discount.test.ts` (no discount, valid, no reason, non-admin, larger than subtotal, equal to subtotal) and `tests/db/pg-routes-billing.test.ts` (server: reason missing → 422, too large → ≥400, negative → 400, staff → 403, issued discount cannot be edited → 409; a fully discounted invoice is checked against the locked zero-total rule).
* **Keepup UI — PASS (local browser, mock only).** An issued invoice shows "Synchronisation: waiting to be sent / No Keepup sale exists yet"; *Create Invoice* answers 202 and the screen says "Queued for Keepup", never "created"; no Sale ID is shown until the worker has one; only a super_admin may request or retry. Failed and needs-reconciliation labels are rendered from the same field (route tests cover the states); real Keepup **NOT TESTED**.
* **Photo upload — PASS (local PostgreSQL).** `tests/db/pg-routes-photos.test.ts`: signing needs staff/admin (401/403), folder traversal refused, only https + allowed hosts stored, customers cannot attach, the owner sees the photos, another customer gets 404/empty, replacement archives (not deletes), >20 refused. Cloudinary is mocked; **no Cloudinary call was made**. A real browser upload **NOT TESTED**.
* **Registration — PASS (local browser).** Public form → "Request Received"; the request is pending, no customer/login exists; admin *Approve* creates the customer with a generated mark and **no login**; a repeated request creates no second customer; exactly one super_admin remains. Activation with a real Firebase identity **NOT TESTED** (route tests exist, 7G).
* **Containers — PASS (local browser).** Five simultaneous creations → five distinct consecutive `PMX-CON-YYYY-NNN`; create via the form (container number vs. shipping line verified); Add Item dialog; an item in one container cannot join another; remove + move works; status change cascades advance-only; staff view but cannot create; customers get 403 and are redirected; a container with items cannot be deleted, an empty one is archived.
* **Customer login linking — PASS (local PostgreSQL).** 15 cases in `tests/db/pg-routes-identity.test.ts`: valid link, unverified identity, non-super_admin (staff and the customer's own token), unknown customer, identity already linked elsewhere (409), same identity again (200, no change), different identity for a linked customer (409), inactive customer (409), failed Firebase lookup (409, nothing linked), caller-supplied owner/extra keys (400), audit row, and the customer can then sign in.
* **Export rehearsal — BLOCKED.** Still no export. Added: `db-import.mjs fingerprint` and `--expect-fingerprint` (`tests/db/import-fingerprint.test.ts`), a runbook `docs/STAGING-REHEARSAL-RUNBOOK.md` covering receive-outside-repo → fingerprint → fresh staging DB → migrate → dry-run → quarantine review → import → reconcile → repeat → backup → restore → reconcile, and the safeguards that keep an export away from production.
* **Cloudflare — BLOCKED.** No staging project, credentials or staging PostgreSQL exist here, so nothing was deployed and production Cloudflare was not contacted. Found and fixed a second Workers problem besides the pool: `process.env` is not reliably populated on this compatibility date, so `MOVEZZ_DATA_BACKEND`, `DATABASE_URL`, `ACTOR_CONTEXT_KEY` etc. are now also read from the Worker context (`src/lib/env.ts`, unit-tested), with an optional `HYPERDRIVE` binding. `docs/CLOUDFLARE-STAGING.md` has the exact prerequisites and procedure; `open-next.staging.config.ts` (workerd condition on) and `wrangler.staging.toml` are staging-only and do not alter the live build. **Worker runtime / OpenNext configuration / PostgreSQL connectivity / authenticated route of the deployed bundle: NOT TESTED.**
* **Secrets and backups — BLOCKED for production, PASS for the checkable parts (local).** `docs/SECRETS-AND-BACKUPS.md`. No secret in tracked files or client bundles; logs redact; signing keys excluded from dumps; import key separate; bootstrap explicit. Encrypted backup storage, the production secret store and a production-host restore: **NOT TESTED**.
* **Historical data — BLOCKED, owner only.** Unchanged: Option A (verified Keepup export with invoice/payment provenance) or Option B (leave unverifiable history in the Airtable archive; PostgreSQL authoritative from cutover). Nothing reconstructed.
