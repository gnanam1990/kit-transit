#!/bin/sh
# Sign a staff sign-in challenge with gnokey (offline flags; no broadcast).
# Usage:
#   tools/staff-sign.sh <challenge.json> <key-name> <gnokey-home> <chain-id>
# Prints {"pubkey":"...","signature":"..."} for POST /api/session.
set -eu

CH="$1"; NAME="$2"; HOME_DIR="$3"; CHAIN="$4"
GNOKEY="${GNOKEY:-.tools/bin/gnokey}"

TX=$(mktemp); SIG=$(mktemp)
trap 'rm -f "$TX" "$SIG"' EXIT

# The challenge carries the unsigned tx built for exactly this signdoc.
node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));require('fs').writeFileSync(process.argv[2],JSON.stringify(c.tx));" "$CH" "$TX"

"$GNOKEY" sign "$NAME" \
  -home "$HOME_DIR" -insecure-password-stdin \
  -account-number 0 -account-sequence 0 -chainid "$CHAIN" \
  -tx-path "$TX" -output-document "$SIG" -quiet

node -e "
const s = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const pub = typeof s.pub_key === 'string' ? s.pub_key : s.pub_key.value;
console.log(JSON.stringify({ pubkey: pub, signature: s.signature }));" "$SIG"
