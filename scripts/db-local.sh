#!/usr/bin/env bash
# Local PostgreSQL 16 for development and database tests. NEVER point this at a shared or production server.
#   scripts/db-local.sh start   - start a throwaway cluster (Docker if available, otherwise local PostgreSQL 16 binaries)
#   scripts/db-local.sh stop
#   scripts/db-local.sh reset   - drop and recreate the local DEV database `movezz_dev`, then run migrations
#   scripts/db-local.sh env     - print the connection URLs for this local server
# Credentials are local-only and fixed to trust authentication on 127.0.0.1; they are not secrets.
set -euo pipefail
PORT="${MOVEZZ_PG_PORT:-54329}"
DATA="${MOVEZZ_PG_DATA:-${TMPDIR:-/tmp}/movezz-pg16}"
BIN="${MOVEZZ_PG_BIN:-/usr/lib/postgresql/16/bin}"
ADMIN_URL="postgres://postgres@127.0.0.1:${PORT}/postgres"

run_as_pg() { if [ "$(id -u)" = "0" ]; then su postgres -c "$*"; else bash -c "$*"; fi; }

start() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker compose -f docker-compose.db.yml up -d --wait
    echo "started PostgreSQL 16 via Docker on 127.0.0.1:${PORT}"
    return
  fi
  [ -x "$BIN/initdb" ] || { echo "No Docker and no PostgreSQL 16 binaries at $BIN"; exit 1; }
  if [ ! -d "$DATA" ]; then
    mkdir -p "$DATA"; [ "$(id -u)" = "0" ] && chown postgres "$DATA"
    run_as_pg "$BIN/initdb -D '$DATA/cluster' -A trust -U postgres >/dev/null"
  fi
  if ! run_as_pg "$BIN/pg_ctl -D '$DATA/cluster' status" >/dev/null 2>&1; then
    run_as_pg "$BIN/pg_ctl -D '$DATA/cluster' -o '-p $PORT -k $DATA -c listen_addresses=127.0.0.1' -l '$DATA/server.log' -w start" >/dev/null
  fi
  echo "PostgreSQL 16 listening on 127.0.0.1:${PORT}"
}
stop() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then docker compose -f docker-compose.db.yml down; return; fi
  run_as_pg "$BIN/pg_ctl -D '$DATA/cluster' -m fast stop" || true
}
reset() {
  start
  psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS movezz_dev" -c "CREATE DATABASE movezz_dev"
  MIGRATION_DATABASE_URL="postgres://postgres@127.0.0.1:${PORT}/movezz_dev" node scripts/db-migrate.mjs up
}
case "${1:-}" in
  start) start ;; stop) stop ;; reset) reset ;;
  env) echo "MOVEZZ_TEST_PG_URL=$ADMIN_URL"; echo "MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/movezz_dev" ;;
  *) echo "usage: $0 start|stop|reset|env"; exit 2 ;;
esac
