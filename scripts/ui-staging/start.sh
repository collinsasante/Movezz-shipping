#!/usr/bin/env bash
# STAGING HARNESS ONLY: starts the fake identity service and the built Next app on the PostgreSQL backend against a LOCAL database.
# usage: DB=postgres://movezz_app@127.0.0.1:54329/mvz_ui scripts/ui-staging/start.sh   (run `next build` first with fake NEXT_PUBLIC_FIREBASE_* values)
set -euo pipefail
cd "$(dirname "$0")/../.."
export FAKE_IDENTITY_PORT=9199
export FAKE_USERS='{"admin@example.invalid":{"uid":"uid-admin","password":"pw-admin"},"staff@example.invalid":{"uid":"uid-staff","password":"pw-staff"},"ama@example.invalid":{"uid":"uid-ama","password":"pw-ama"},"kojo@example.invalid":{"uid":"uid-kojo","password":"pw-kojo"}}'
node scripts/ui-staging/fake-identity.cjs & 
export MOVEZZ_DATA_BACKEND=postgres DATABASE_URL="${DB:?set DB to a LOCAL staging database url}" NODE_ENV=production
export ACTOR_CONTEXT_KEY="$(node -e 'console.log(Buffer.from(Array.from({length:32},(_,i)=>(i*37+11)%256)).toString("base64"))')"
export NODE_OPTIONS="--require $PWD/scripts/ui-staging/redirect-fetch.cjs"
case "$DB" in *127.0.0.1*|*localhost*) ;; *) echo "refusing: the harness only runs against a local database" >&2; exit 1;; esac
exec node_modules/.bin/next start -p 3100
