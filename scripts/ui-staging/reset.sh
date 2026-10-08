#!/usr/bin/env bash
# STAGING HARNESS ONLY: recreates the LOCAL harness database (mvz_ui) from migrations + fictional seed + the harness actor key.
set -euo pipefail
cd "$(dirname "$0")/../.."
U="${PGSUPER:-postgres://postgres@127.0.0.1:54329}"
case "$U" in *127.0.0.1*|*localhost*) ;; *) echo "refusing: local database only" >&2; exit 1;; esac
psql "$U/postgres" -q -c "DROP DATABASE IF EXISTS mvz_ui" -c "CREATE DATABASE mvz_ui"
MIGRATION_DATABASE_URL="$U/mvz_ui" node scripts/db-migrate.mjs up | tail -1
MIGRATION_DATABASE_URL="$U/mvz_ui" node scripts/db-migrate.mjs grants | tail -1
psql "$U/mvz_ui" -q -f scripts/ui-staging/seed.sql
K=$(node -e 'console.log(Buffer.from(Array.from({length:32},(_,i)=>(i*37+11)%256)).toString("hex"))')
psql "$U/mvz_ui" -q -At -c "SELECT movezz_sec.set_actor_key(decode('$K','hex'))" >/dev/null
echo "mvz_ui ready"
