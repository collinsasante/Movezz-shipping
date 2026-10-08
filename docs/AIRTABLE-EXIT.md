# Airtable exit strategy

**Decision (owner):** Airtable is being discontinued. PostgreSQL is the permanent system of record.
**After cutover the production app must not need Airtable credentials, the Airtable API, or Airtable data.** There is no permanent fallback, no dual-write and no runtime dependency. Airtable may be kept (a) during the transition and (b) for a separately approved, time-limited export/archive period. Neither is a runtime dependency.

Status today: production is Airtable-backed and unchanged. The PostgreSQL backend (`MOVEZZ_DATA_BACKEND=postgres`) covers every route; nothing has been staged, imported or cut over. **Passing PostgreSQL tests is not Airtable independence** – see the exit criteria (§5).

## 1. Target architecture
- `MOVEZZ_DATA_BACKEND` goes away: one backend, PostgreSQL. No `airtable` package, no `src/lib/airtable.ts`, no `AIRTABLE_*` variables anywhere (code, CI, Cloudflare, `.env.example`, docs).
- Identity: Firebase Auth → `users` row → signed actor assertion → RLS. Money: invoices/payments/FX in PostgreSQL only. Keepup: worker-driven sync state machine. Images: Cloudinary (not Airtable attachments). Notifications: e-mail (Resend) and WhatsApp (`src/lib/whatsapp.ts`), both independent of the data store.

## 2. Dependency inventory

### 2a. Temporary transition dependencies (safe to leave until staging is validated; all removed at cutover)
| Area | Where | Notes |
|---|---|---|
| Airtable data layer | `src/lib/airtable.ts` (all APIs, `TABLES`, retry/paging) | Only module that talks to Airtable besides the two below. |
| API routes with an Airtable branch | 34 route files under `src/app/api/**` | Each already dispatches `isPostgresBackend()` → `src/lib/pg-routes/*` **first**; the Airtable branch is dead code when the flag is `postgres`. Pinned by `tests/unit/airtable-boundary.test.ts`. |
| Auth lookup | `src/lib/auth.ts` (`usersApi`, `customersApi`) | PostgreSQL path: `pgAuthContext`. |
| Reports route | `src/app/api/reports/route.ts` | Own Airtable REST client reading `AIRTABLE_API_KEY/BASE_ID`; PostgreSQL dispatch first. |
| Admin bootstrap | `scripts/bootstrap-admin.mjs`, `scripts/lib/bootstrap-admin.mjs` | Replaced by `scripts/db-bootstrap-admin.mjs`. |
| Env / CI | `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID` in `.github/workflows/deploy.yml`, `.env.example`, `README.md`, `DEPLOYMENT.md`, `vitest.config.mts` | Only the live Airtable app needs them. |
| Tests treating Airtable as the system of record | `tests/characterization`, `tests/integration`, `tests/security` (Airtable-mode), `tests/helpers/fakeAirtable.ts`, `tests/unit/fakeAirtable.test.ts`, `tests/security/bootstrap-admin.test.ts` | They protect the live app until cutover; deleted with the code they cover (PostgreSQL equivalents exist in `tests/db`). |
| Importer inputs | `scripts/db-import.mjs`, `scripts/lib/import/*` | Reads an *exported snapshot file*; never calls the Airtable API and refuses `AIRTABLE_*` in its environment. One-time migration tool, not a runtime dependency. |

### 2b. Post-cutover blockers (must be resolved with evidence before Airtable is retired)
1. **Item photos stored as Airtable attachments.** Airtable re-hosts uploaded images on `v5.airtableusercontent.com` (expiring URLs; CSP allows that host in `src/middleware.ts`). The importer tags each photo `storage_provider` = `cloudinary | airtable | other`. Every `airtable` photo must be re-hosted (Cloudinary) or explicitly excluded by the owner before Airtable access ends. *Count:* `SELECT storage_provider, count(*) FROM item_photos GROUP BY 1;` on staging. No re-host tool exists yet (needs Cloudinary credentials and real export; cannot be built/tested without them).
2. **Financial history not provable from Airtable** – see §3 (owner decision).
3. **Users / PendingRegistrations** are deliberately not imported: staff and customer logins are created/linked in PostgreSQL (`db-bootstrap-admin`, `POST /api/customers/[id]/link-login`). Needs a per-user activation plan on staging.
4. **Deployed-bundle Postgres connectivity** from Cloudflare Workers is unverified (staging project required).
5. **Remove the Airtable code** (§6) and prove the app boots and works with credentials absent and the API unreachable (`tests/db/airtable-independence.test.ts` proves the code path in tests; the staging deployment must prove it for real).
6. CSP `img-src` entry for `airtableusercontent.com`, UI copy mentioning Airtable (done: settings page), `DEPLOYMENT.md`/`README.md` Airtable sections.

### 2c. Resolved in this change
- Client/page code no longer imports `@/lib/airtable` (shared `SpecialRate`/`PackageRates` types now live in `@/types`; `airtable.ts` re-exports them).
- WhatsApp sender extracted to `src/lib/whatsapp.ts`; **parity gap closed on PostgreSQL**: item-status `sendWhatsApp` and the customer welcome message now send (best effort, after commit) instead of being silently ignored.
- Static guard `tests/unit/airtable-boundary.test.ts` (allow-list; PostgreSQL modules never import Airtable; PostgreSQL dispatch precedes Airtable calls) and runtime guard `tests/db/airtable-independence.test.ts` (no `AIRTABLE_*`, package stubbed to fail, API unreachable → core workflow passes with zero Airtable use).

