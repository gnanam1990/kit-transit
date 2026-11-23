#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
case "${1:-dump}" in
  dump) exec node tools/snapshot.mjs dump ;;
  restore) exec node tools/snapshot.mjs restore "$2" ;;
  rebuild) exec node src/reindex.ts ;;
  --verify) exec node src/reindex.ts --verify ;;
  *) echo "Usage: tools/snapshot.sh dump | restore SNAPSHOT | rebuild | --verify" >&2; exit 2 ;;
esac
