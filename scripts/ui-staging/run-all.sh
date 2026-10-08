#!/usr/bin/env bash
# STAGING HARNESS ONLY. Repeatable local browser verification on the PostgreSQL backend with Airtable absent:
#   reset the LOCAL harness database (mvz_ui only) -> start the built app (AIRTABLE_* unset, Airtable network blocked) -> crawl, flow, flow2
#   -> FAIL if any step failed or the Airtable block log is not empty.   Needs: `next build` done, PLAYWRIGHT_CORE_DIR, local PostgreSQL.
set -uo pipefail
cd "$(dirname "$0")/../.."
export AIRTABLE_BLOCK_LOG="${AIRTABLE_BLOCK_LOG:-/tmp/airtable-block.log}"
if env | grep -v '^AIRTABLE_BLOCK_LOG=' | grep -q '^AIRTABLE_'; then echo "refusing: AIRTABLE_* is set in this shell" >&2; exit 2; fi
fuser -k 3100/tcp 9199/tcp >/dev/null 2>&1; sleep 1
scripts/ui-staging/reset.sh >/dev/null || exit 2
(DB=postgres://movezz_app@127.0.0.1:54329/mvz_ui scripts/ui-staging/start.sh > /tmp/ui-staging-server.log 2>&1 &)
for _ in $(seq 1 30); do curl -s -o /dev/null localhost:3100/login && break; sleep 1; done
rc=0
for m in crawl flow flow2; do
  out=$(timeout 280 node scripts/ui-staging/ui-run.mjs $m 2>&1); st=$?
  echo "$out" | tail -40 > "/tmp/ui-staging-$m.log"
  broken=$(echo "$out" | grep -c '"broken":true'); fails=$(echo "$out" | grep -c '^FAIL'); passes=$(echo "$out" | grep -c '^PASS')
  echo "$m: exit=$st pass=$passes fail=$fails broken_pages=$broken $(echo "$out" | grep -E 'ALL UI CHECKS PASSED|FAILED:' | tail -1)"
  [ "$st" -ne 0 ] || [ "$fails" -ne 0 ] || [ "$broken" -ne 0 ] && rc=1
done
if [ -s "$AIRTABLE_BLOCK_LOG" ]; then echo "FAIL: Airtable access attempted:"; cat "$AIRTABLE_BLOCK_LOG"; rc=1; else echo "airtable block log: empty"; fi
fuser -k 3100/tcp 9199/tcp >/dev/null 2>&1
exit $rc
