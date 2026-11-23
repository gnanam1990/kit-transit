# Kit Transit — release report

Scope: local-first release. All evidence below is machine-readable or a
named artifact; nothing is asserted without a check behind it.

## Suite status

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Realm unit tests | `GNOROOT=.tools/src/gno .tools/bin/gno test -v realm/gno.land/r/kittransit/custody` | 19/19 PASS, `gno lint` clean | `.tools/bin/gno test` output |
| App tests | `npm test` (per-file disposable PostgreSQL DBs) | 40/40 PASS | `npm test` TAP output |
| Typecheck | `npm run typecheck` | PASS | `tsc --noEmit` |
| Signed local chain | `python3 ../verification/kit-local-probe.py` | 13 tx / h27 journey; `--recovery` 17 tx / h35 | `../verification/kit-local-receipt.json`, `kit-recovery-receipt.json` |
| Indexer QA | `KIT_QA_PAGE_LIMIT=2 / KIT_QA_RELEASE_PROVENANCE=1 / KIT_QA_LOGIN=1 sh ../verification/kit-projection-run.sh` | PASS | `../verification/kit-projection-receipt.json` |
| Browser QA (in-repo) | `npm run browser:qa` (`scripts/browser-qa.mjs`) | All 14 checks PASS | `.local/browser-qa/browser-qa-result.json`, `desk-390.png`, `owner-release-1280.png` |
| Clean checkout E2E | user-owned `scripts/e2e-local.sh` via `kit-release-ei1v9ije` | 33/33 + local E2E, 18 tx, h37, `available=true` | `../verification/kit-release-ei1v9ije/test.log` (revision `8200e37`) |
| Snapshot restore | user-owned `tools/snapshot.sh` QA | restored case + 68 evidence bytes; existing DB protected; realm converged | `../verification/kit-restore-result.json`, `kit-restore-regression.log` |

## Browser QA harness (`npm run browser:qa`)

Self-contained: creates two disposable `gnokey` homes, a disposable
`gnodev` chain (`kit-browser-qa`), a scratch PostgreSQL database, runs the
real API, and drives headless Chrome. Verified this run:

- **Real sign-in** — secp256k1 `gnokey` signature on the API's own
  challenge tx (account/sequence 0/0 proof doc) → session 201.
- **Real receive** — institution B picks `camera` + the open leg, scans
  five, exceptions `lens`, downloads the unsigned tx, signs in place with
  the real key, `gnokey broadcast`, `/confirm` → `confirmed`
  (op `op-mwtktdkc-eti780`, tx
  `frETSwUMhja0AObY6FfUTa3Sw3fDbtZIkqUhH0+wegw=`). Every broadcast is
  verified applied via `tx?hash` before `/confirm`, so a chain revert
  surfaces the realm panic instead of a silent `unknown`.
- **Keyboard UX** at 1280px and 390px — Enter scans, single aria-live
  announcement per scan, focus retained on the scan field, exception
  entry reachable by keyboard.
- **Offline cold reload** — service worker serves the shell offline;
  IndexedDB restores the six-line draft; cache-age badge shown; `/api/`
  is never cached.
- **Stale revision** — a real `AmendManifest` between draft and sign-off
  renders the chain-derived `rev 1 → rev 2` diff (immutable revisions via
  `/api/reader/manifest`), blocks signing, persists across leave/reopen
  (`pendingManifestReview` on the draft), and re-enables only after the
  explicit re-review confirmation.
- **Institution queue** — B sees both open incoming legs with
  received/expected counts, oldest outstanding (`tube`), and per-event
  heights, plus the open `lens` exception; A sees the `camera`
  needs-inspection row after the return legs close.
- **Evidence upload retry** — post-confirmation upload failure surfaces
  without touching the confirmed receipt; retry succeeds.
- **Catalogue** — branch-scoped outbox drain delivers 2 rows;
  `partner.csv` exports kit rows.
- **Return + recovery legs (CLI)** — exception closed to unlocated,
  five lines returned, `lens` found/confirmed and returned separately;
  realm shows `needsAssessment` with all six lines held by A.
- **Owner assessment + release (separate A signer)** — non-owner B sees
  no assess/release controls; A assesses all six lines serviceable and
  releases through the same reviewed-payload → case → sign → broadcast →
  confirm pipeline (ops `op-mwtktl5v-0c0tee`, `op-mwtktmjc-impbkr`);
  `GetKit` reports `available=true`; the audit tab records `#21 h41 ·
  release · camera` back to `#1 h3 · org-enroll`.
- **Shared-desk logout** — sign-out clears the token, signed-in DOM
  (case list, assessment selects) and reloads to the sign-in view.

## Case ledger

`docs/evidence/test-ledger.json`: **29 PASS / 1 BLOCKED / 0 PENDING.**

T-029 (public testnet deployment) remains **BLOCKED** — there is no
explicit deployment authority or testnet access for this build; the
registrar refuses to bootstrap to the gnodev default outside `dev`
chains, so a public deploy cannot accidentally bind the well-known test
key.

## Notable fixes in this release

- Per-branch catalogue outbox delivery (`outbox_delivery`): the first
  branch to drain no longer consumes shared feed rows for other branches;
  per-branch sent/conflict/retry history; `outbox.status` is now a rollup.
- Service worker navigation fallback (`web/sw.js`): cached `index.html`
  is served for offline navigations; `/api/` responses are never cached.
- Evidence upload moved to the case view with retained-file retry —
  uploads work after a receipt is already confirmed.
- Institution work queue (`GET /api/queue` + queue tabs): incoming/
  outgoing open legs, open exceptions, owner needs-inspection rows and
  the org-scoped audit tail, all from chain-derived projection state.
- Owner assessment and release through the staff desk: per-line `ok`/
  `damaged`/`disputed` review, `AssessReturn`/`ReleaseKit` cases signed
  by the owner key and confirmed only by the matching realm receipt.
- Stale-revision re-review persisted on the draft (`pendingManifestReview`)
  so the block survives leaving and reopening the draft; the chain
  before/after diff must be rendered before confirmation is possible.
- Shared-desk logout clears all signed-in DOM and returns to sign-in.
- `scripts/browser-qa.mjs`: portable in-repo harness replacing the
  sibling verification scripts for desk-level evidence.

## Known limitations

- Clean-checkout evidence (`kit-release-ei1v9ije`) was captured at
  revision `8200e37`, before this commit; it covers the product as of
  that revision. Re-run `scripts/e2e-local.sh` on the release commit for
  same-revision evidence.
- Restore QA artifacts are produced by the user-owned `tools/snapshot.sh`
  path; this commit did not modify that tooling.
- The `gnokey` relay (`KIT_GNOKEY_BIN`) transmits only the document staff
  signed and runs against an isolated temporary `-home`; it cannot
  generate signatures and holds no keys.
- T-029 public-network demo stays blocked pending explicit deployment
  authority.
