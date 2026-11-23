#!/bin/sh
# Reproduce custody, projection and staff access on one disposable local chain.
set -eu
cd "$(dirname "$0")/.."
root=$PWD
export GNOROOT="$root/.tools/src/gno"
pin=d25b308c1a22ec04f429a2826e681249126320cd
if [ "$(git -C "$GNOROOT" rev-parse HEAD 2>/dev/null || true)" != "$pin" ]; then
  echo "Install the pinned Gno toolchain with sh scripts/setup-gno.sh" >&2
  exit 1
fi
for tool in gno gnokey gnodev; do
  test -x "$root/.tools/bin/$tool" || { echo "Missing $tool; run sh scripts/setup-gno.sh" >&2; exit 1; }
done
(
  cd realm/gno.land/r/kittransit/custody
  "$root/.tools/bin/gno" lint .
  "$root/.tools/bin/gno" test -v .
)
if ! docker exec kittransit-pg pg_isready -U kittransit >/dev/null 2>&1; then
  docker compose up -d --wait postgres
fi
db=kit_qa_projection_$(openssl rand -hex 8)
docker exec kittransit-pg createdb -U kittransit "$db"
trap 'docker exec kittransit-pg dropdb -U kittransit --if-exists "$db"' EXIT
export KIT_DB_URL="postgres://kittransit:kittransit-local-dev@127.0.0.1:5433/$db"
export KIT_QA_OUTPUT="$root/.local/qa/$db"
export KIT_PG_CONTAINER=kittransit-pg
export KIT_QA_PAGE_LIMIT=2 KIT_QA_RELEASE_PROVENANCE=1
npm run typecheck
npm test
python3 scripts/qa/custody.py --retry --recovery
echo "Local E2E passed. Receipts and catalogue files are in $KIT_QA_OUTPUT"
