# Cutover and rollback runbook — Airtable → PostgreSQL

**Status: DOCUMENTED, NOT EXECUTED, NOT PROVEN IN STAGING.** Nothing in this file has been run against staging or production. Every step marked *proven locally* was exercised only on disposable local databases with fictional data. Production (`ship.gomovezz.com`) is Airtable-backed and stays so until the Cutover Authority approves the final go (Gate G12).

Labels used below:
- **[repo]** command or behaviour confirmed in this repository (path given).
- **[operator]** value, tool or action the operator must supply; the repository does not contain it.
- **[GATE]** a mandatory approval or decision. If it is not recorded in writing, stop.
- **[UNKNOWN]** the repository cannot tell; it must be established (usually in staging) before it is relied on.

Related: `docs/STAGING-CHECKLIST.md` (rehearsal, the source of truth for every command used here), `docs/AIRTABLE-EXIT.md` (exit criteria), `docs/CUTOVER-CHECKLIST.md` (blockers), `docs/CUTOVER-EVIDENCE.md` (evidence log), `docs/SECRETS-AND-BACKUPS.md`, `docs/CLOUDFLARE-STAGING.md`.

## 0. Roles
| Role | Who | Notes |
|---|---|---|
| Cutover Authority | **[operator]** the owner named in writing | only person who can approve Gate G12 (go) |
| Rollback Authority | **[operator]** named in advance (default: the Cutover Authority) | only person who can order a rollback after PostgreSQL has accepted real writes (§8) |
| Operator(s) | **[operator]** | run commands; two people for steps that write to the production database |
| Key custodian | **[operator]** different person from the database administrator | holds the backup decryption identity (`age`) |

## 1. Preconditions and approval gates
All must be recorded (who, when, evidence link) in `docs/CUTOVER-EVIDENCE.md`. A gate that is not PASS blocks the cutover; none can be waived by an operator.

