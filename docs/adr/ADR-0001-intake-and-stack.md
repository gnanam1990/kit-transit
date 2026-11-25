# ADR-0001 — Repository intake and stack decisions

Date: 2026-11-23 · Status: accepted

## Intake record

- Origin: fresh local repository `kit-transit`, no remote, branch `main`, starting SHA: none (no commits).
- Dirty files at intake: none; only the ignored `.devin-handoff/` specification bundle.
- Tooling observed: go1.26.6 darwin/arm64, node v22.23.1, npm, Docker 29.6.1 (daemon 29.5.2, running).
- Gno toolchain: none installed. Built from official source `github.com/gnolang/gno` pinned to commit
  `d25b308c1a22ec04f429a2826e681249126320cd` (the commit referenced by the event pack for network
  compatibility) into the gitignored `.tools/` directory: `gno`, `gnokey`, `gnodev`.
- Licensing: handoff docs are a specification; all product code below is original work.

## Stack decisions

1. **Realm**: original Gno realm `gno.land/r/kittransit/custody` using the current std-split API
   (`chain/runtime`, `chain/runtime/unsafe`, builtin `address`, `cur realm` first parameter,
   `cur.Previous().IsUserCall()` caller checks, `crypto/sha256` commitments).
   Realm tests run under `gno test` (real VM execution, distinct callers via `testing.SetRealm`
   / `testing.SetOriginCaller`). Local chain = `gnodev local`, real broadcast txs via `gnokey`
   with two per-org keybases under gitignored `.local/keys/`.
2. **API/indexer**: Node 22 with native TypeScript type stripping (`node --test`), `pg` for
   PostgreSQL. No HTTP framework; a small router over `node:http` keeps the dependency surface
   auditable.
3. **Durable SQL projection**: PostgreSQL (per TDD; local instance via `docker compose`).
   Events, projection rows, catalogue outbox and the block checkpoint commit in one transaction.
4. **Staff desk**: dependency-free ES-module PWA (IndexedDB drafts, keyboard-first scanner,
   service worker). Served by the API. jsdom + fake-indexeddb for tests.
5. **Private evidence**: local object store under `.local/evidence`, proxied only through an
   authenticated, ACL-rechecked endpoint with `no-store`. Never a transferable URL.
6. **Signer model**: production intent is a browser wallet (Adena-class) signing a typed preview.
   The local demo uses per-org `gnokey` keybases (each institution's own keystore, never
   committed); the API signs via `POST /drafts/{id}/sign-local` only in local mode and never
   holds keys itself — it shells out to the org's own key home.
7. **Independent reads**: `apps/reader` queries ABCI `vm/qeval` directly against the node RPC,
   bypassing API, projection and browser caches. `scripts/independent-read.sh` does the same
   with curl for judges.

## Boundaries

- `.tools/`, `.local/`, `.devin-handoff/` stay untracked.
- No remote pushes, no public transactions, no paid calls. T-029 (public testnet) remains
  BLOCKED until an authorized deployer and funded test identities exist.
