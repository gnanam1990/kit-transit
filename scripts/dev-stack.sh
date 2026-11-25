#!/bin/sh
# Bring the local dev stack up/down: PostgreSQL (docker) + migrations.
# The Gno chain is started by gnodev on demand (see README / probe scripts).
set -eu
cd "$(dirname "$0")/.."

case "${1:-up}" in
  up)
    docker compose up -d postgres
    echo "waiting for postgres..."
    for i in $(seq 1 30); do
      docker exec kittransit-pg pg_isready -U kittransit >/dev/null 2>&1 && break
      sleep 1
    done
    npm run migrate
    echo "postgres ready on 127.0.0.1:5433 (db kittransit)"
    ;;
  down)
    docker compose down
    ;;
  *)
    echo "usage: $0 [up|down]" >&2; exit 2 ;;
esac