| Gate | Requirement | Status today |
|---|---|---|
| G1 | A full staging rehearsal of `docs/STAGING-CHECKLIST.md` steps 0–10 on the real (authorised) export, all PASS, evidence recorded | NOT RUN (no staging resources) |
| G2 | **Deployed-bundle staging test** on Cloudflare (`docs/CLOUDFLARE-STAGING.md`): the Worker reaches PostgreSQL, one authenticated read and one harmless write succeed, with `AIRTABLE_*` absent and the Airtable API unreachable. A local build is not evidence | NOT RUN; `pg-cloudflare` resolves to an empty module in the live build config, so Worker→PostgreSQL connectivity is **[UNKNOWN]** |
| G3 | Authorised, **frozen-source** export with the repository exporter `scripts/airtable-export.mjs` (read-only GET calls; two consistency passes; refuses incomplete, inconsistent, duplicate or dangling-link exports; writes only new `0600` files outside the repository and any git work tree) using a read-only Airtable token **[operator]** and written authorisation. The fingerprint and per-table counts are recorded by the exporter and delivered **separately** from the files; `airtable-export.mjs verify` requires them as independent inputs | exporter built and tested against a fake Airtable only; **never run against Airtable** — its real-API behaviour (page sizes, attachment fields, rate limits) is unproven until the staging rehearsal |
| G4 | **Financial history decision (Option A or B)** by the owner, written. Option A = verified Keepup export with invoice/payment provenance imported as `Verified*` supplements; Option B = PostgreSQL financial records start at cutover and pre-cutover financial history stays in an approved, time-limited archive with an owner, retention period and destruction date. Orders without verified financials stay quarantined either way. No FX rate, discount, payment, total or opening balance may be inferred | **NOT DECIDED** — this is the owner's decision, not the operators' |
| G5 | Quarantine: every blocking row has a recorded decision (`excluded` or `corrected_in_new_snapshot`, with reason and decider) or is explicitly accepted by the owner | NOT RUN |
| G6 | Reconciliation on staging: verdict `READY` or `READY_WITH_REVIEW` accepted by the owner; repeat import adds 0 rows | proven locally on fixtures only |
| G7 | Backup verified: encrypted backup taken, `verify` PASS, restored into a NEW database and reconciled; key custody confirmed (§4) | tool proven locally with a throw-away key; remote storage and custodian key NOT PROVEN |
| G8 | Integrations verified in staging: Firebase sign-in for staff and customers, Cloudinary photo access (+ re-host, §5.6), WhatsApp/e-mail, **Keepup** (see G9) | NOT RUN |
| G9 | **Keepup behaviour decided.** In PostgreSQL mode invoices are queued in `keepup_sync`; a worker pass creates the sale through `HttpKeepupGateway` (same `POST /sales/add` contract as the live client `src/lib/keepup.ts`; timeout, no automatic retry of ambiguous outcomes, lease/crash recovery, reconciliation states). What exists: the adapter (tested against a local stub), `MOVEZZ_KEEPUP_MODE` resolution (`disabled` default, `mock`, `sandbox`, `live` — a mock or sandbox is never reported as live), and an operator CLI `scripts/keepup-worker.mjs --once` that refuses live mode. Since migration 0019 the queue also carries **payments** and **sale cancellations** (live-client contract, ordered, never re-sent when ambiguous; fake-gateway tested — `docs/KEEPUP-OPERATIONS.md`). **What does not exist:** any scheduled production worker (Cloudflare Pages has no cron; a separate Worker or external scheduler is a production configuration change — options and the proposed schedule are in `docs/KEEPUP-OPERATIONS.md` §3), edit/refund propagation and read-back of payments made in Keepup (no Movezz event or provider contract), verified behaviour against the real Keepup API (no idempotency key or lookup-by-reference is documented, hence ambiguous outcomes need human reconciliation), and any confirmation that Keepup offers a sandbox. Until the owner approves a controlled test and a worker deployment, new invoices will **not** reach Keepup after cutover. The owner must approve either running without Keepup sync for a defined period (set `MOVEZZ_KEEPUP_REQUIRED=false` so readiness records the waiver) or the build-and-test path | **[GATE] NOT DECIDED** |
| G10 | **Production-capable tooling approved.** Every operator tool in this repository refuses production by design: `assertStagingTarget` (`scripts/lib/migrate.mjs`) and `assertApprovedEnvironment` (`scripts/lib/import/env-guard.mjs`) accept only loopback/`staging` targets and refuse production-looking host or database names; the importer accepts a real export only with `MOVEZZ_IMPORT_ENVIRONMENT=staging`. Production migration/import/bootstrap/backup therefore **cannot run as-is**. A reviewed change that adds an explicit, separately approved production mode (with its own confirmations) is required, and must be tested in staging first. Do not rename a database to evade the check | **[GATE] REPOSITORY BLOCKER — not built** |
| G11 | Operational readiness: monitoring and alert owner named, Rollback Authority named, communication plan, maintenance window agreed, support staff briefed | **[operator]** |
| G12 | **Explicit written approval from the Cutover Authority** to proceed, after G1–G11 are PASS | not given |

Not authorised by this document: merging to `main`, deploying, changing Cloudflare/DNS/env/secrets, importing real data, revoking credentials. Each requires G12 (or, for §10, a later approval).

## 2. Pre-cutover freeze and final export
The repository contains **no** maintenance mode, no dual-write and no Airtable-to-PostgreSQL sync. Anything written to Airtable after the final export is not in PostgreSQL.

