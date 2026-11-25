# Local deployment guide

Everything here runs locally with disposable keys and databases. No remote
writes, no shared credentials.

## 1. Toolchain

The realm and scripts expect the pinned Gno toolchain in `.tools/`:

```sh
npm ci
sh scripts/setup-gno.sh
```

`GNOROOT` must point at `.tools/src/gno` for lint/test commands.

## 2. PostgreSQL

```sh
sh scripts/dev-stack.sh up
```

Starts `postgres:16-alpine` as `kittransit-pg` on `127.0.0.1:5433`
(db `kittransit`, dev-only credentials) and applies `db/schema.sql`.
Env override: `KIT_DB_URL`.

## 3. Services

```sh
npm run api        # :8080 — staff desk at /, public record at /public.html
npm run indexer    # indexes realm events into the projection
```

The indexer needs a running chain: launch `gnodev local` with the realm
directory as the working tree (the verification probe does this
automatically). Key env vars: `KIT_RPC_URL`, `KIT_REALM`, `KIT_NETWORK`,
`KIT_PAGE_LIMIT`.

## 4. Realm deployment (local chain only)

`func init(cur realm)` binds `registrar` to the authenticated deployer at
package-init time. Outside `chain_id` `dev`, there is no fallback —
deployment with an unintended key is refused. Rotate via `SetRegistrar`
(current registrar only, bech32-validated).

## 5. Snapshot and restore

For the local Compose install, set `KIT_PG_CONTAINER=kittransit-pg` to use the PostgreSQL clients in the database container. Other installations require client utilities matching the server major version. Run from the repository root. Set `KIT_DB_URL` and `KIT_EVIDENCE_DIR` to the source database and object directory.

```sh
tools/snapshot.sh dump
```

The command prints a private directory with a database archive, object files and a SHA-256 manifest. Keep it in access-controlled storage. The archive and object list use the same PostgreSQL snapshot. Staff sign-in sessions and outstanding challenges expire on restore.

For recovery, provision an empty database and choose a new evidence directory. Its parent directory must already exist. Set `KIT_DB_URL` and `KIT_EVIDENCE_DIR` to these destinations, then run the following commands against a trusted backup. Keep the app stopped until verification succeeds.

```sh
tools/snapshot.sh restore /path/to/private/snapshot
tools/snapshot.sh --verify
```

After an interrupted restore, inspect the dedicated restore database and evidence directory before retrying into fresh destinations. The verifier reads the currently configured realm. Use the network, realm and deployment epoch corresponding to the backup.

## 6. Public testnet — BLOCKED

No explicit deployment authority exists for this build. Do not broadcast
from this repository. The honest status is recorded in
`docs/evidence/test-ledger.json` (T-029).
