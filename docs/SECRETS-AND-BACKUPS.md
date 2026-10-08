# Production secrets and backups — requirements and status

Status: **requirements verified in code and tests (VL); the production secret store, encrypted backup storage and restore on the production host are BLOCKED / NOT TESTED** — they do not exist in this environment and none was provisioned or touched.

## Secrets the PostgreSQL deployment needs (names only; values live in the platform secret store, never in Git, `wrangler.toml`, fixtures or build output)
| Secret | Used by | Notes |
|---|---|---|
| `DATABASE_URL` (+ `DATABASE_SSL=true`) or a `HYPERDRIVE` binding | application | runtime role `movezz_app` (DML only); one per environment |
| `ACTOR_CONTEXT_KEY` | application | ≥32 random bytes, base64; production refuses a missing/short/non-random key; also registered in the database (`movezz_sec.set_actor_key`) |
| import actor key | `scripts/db-import.mjs` only | a **different** key from the application's, registered for the import and retired afterwards (`movezz_sec.retire_actor_key`) |
| `MIGRATION_DATABASE_URL` | `db-migrate`, `db-bootstrap-admin`, backups | owner/migrator role; never given to the application |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `NEXT_PUBLIC_FIREBASE_*` | token verification, user lookup (`link-login`) | the `NEXT_PUBLIC_*` values are public by design |
| `KEEPUP_API_KEY` | Keepup worker (disabled by default) | enabled only for the controlled cutover test |
| `CLOUDINARY_*` | upload signing | |
| `RESEND_API_KEY`, `EMAIL_FROM`, `WHATSAPP_*` | notifications / outbox worker | mock sender until enabled |
| `REGISTRATION_THROTTLE_PEPPER`, `APP_SECRET` | registration throttle, app | per environment |

## Verified (VL)
* Nothing secret in tracked files (pattern scan; only `.env.example` placeholders) and no secret name in the client bundle (`.next/static` contains none of `ACTOR_CONTEXT_KEY`, `DATABASE_URL`, `FIREBASE_PRIVATE_KEY`).
* Logs redact secret-like keys, e-mail, phone, names and payloads and never print URLs or keys (`tests/db/staging-rehearsal.test.ts`, probe Worker).
* `movezz_sec.actor_keys` is unreadable by the runtime role; backups are taken with `--exclude-table-data=movezz_sec.actor_keys` and a restored database has **0** keys (rehearsal); the application cannot act until a key is provisioned — do not weaken this to make restores easier.
* The import key is separate from the application key by procedure (`docs/MIGRATION-IMPORT.md` §12) and the importer refuses any live-integration variable in its environment.
* First administrator: an explicit operator action on the owner connection (`scripts/db-bootstrap-admin.mjs`, host confirmation, no password created); the API cannot create a super_admin.

## Backup and restore policy (tool implemented and tested locally; encrypted remote storage and a real custodian key are BLOCKED until they exist)
Tool: `scripts/db-backup.mjs` (`backup | verify | restore`). It streams `pg_dump` through `age` (public recipient only, so the machine that backs up cannot decrypt), writes `0600`, never overwrites, refuses destinations inside the repository, excludes `movezz_sec.actor_keys` data and proves the exclusion in `verify`, and restores only into a brand-new `mvz_restore_*` database. Tested against a disposable local database with a throw-away key; never run against remote storage.
1. `pg_dump -Fc --exclude-table-data=movezz_sec.actor_keys` from the owner connection; encrypt immediately (e.g. `age`/`gpg` with a key held by a different custodian than the database credentials); store in access-controlled storage; retention set by the owner.
2. Restore only into a **new, empty database** on an explicitly named host; the application's `DATABASE_URL` is never changed by a restore. After restoring: run `db-migrate status`, provision a fresh actor key, run reconciliation, and only then (separate, approved step) point a *staging* application at it.
3. Quarterly restore drill; keep the evidence in `docs/CUTOVER-EVIDENCE.md`.
