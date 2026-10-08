# Staging rehearsal with an authorised Airtable export (procedure — NOT yet executed; no export exists)

Preconditions (owner): an authorised person exports the base **read-only** (the importer never contacts Airtable) into the snapshot format (`docs/MIGRATION-IMPORT.md` §2), records the export's SHA-256 fingerprint, and hands it over **outside the repository**. Approval to run it against a *staging* database. Production Airtable, Firebase, Keepup, Cloudinary, Cloudflare and the production database are never involved.

Safety built into the tool (VL, tests in `tests/db/import-*.test.ts`): a real export (`source.kind: "export"`) is accepted only with `MOVEZZ_IMPORT_ENVIRONMENT=staging` **and** `MOVEZZ_IMPORT_ALLOW_EXPORT=1`; the target must be loopback or listed in `MOVEZZ_IMPORT_ALLOWED_HOSTS`; a host or database name containing prod/production/live is refused; any `AIRTABLE_*`, `FIREBASE_*`, `KEEPUP_*`, `CLOUDINARY_*`, `CLOUDFLARE_*`/`CF_*`, `RESEND_*`, `WHATSAPP_*` variable in the environment makes the tool refuse; `NODE_ENV=production` is refused; the snapshot must lie inside the working directory (symlinks resolved) — so run the tool **from the staging directory that holds the export**.

```
export R=/path/to/this/repo
mkdir -p ~/staging-rehearsal && cd ~/staging-rehearsal            # NOT inside the repository
# 1  receive the export here (outside the repo); chmod 600 export.json; never commit it
# 2  verify the source: fingerprint (offline) must equal the value recorded by whoever exported it
node $R/scripts/db-import.mjs fingerprint --snapshot export.json
export EXPECT=<the recorded fingerprint>
# 3  fresh STAGING PostgreSQL (never an existing database), migrated, with a staging-only actor key
psql "$STAGING_ADMIN_URL" -c "CREATE DATABASE mvz_rehearsal_1"
MIGRATION_DATABASE_URL=$STAGING_ADMIN_URL_WITH_DB node $R/scripts/db-migrate.mjs up && … grants
# 4  dry-run: offline first, then read-only against the target; both must match --expect-fingerprint
export MOVEZZ_IMPORT_ENVIRONMENT=staging MOVEZZ_IMPORT_ALLOW_EXPORT=1 MOVEZZ_IMPORT_ALLOWED_HOSTS=<staging host> IMPORT_DATABASE_URL=<staging url>
node $R/scripts/db-import.mjs dry-run --snapshot export.json --expect-fingerprint $EXPECT --report-json reports/dryrun.json
# 5  quarantine review: every blocking/review category is read by a person; nothing is "fixed" by guessing.
#    Decisions are recorded with scripts/db-quarantine.mjs (excluded | corrected_in_new_snapshot + reason + who). Orders without verified financials stay quarantined.
# 6  import (staging key, separate from any other key), then reconcile, then repeat the import (must add 0 rows)
ACTOR_CONTEXT_KEY=<staging import key> node $R/scripts/db-import.mjs import --snapshot export.json --expect-fingerprint $EXPECT --initiated-by "<name>" --report-json reports/import.json
node $R/scripts/db-import.mjs reconcile --snapshot export.json --expect-fingerprint $EXPECT
ACTOR_CONTEXT_KEY=… node $R/scripts/db-import.mjs import --snapshot export.json --expect-fingerprint $EXPECT --initiated-by "<name> repeat"
# 7  backup WITHOUT the signing keys, restore into a NEW database, reconcile again
pg_dump -Fc --exclude-table-data=movezz_sec.actor_keys "$STAGING_DB" > backup.dump      # encrypt the file at rest; keep the key elsewhere
createdb … mvz_rehearsal_1_restored && pg_restore -d … backup.dump
node $R/scripts/db-import.mjs reconcile --snapshot export.json --expect-fingerprint $EXPECT     # against the restored DB
# 8  record counts (source / imported / quarantined / excluded / corrected), payment totals where verifiable, fingerprints, unresolved categories in docs/CUTOVER-EVIDENCE.md; drop the rehearsal databases; delete or encrypt the export
```
Automated twin of steps 3–7 on a generated fixture: `node scripts/staging-rehearsal.mjs --scale 1,2,5,10 --repeat 2` (`docs/MIGRATION-IMPORT.md` §15).