Not found: dual-write, runtime fallback to Airtable from the PostgreSQL branch, Airtable use in `src/lib/keepup.ts`, middleware, `pg-routes`, `db`, workers, or `whatsapp.ts`.

## 3. Historical data (owner decision required)
Classification is per table, from what the importer can prove:

| Class | Tables / records | Treatment |
|---|---|---|
| **1. Verifiable – import** | Warehouses, Suppliers, PackageRates, SpecialRates, Settings (non-financial), Customers, Containers, Items (+photos where URL is durable), StatusHistory, ActivityLogs; Orders **that have a `Verified*` supplement** (VerifiedInvoices / VerifiedInvoiceLines / VerifiedPayments from a verified Keepup export with invoice/payment provenance) | Import on staging, reconcile, then production. Provenance kept in `legacy_*`/mapping tables. |
| **2. Needs more evidence** | Orders with no `Verified*` data (Airtable `InvoiceAmount/Discount/AmountPaid/BalanceDue` are currency-ambiguous: USD at creation, overwritten with GHS after Keepup); items with `airtable`-hosted photos; any quarantined row | Stay quarantined (fail-closed). Resolve only by supplying evidence (new snapshot / Keepup export) or an owner-approved `excluded` decision (append-only, `scripts/db-quarantine.mjs`). |
| **3. Excludable from operations (owner approval + retention rules)** | Unverifiable financial history if Option B is chosen; stale Pending registrations; test/duplicate records | Not imported, **not deleted**. Held in the approved archive (§4). |

No FX rate, discount, payment or total is ever inferred. Users/PendingRegistrations: see §2b.3.

## 4. Option A vs Option B (neither may become a permanent Airtable dependency)
- **A – verified Keepup export:** all invoices/payments imported with provenance; PostgreSQL holds complete financial history; the archive of Airtable is only a backup copy. Needs: Keepup export (invoice no., amounts, payments, dates) matched to orders.
- **B – start PostgreSQL financial records at cutover:** operational data migrates; pre-cutover financial history is *not* in PostgreSQL. It must then live in an **approved, read-only, time-limited archive** (encrypted export of the Airtable base + Keepup invoices, with an owner, a retention period and a destruction date). Staff would look old invoices up in Keepup/the archive, not in Movezz; customer balances must be opened from a signed-off opening-balance list.
- **Recommended path to full Airtable retirement:** A where Keepup can supply the export; otherwise B with the archive/retention plan approved *before* cutover. Either way Airtable access ends at the end of the approved archive window.

## 5. Exit criteria – all required, evidence attached to `docs/CUTOVER-EVIDENCE.md`
1. Required operational data migrated and reconciled (importer `reconcile` clean; quarantine empty or every row `excluded`/corrected with owner approval).
2. Financial records and balances verifiable (Option A reconciliation, or Option B opening balances + archive).
3. Every customer and staff workflow runs on PostgreSQL in staging (browser run: `scripts/ui-staging`).
4. Auth, authorization, tenant isolation and account activation work (all staff + customer accounts activated/linked).
5. Keepup (sandbox, then production-verified) and Cloudinary integrations work; no `airtable`-hosted photos remain.
6. Backups and a restore tested (`docs/SECRETS-AND-BACKUPS.md`).
7. Monitoring, recovery and rollback ready (rollback = previous Pages deployment + Airtable still intact until step 9).
8. Production cutover performed with the user's explicit approval.
9. App verified running with `AIRTABLE_*` removed and api.airtable.com unreachable (staging first, then production after cutover).
10. Approved archival and retention plan exists for anything not migrated.
Only after all ten: revoke Airtable tokens, run the removal list (§6), and let the archive window lapse.

## 6. Cutover removal task list (do NOT do before staging validation)
1. Delete `src/lib/airtable.ts`, the Airtable branch and imports in the 34 routes and `src/lib/auth.ts`, `MOVEZZ_DATA_BACKEND` / `isPostgresBackend` and `src/lib/backend.ts`; make `pg-routes` the route bodies. Empty the allow-list in `tests/unit/airtable-boundary.test.ts` (it then asserts *no* importers and no `airtable` dependency).
2. Remove the `airtable` package from `package.json`; delete `scripts/bootstrap-admin.mjs`, `scripts/lib/bootstrap-admin.mjs`, Airtable-mode tests and `tests/helpers/fakeAirtable.ts`.
3. Remove `AIRTABLE_*` from `deploy.yml`, GitHub/Cloudflare secrets, `.env.example`, `vitest.config.mts`, `README.md`, `DEPLOYMENT.md`; delete/archive `AIRTABLE_SCHEMA.md`; drop `airtableusercontent.com` from the CSP.
4. Keep the importer and `docs/MIGRATION-IMPORT.md` only if re-runs are still needed; otherwise move to the archive with the snapshot fingerprint record.
5. Revoke the Airtable API tokens; confirm the deployed app is unaffected.

## 7. Shortest sequence
1. **Now (owner):** choose Option A/B; provide authorized Airtable export + fingerprint; provision staging PostgreSQL (owner + `movezz_app` roles, TLS, exact DB name), staging Cloudflare Pages project, test Firebase accounts, Keepup sandbox, Cloudinary test credentials.
2. Follow `docs/STAGING-CHECKLIST.md` (dry-run → import → reconcile → bootstrap admin → browser run → deployed-bundle test).
3. Re-host/resolve `airtable` photos; resolve quarantine; activate/link users.
4. Staging run with Airtable credentials removed (criterion 9); backup/restore test.
5. Owner approves cutover (`docs/CUTOVER-CHECKLIST.md`): production import → switch → verify.
6. After the approved stabilization window: §6 removal, token revocation, archive handling, retire Airtable.