1. **[GATE] Freeze mechanism approved. [operator]** Decide how all writers to Airtable stop: staff UI use of the old app, customer registrations/self-service, direct edits in the Airtable UI, Airtable automations (the old design relies on them for notifications), and any other integration. The repository cannot enforce this. Record the exact mechanism and who confirms it (for example reducing Airtable collaborator permissions to read-only and pausing automations — an Airtable capability outside this repo, not verified here).
2. Announce the window **[operator]**; record the freeze start time (UTC).
3. Confirm quiescence **[operator]**: no Airtable record changed since freeze start (use Airtable's own last-modified information; the method is **[UNKNOWN]**/operator-supplied).
4. Produce the **final export** **[repo]**: `MOVEZZ_EXPORT_AIRTABLE_TOKEN=<read-only token> MOVEZZ_EXPORT_AIRTABLE_BASE=<app…> node scripts/airtable-export.mjs export --authorized-by "<name>" --confirm-base <app…> --out-dir <absolute dir> --confirm-destination <same dir> [--passes 2|3]` (the credential variables are deliberately not `AIRTABLE_API_KEY`/`AIRTABLE_BASE_ID`). It fails without writing anything if a table is missing, a request keeps failing, ids repeat, links dangle (unless `--allow-missing-links`, recorded in the manifest), or the data changes between passes (the source is not frozen). Output: `<label>-<UTC>.snapshot.json` and `.manifest.json`, mode 0600, never overwritten.
5. Verify the source **[repo]** with values obtained **independently of the files** (the person who froze the base reads Airtable's own record counts and the exporter's fingerprint over another channel): `node scripts/airtable-export.mjs verify --snapshot <S> --manifest <M> --expect-fingerprint <value> --expect-count Customers=<n> … (all 13 tables)`; exit 0 = VERIFIED, 3 = fingerprint matches but completeness is unconfirmed (not acceptable for cutover), 1 = fail. Then offline (`scripts/db-import.mjs fingerprint`): `node $R/scripts/db-import.mjs fingerprint --snapshot export.json` must print exactly the exporter's recorded value. A real export (`source.kind: "export"`) is refused without `--expect-fingerprint`.
6. Completeness reconciliation of the *source*: the per-table counts passed to `verify --expect-count` must be Airtable's own counts taken at freeze time **[operator]** (the exporter cannot know them); the dry-run (§5.3) must report the same counts. Any difference stops the cutover.
7. Anything that changes in Airtable after freeze start invalidates the export: re-freeze, re-export, restart from step 4 (new fingerprint, new target database). Do not patch the snapshot by hand.

## 3. Target validation (before any write)
Run on the machine that will run the commands. Values in `<angle brackets>` are **[operator]**-supplied.

1. Confirm the environment out loud: the target database host and exact database name are the intended ones; it is empty; it is not the staging database.
2. Read-only preflight **[repo]** `scripts/staging-preflight.mjs`:
   `IMPORT_DATABASE_URL=<owner url> DATABASE_URL=<movezz_app url> MOVEZZ_BACKUP_DIR=<dir> node scripts/staging-preflight.mjs --snapshot <export> --expect-fingerprint <exporter value>` — exit 0 required. It checks URL unambiguity (no `?host=`, socket, options), `sslmode=verify-full` with certificate checking, an encrypted session, owner ≠ runtime role, runtime role unprivileged, empty database or applied migrations being an exact prefix of `db/migrations` with identical checksums, signing key present when migrated, fingerprint, backup path outside the repo. It grants **nothing**: every write command re-checks its own target (G10 applies to production).
3. Deployment target **[operator]**: confirm the Cloudflare Pages project, branch and domain that will serve the app (`wrangler.toml` names the project `movezz-shipping`; whether this is the live project is **[UNKNOWN]** to the repository and must be confirmed in the Cloudflare dashboard) and where runtime variables are set (Pages project settings vs build environment — **[UNKNOWN]**).
4. Runtime variables ready, set from the secret store (never in Git): `MOVEZZ_DATA_BACKEND=postgres`, `DATABASE_URL` (role `movezz_app`, `sslmode=verify-full`) or a Hyperdrive binding, `DATABASE_SSL=true`, `ACTOR_CONTEXT_KEY` (≥32 random bytes, base64, one key per environment, **different** from the import key), plus the existing Firebase/Cloudinary/Resend/WhatsApp/Keepup variables (`.env.example`). `AIRTABLE_*` are not needed in PostgreSQL mode.

STOP if any item is FAIL, BLOCKED or unconfirmed.

## 4. Backup and restore
Purpose: a verified way back for the **PostgreSQL** side. It does not restore Airtable (see §8).

1. Key custody **[operator]**: the custodian generates an `age` key pair (`age-keygen`), keeps the identity file offline and apart from the database credentials, and supplies only the **public** recipient (`age1…`) to the operator. Record who holds the identity and where the offline copy is.
2. Backup **[repo]** `scripts/db-backup.mjs`:
   `MIGRATION_DATABASE_URL=<owner url> MOVEZZ_BACKUP_DIR=<dir outside repo> MOVEZZ_BACKUP_AGE_RECIPIENT=<age1…> node scripts/db-backup.mjs backup --confirm-host <host> --confirm-database <db>` (remote targets additionally need `MOVEZZ_IMPORT_ENVIRONMENT=staging` and `sslmode=verify-full` — see G10 for production). The dump is streamed through `age` (no plaintext on disk), file mode 0600, never overwrites, signing keys excluded.
3. Verify (custodian or a machine holding the identity) **[repo]**:
   `node scripts/db-backup.mjs verify --file <F>.dump.age --identity <identity file> --manifest <F>.dump.age.manifest.json` — verdict PASS requires: checksum equals manifest, archive decrypts, `schema_migrations` data present, **no** `movezz_sec.actor_keys` data.
4. Restore test **[repo]**: `MIGRATION_DATABASE_URL=<owner url> node scripts/db-backup.mjs restore --file <F> --identity <id> --new-database mvz_restore_<suffix> --confirm-host <host> --confirm-database <db>` — only into a NEW database named `mvz_restore_*`; it never overwrites. Then provision a fresh signing key (`SELECT movezz_sec.set_actor_key(decode('<64 hex chars>','hex'))` with the migration role, `docs/DATABASE-ARCHITECTURE.md` §13b), run `node scripts/db-migrate.mjs status`, and `db-import.mjs reconcile` against the restored database. Equal reconciliation = restore proven.
5. Take a backup **immediately before** the import and another **immediately after** acceptance (§7). Store them in the approved encrypted location **[operator]**; retention is the owner's decision **[GATE]**.
Proven locally: backup/verify/restore round trip with a throw-away key (`tests/db/backup.test.ts`). NOT proven: remote encrypted storage, a real custodian key, restore on the production host.

## 5. Migration and import
Commands are those of `docs/STAGING-CHECKLIST.md`; the environment variables for a remote target are listed in `docs/STAGING-REHEARSAL-RUNBOOK.md`. `$R` = path of the repository checkout; run from a working directory outside the repository.

1. Migrate **[repo]**: `MIGRATION_DATABASE_URL=<owner url> node $R/scripts/db-migrate.mjs up --confirm-host=<host> --confirm-database=<db>` then `… grants` (same flags). Expected: 19 migrations (`db/migrations` 0001–0019). `db-migrate status` must then list all applied. A modified, renamed, missing or out-of-order migration is refused.
2. Signing keys: register the **import** key (`set_actor_key`), separate from the application key; the importer reads it from `ACTOR_CONTEXT_KEY`.
3. Dry-run (offline first, then read-only against the target; both with `--expect-fingerprint`): `node $R/scripts/db-import.mjs dry-run --snapshot export.json --expect-fingerprint <fp> --report-json reports/dryrun.json`. Exit 0 = READY/READY_WITH_REVIEW, 2 = NOT_READY, 1 = refused. Read the report: counts per table, quarantine categories.
4. Quarantine **[repo]** `scripts/db-quarantine.mjs list|summary|resolve` (append-only decisions: `excluded`, `corrected_in_new_snapshot`, with reason and decider). Orders without verified financials stay quarantined (fail-closed) unless G4 provides verified supplements.
5. Import **[repo]**: `ACTOR_CONTEXT_KEY=<import key> node $R/scripts/db-import.mjs import --snapshot export.json --expect-fingerprint <fp> --initiated-by "<name>" --report-json reports/import.json` — transactional per record, resumable, mappings in `import_records`; rerun after any interruption. Then `reconcile --snapshot export.json --expect-fingerprint <fp>`; then a second `import` must add **0** rows. Reference counters are seeded above the imported maximum (`execute.mjs`), so native records cannot collide.
6. Photos **[repo]**: Airtable-hosted photo URLs expire and die with Airtable. Immediately after the import run `node scripts/db-rehost-photos.mjs plan`, `run --limit N`, `report --out reports/rehost.json` (`docs/AIRTABLE-EXIT.md`). `report` must exit 0 or every remainder be accepted by the owner. How long the exported URLs stay valid is **[UNKNOWN]** — measure it in staging; the rehearsal decides whether re-hosting must happen within hours of the export. The tool uses the same non-production guard as the importer (G10) and a Cloudinary cloud the owner approves.
7. Retire the import key (`movezz_sec.retire_actor_key`) after acceptance.
8. First administrator **[repo]**: `node $R/scripts/db-bootstrap-admin.mjs --email <e> --firebase-uid <uid> --confirm-host <host> --confirm-database <db>` (audited; the Firebase login is created by the person themselves). Staff: `POST /api/users/link-login`; customers: `POST /api/customers/[id]/link-login` (super_admin, verified e-mail, conflicts refused). Ownership verification of each customer is a business rule the owner defines **[GATE]** (`docs/CUTOVER-CHECKLIST.md` §5).

**STOP conditions:** fingerprint mismatch; any guard refusal you do not understand; dry-run NOT_READY for a reason not covered by an accepted quarantine decision; any reconciliation mismatch; second import adds rows; a failed batch; unexpected row counts. Do not work around a refusal. On stop, keep the database for evidence and do not switch the application.

## 6. Application deployment
What exists **[repo]**: pushing to `main` runs `.github/workflows/deploy.yml` → `npm run cf:deploy` (`opennextjs-cloudflare build` then `scripts/cf-pages-deploy.mjs`, which ends with `wrangler pages deploy --branch=main`). `main` currently contains **no** PostgreSQL code, so deploying PostgreSQL mode means merging `feature/postgres-foundation` into `main` — a production change that needs G12. The backend is chosen at runtime by `MOVEZZ_DATA_BACKEND` (`src/lib/backend.ts`): unset/`airtable` = Airtable; `postgres` = PostgreSQL; anything else throws. A deployment that contains the PostgreSQL code but keeps the variable unset still serves Airtable.

Sequence (proposal for approval; the **exact Cloudflare dashboard/CLI steps and where variables live are [UNKNOWN]/[operator]**):
1. Record the identifier of the **current live deployment** (the rollback target, §8) and screenshot/export the current runtime variables **[operator]**. Without this, no rollback is possible.
2. Step A — ship PostgreSQL code **dormant**: merge to `main` with `MOVEZZ_DATA_BACKEND` unset; let the workflow deploy; verify the site still behaves exactly as before (Airtable). This separates "new code" risk from "new backend" risk. (Requires the workflow's Airtable secrets to remain until §10.)
3. Step B — switch: set the runtime variables of §3.4 (including `MOVEZZ_DATA_BACKEND=postgres`) and make them effective (a new deployment may be required for Pages variables to apply — **[UNKNOWN]**, test in staging). Optional Hyperdrive binding `HYPERDRIVE` requires a production configuration change **[GATE]**; Worker→PostgreSQL connectivity must have passed G2.
4. Health checks: `GET /api/health` is **liveness** (`{ok:true,time}`, no database test). `GET /api/ready` is **readiness** (PostgreSQL mode only; 501 in Airtable mode): anonymous callers get `{ready}` (200/503); `Authorization: Bearer <READINESS_TOKEN>` (≥16 chars, secret **[operator]**) returns per-check results without secrets: database reachable and encrypted, schema present, runtime role unprivileged, the application's `ACTOR_CONTEXT_KEY` accepted by the database, Firebase/Cloudinary/e-mail configured (presence only), Keepup `live` configured (a mock or sandbox is never ready; waiver `MOVEZZ_KEEPUP_REQUIRED=false` is an explicit owner decision), and whether Airtable credentials are still present (informational until cutover). Ready does **not** prove Worker→PostgreSQL connectivity from the deployed bundle or that any provider accepts its credentials. Note: `src/middleware.ts` now lets exactly `/api/health` and `/api/ready` through without a cookie (before, an uptime monitor without an `auth-token` cookie was redirected to `/login`); this is a behaviour change of the deployed app once merged. Real functional checks are the authenticated ones in §7. Watch the Worker logs for the first minutes (error rate, 5xx, any `NOT_AUTHORIZED`/`ACTOR_INVALID` bursts).
5. Keep Airtable credentials and data untouched throughout (rollback needs them).

## 7. Acceptance checks (run by named people with real test accounts, then recorded)
Use internal accounts only until all pass, and keep the public blocked from writing until step 12 if the freeze mechanism allows it (**[operator]**). The local browser harness (`scripts/ui-staging/run-all.sh`) covers the same flows on fictional data and is **not** a production check.

1. Sign-in: super_admin, warehouse_staff, an activated customer; an unknown Firebase identity gets `NOT_REGISTERED`; no first-user admin promotion; the single bootstrap admin is the only super_admin.
2. Authorization: staff cannot read invoices/payments/reports; customers get 403 on staff routes; a customer sees only their own items and invoices (another customer's invoice returns 404).
3. Tenant isolation spot check: two customers, cross-requests by id and by search.
4. Items and statuses: create, status moves (forward-only for staff), container assignment, missing flag; WhatsApp/e-mail only when requested (best effort, not guaranteed delivery).
5. Invoices: create from priced items; amounts are USD with the frozen FX rate; discounts only by super_admin with a reason; issued invoices immutable; cancellation super_admin only.
6. Payments: GHS payments, idempotent retries (one payment per key), balance correct; compare 3 imported invoices with their source/Keepup evidence per the Option A/B decision. **No total, balance or conversion may be accepted that cannot be traced to evidence.**
7. Currency: displayed GHS totals equal USD × the stored rate; settings rate changes only by super_admin.
8. Dashboards and reports: figures reconcile with the reconciliation report totals (Σ invoices, Σ payments, outstanding).
9. Photos: imported and newly uploaded photos load; no item shows an `airtableusercontent.com` URL (`db-rehost-photos.mjs report` clean).
10. Integrations: Cloudinary upload signing; e-mail; WhatsApp; Keepup per G9 (state shown honestly: queued/failed/synced, never "created" when only queued).
11. Airtable-free: with `AIRTABLE_*` absent from the runtime and the Airtable API unreachable, repeat steps 1–10. Evidence: Worker logs show no Airtable host contact; this is the proof that is required, and the local harness result is not a substitute.
12. Backup after acceptance (§4.5) and `reconcile` still READY.

Any failure: apply §8's triggers.

## 8. Rollback
### 8.1 What "rollback" can and cannot mean
Redeploying the previous (Airtable-backed) application restores **the application**, not the data written to PostgreSQL after the switch. Airtable is not updated by the PostgreSQL system (there is no dual-write and no PostgreSQL→Airtable sync), so once PostgreSQL has accepted real writes, returning to the old application means **those writes are invisible to it**. The two systems diverge from the first accepted write.

Consequences of divergence (all must be assumed):
- **Lost customer/staff changes:** customers, items, statuses, invoices, payments, photos created or edited in PostgreSQL do not exist in Airtable.
- **Lockouts:** the old app reads roles and users from Airtable. Staff or customers activated only in PostgreSQL cannot use the old app.
- **Duplicate references:** both systems issue `ORD-`/`ITM-`/container references independently; the same reference can mean two different records.
- **Duplicate external processing:** re-entering a record in the old app can create a second Keepup sale, a second e-mail/WhatsApp notification, or a second payment record. PostgreSQL may also hold Keepup/notification state the old app does not know.
- **Invisible financial changes:** payments or cancellations recorded in PostgreSQL are absent from Airtable's totals.

### 8.2 Objective triggers (any one starts the rollback decision; the Rollback Authority decides)
- Authentication or authorization failure affecting staff or customers (lockout, cross-customer data exposure — exposure is a security incident: pause writes first).
- Data integrity failure: reconciliation mismatch after cutover, wrong balances/totals, lost records, duplicate invoices or payments.
- Sustained 5xx/error rate or Worker failure on PostgreSQL routes beyond the threshold agreed in G11 **[operator]**.
- Inability to meet an agreed business-critical workflow (e.g. cannot record payments) for longer than the agreed time **[operator]**.
Do not roll back for cosmetic issues or issues fixable forward within the agreed time.

### 8.3 Decision tree
**Case R0 — no real write has been accepted by PostgreSQL** (only internal smoke-test records, identified by the §7 test accounts):
1. Redeploy the recorded previous deployment (dashboard action **[operator]**; the repository documents no CLI for this) and restore the recorded runtime variables from §6.1.
2. Verify the old app on Airtable (sign-in, a read, a harmless write by an internal account).
3. Keep the PostgreSQL database untouched for evidence; do not delete it. No data reconciliation needed. Lift the Airtable freeze.

**Case R1 — PostgreSQL has accepted real writes** (the common case after the public is let in):
1. **Pause writes first.** Make the application unable to accept writes **[operator mechanism, G11]** (the repository has no maintenance mode). Record the pause time (UTC). Do not redeploy the old app yet.
2. **Assess divergence read-only.** Back up (§4.2) and verify. Identify what exists in PostgreSQL after the cutover timestamp using the tables `audit_logs` (`created_at`, `action`, `entity_type`, `entity_id`), `invoices`, `payments`, `items`, `customers`, `users` (`created_at`) — records without an `import_records` mapping were created natively. Produce a report of new/changed records for the Rollback Authority. No automated copy.
3. **Prefer fix-forward** when the problem can be repaired in PostgreSQL within the agreed time: correct the defect, reconcile, resume writes. This avoids all divergence and is the default recommendation once real writes exist.
4. **If rollback is still ordered** (only the Rollback Authority, in writing, having read the divergence report): decide **per record class** how the post-cutover records reach the old system — manual re-entry in the old app by authorised staff from the report, or documented acceptance of loss — and how duplicate Keepup/notification processing is avoided (check Keepup first; do not re-send notifications). Then redeploy the previous deployment, restore the previous variables, verify as in R0.2, and keep PostgreSQL read-only and preserved as the record of post-cutover data.
5. After the old app is live again, customers/staff created only in PostgreSQL must be re-created in Airtable and Firebase mapped manually; list them from step 2.

### 8.4 Never
- Never write or run a reverse migration or script that copies newer PostgreSQL data into Airtable, and never do it automatically or "blindly". No such tool exists in the repository; building one needs a separate, explicitly approved design.
- Never re-run the import against a database that already holds native records, or re-import an older export over it.
- Never delete the PostgreSQL database or its backups after a rollback; they are the only copy of post-cutover data.
- Never revoke Airtable credentials, archive Airtable or delete the previous deployment during the stabilization period.
- A second cutover attempt starts from a **new** freeze, a **new** export and fingerprint, and a **new** empty target database.

### 8.5 Database restore (PostgreSQL side only)
A bad PostgreSQL state is recovered by restoring a verified backup into a NEW database (§4.4), reconciling, provisioning a fresh signing key, and only then pointing the app (`DATABASE_URL`) at it. Migrations are forward-only; there is no down-migration.

## 9. Post-cutover verification and stabilization
- First hours **[operator]**: watch Worker error rate and PostgreSQL connection errors; check `audit_logs` for unusual `NOT_AUTHORIZED`/`ACTOR_INVALID` patterns; confirm notifications are sent once.
- Daily during stabilization: `reconcile` still READY (imported scope), payment totals equal the sum of recorded payments, no `airtable`-hosted photos, backups taken, verified and restorable, `db-purge-idempotency.mjs --dry-run` (strictly guarded) shows expired keys only.
- Customer-impact assessment: support tickets, failed logins, missing records, duplicate invoices; reported to the Cutover Authority.
- **Stabilization period: [GATE] the owner sets its length in advance** (no default is assumed). Airtable and the previous deployment remain intact and untouched for the whole period.

## 10. Airtable retirement (separate approval, after stabilization)
Preconditions: all of `docs/AIRTABLE-EXIT.md` §5 satisfied, the stabilization period completed without an open rollback trigger, the approved archive and retention plan in force (G4), and **written approval** from the Cutover Authority. Then, in this order:
1. Take and verify a final Airtable archive export per the approved plan **[operator]** (encrypted, owner, retention, destruction date).
2. Remove Airtable code and configuration per `docs/AIRTABLE-EXIT.md` §6 (a normal reviewed change; the boundary test `tests/unit/airtable-boundary.test.ts` then asserts zero importers).
3. Remove `AIRTABLE_*` from `deploy.yml`, GitHub/Cloudflare secrets, `.env.example`, docs.
4. Redeploy and re-run §7.11 (Airtable-free) in production.
5. Only then revoke the Airtable API tokens **[operator]**. Revocation is irreversible for the old application: after this, §8 rollback to the Airtable app is no longer possible.

## 11. Repository-level blockers and open items (as of this document)
1. **G10:** no production-capable mode exists for migrate/import/bootstrap/backup/re-host (deliberate fail-closed). Needs a reviewed, separately approved design and staging proof.
2. **G9:** the Keepup HTTP adapter and an operator CLI exist (tested against a local stub only); no scheduled production worker, no payment/cancel/edit/refund propagation, no real-API verification.
3. **G3:** the exporter exists and is tested only against a fake Airtable; its first real run is part of the staging rehearsal.
4. **G4:** financial-history Option A/B undecided.
5. **G2:** Worker→PostgreSQL connectivity unverified; `HYPERDRIVE` binding is not configured in `wrangler.toml`.
6. No maintenance/read-only mode and no PostgreSQL→Airtable path; both are intentional absences that this runbook works around with explicit operator steps.
7. Unexplained intermittent `flow2` navigation timeout in the local browser harness (see `docs/CUTOVER-EVIDENCE.md`): not root-caused; it is a local test observation, not a production finding.
