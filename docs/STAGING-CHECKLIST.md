# Staging checklist (shortest path; details in STAGING-REHEARSAL-RUNBOOK.md and CLOUDFLARE-STAGING.md)

Nothing here touches production. If any STOP condition occurs, stop and report; never work around a failed check.

## Prerequisites (from the owner)
1. **Export**: authorised, read-only Airtable export in the snapshot format, delivered outside the repo, plus the **fingerprint recorded by the exporter**.
2. **Staging PostgreSQL**: an empty, non-production server (TLS) with an owner role for migrations and a separate runtime role `movezz_app`; its host and the exact database name.
3. **Historical-data decision**: Option A (verified Keepup export) or Option B (leave unverifiable history in the Airtable archive). Until decided, orders without verified financials stay quarantined, nothing is guessed.
4. For step 7–8 only: a **staging** Cloudflare Pages project + token, a **staging** Firebase project with test accounts, and (optional) Keepup sandbox / Cloudinary test credentials.

## Ordered steps and expected results
| # | Step | Command / action | Expected | STOP if |
|---|---|---|---|---|
| 1 | Source integrity | `node $R/scripts/db-import.mjs fingerprint --snapshot export.json` | equals the exporter's value | different value, no recorded value |
| 2 | Target check | set `MOVEZZ_IMPORT_ENVIRONMENT=staging`, `MOVEZZ_IMPORT_ALLOW_EXPORT=1`, `MOVEZZ_IMPORT_ALLOWED_HOSTS`, `MOVEZZ_IMPORT_CONFIRM_DATABASE`, `IMPORT_DATABASE_URL`; no AIRTABLE_/FIREBASE_/KEEPUP_/CLOUDINARY_/CLOUDFLARE_ variables set | the tool starts; any ambiguity is a refusal listing the failed checks | any refusal you do not fully understand; host/database not exactly the staging one |
| 3 | Migrate | `db-migrate up` + `grants` on the fresh database | 18 migrations applied | any error |
| 4 | Dry-run | `db-import.mjs dry-run --snapshot … --expect-fingerprint …` | verdict + counts per table + quarantine categories; writes nothing | unexplained blocking category, counts differ from the exporter's table counts |
| 5 | Quarantine review | `db-quarantine.mjs list/summary`; record decisions only with a reason | every blocking row read by a person | anything resolved by guessing |
| 6 | Import + reconcile | `import …` then `reconcile …` | 100 % of checks pass; quarantined counts equal the dry-run | any reconciliation mismatch, any failed batch |
| 6a | Re-host photos | `db-rehost-photos.mjs plan`, then `run --limit 50`, then `report --out reports/rehost.json` (needs `MOVEZZ_REHOST_CLOUDINARY_URL` for a **test** cloud + `MOVEZZ_REHOST_CONFIRM_CLOUD`; same environment guard as the importer). Source URLs expire: run soon after the export. | `report` exits 0 (no Airtable-hosted photo left) or every remainder is in `needsReview` and accepted by the owner | a production cloud is requested; `needsReview` not decided |
| 6b | Activate logins | existing Firebase staff: `POST /api/users/link-login {firebaseUid}`; customers: `POST /api/customers/{id}/link-login`; new staff/customers via the normal admin screens. All super_admin-only, verified e-mail required, audited. First admin: `db-bootstrap-admin.mjs`. | each active user can sign in with the right role; an unlinked identity gets 404 NOT_REGISTERED | any account created by guessing an e-mail or uid |
| 7 | Repeat import | `import …` again | 0 new rows, identical fingerprint | any new row |
| 8 | Backup/restore | `pg_dump -Fc --exclude-table-data=movezz_sec.actor_keys` → encrypt → restore into a NEW database → provision a staging key → `reconcile` | restored signature and reconciliation equal; 0 actor keys in the dump | keys present in the dump, restore target is not a new empty database |
| 9 | Deployed Worker | probe Worker, then app bundle per CLOUDFLARE-STAGING.md; one authenticated read + one harmless write | 200s, no secrets in `wrangler tail`, no Airtable access | any credential in logs, any request to a non-staging host |
| 10 | Integrations (if credentials exist) | Firebase activation with a test account; Keepup sandbox sync from the worker; Cloudinary test upload | each state shown honestly (queued/failed/synced) | production credentials requested |

Record every result (PASS/FAIL/BLOCKED, environment, counts) in `docs/CUTOVER-EVIDENCE.md`. Delete or encrypt the export and dumps afterwards; they are git-ignored (`*.dump`, `reports/`, `staging-exports/`).
