#!/bin/sh
# Build all three tools with the same upstream revision used by the realm.
set -eu
cd "$(dirname "$0")/.."
root=$PWD
src="$root/.tools/src/gno"
bin="$root/.tools/bin"
pin=d25b308c1a22ec04f429a2826e681249126320cd
mkdir -p "$root/.tools/src" "$bin"
if [ ! -d "$src" ]; then
  git init -q "$src"
  git -C "$src" fetch --depth=1 https://github.com/gnolang/gno.git "$pin"
  git -C "$src" checkout -q --detach FETCH_HEAD
fi
if [ "$(git -C "$src" rev-parse HEAD)" != "$pin" ]; then
  echo "Existing Gno checkout has a different revision: $src" >&2
  exit 1
fi
cd "$src"
go build -o "$bin/gno" ./gnovm/cmd/gno
go build -o "$bin/gnokey" ./gno.land/cmd/gnokey
go build -o "$bin/gnodev" ./contribs/gnodev
