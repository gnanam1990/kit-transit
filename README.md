# Kit Transit

Two-institution library-kit custody on a Gno realm. A kit's components are
tracked through real signed handoffs: who attested receipt, which components
arrived, what is missing, and when the kit can return to circulation.

## Layout

| Path | What it is |
|---|---|
| `realm/gno.land/r/kittransit/custody/` | The Gno realm — canonical custody state, org enrolment, manifests, legs, receipts, exceptions, recovery, assessment, release. Registrar binds to the authenticated deployer; no fixed test key outside local dev chains. |
| `src/` | TypeScript services: `indexer` (event feed → PostgreSQL projection + outbox), `api` (staff + public reader), `authn`/`sessions` (challenge sign-in), `evidence` (private object ACL), `catalogue` (CSV bridge), `audit`/`digest` (receipts, redacted export, op recovery). |
| `db/schema.sql` | PostgreSQL schema — checkpoint, realm events, projections, outbox, sessions, cases, evidence, catalogue, quarantine. |
| `web/` | Staff desk PWA + public read-only page (no build step). |
| `test/` | `node --test` suite; each file provisions a disposable PostgreSQL database. |
| `tools/`, `scripts/` | Staff signing helper, snapshot/rebuild, dev stack, clean-checkout E2E. |
| `docs/` | ADR, deploy guide, machine-readable test ledger. |

## Requirements

- Node ≥ 22.18 (uses type-stripped `.ts` execution — no build step)
- Docker (local PostgreSQL via `docker compose`)
- Gno toolchain built into `.tools/` (see `docs/deploy/local.md`)

## Quick start

```sh
sh scripts/dev-stack.sh up      # postgres + migrations on 127.0.0.1:5433
npm test                        # full suite (disposable per-file databases)
npm run api                     # staff API + desk on :8080
npm run indexer                 # event-feed indexer daemon
```

Realm checks:

```sh
export GNOROOT=$PWD/.tools/src/gno
cd realm/gno.land/r/kittransit/custody
$OLDPWD/.tools/bin/gno lint .
$OLDPWD/.tools/bin/gno test -v .
```

Full clean-checkout journey (toolchain build → lint → tests → real signed
two-institution chain journey → projection + login QA):

```sh
sh scripts/e2e-local.sh
```

## Staff sign-in

Sign-in proves control of an enrolled institution key — a bare address never
authenticates. `POST /api/session/challenge` issues a one-use challenge bound
to network/realm/org/device; the staff member signs the enclosed unsigned tx
with `gnokey sign` (offline flags are fine, no broadcast) and posts the
signature to `POST /api/session`. `tools/staff-sign.sh` wraps the signing
step. Grants are re-verified on every request — revocation is live.

## Boundaries

- The API never holds or signs institution keys.
- Private evidence bytes live outside the web root; every read re-checks
  session + case + live grant, and no reusable URLs exist.
- `confirmed` case state requires a chain receipt whose canonical digest
  matches the reviewed payload — transport success is never confirmation.
- Public testnet deployment is BLOCKED pending explicit authority; all
  evidence here is local-only. See `docs/evidence/test-ledger.json`.
