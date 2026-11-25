# Kit Transit — demo/video script (real case)

A ~4-minute walkthrough built on the actual verified journey: institution
A lends a six-component `camera` kit to institution B; B receives five,
records a missing-lens exception, the lens arrives later, B returns the
kit, A assesses, the kit returns to circulation. Every step below ran on
a real local `gnodev` chain with two independent `gnokey` wallets — the
evidence references are recorded artifacts, not staging.

## Cast & setup (0:00–0:20)

- Two institutions: **A** (owner) and **B** (borrower), each with its own
  `gnokey` home and enrolled address. Registrar = package deployer.
- Running: `gnodev` (realm deployed), PostgreSQL (projection), the API
  (`npm run api`), Chrome at phone width on the staff desk.

> Narration: "Whole-kit checkout can't say which component arrived. Kit
> Transit attests per component, on-chain, per institution signature."

## Act 1 — Define & dispatch (0:20–0:50)

1. A defines the manifest: six lines — `body, lens, card, strap, cap,
   cable` — each qty 1, baseline condition `good`.
   `DefineManifest(manifest-kit-1, …)` — signed by A's key.
2. A dispatches to B: `Dispatch(dispatch-1, kit, B, expectedRev=1, …)`.
   Six units move held→in-transit. Show `GET /api/reader/kit?kit=camera`:
   `inTransit: 6`, one `open` leg.

## Act 2 — The five/six receipt (0:50–2:00) — staff desk, phone width

1. B's staffer signs in: `Get sign-in challenge` → `tools/staff-sign.sh`
   signs with B's real `gnokey` key → session issued (201).
2. Pick `camera`, pick the open incoming leg — the desk shows the leg's
   dispatched lines (`lens×1` visible).
3. Scan five barcodes — `body, card, strap, cap, cable` — each Enter
   announces once, focus returns to the scan field.
4. Mark `lens` missing with reason `not in case`.
5. **Review & sign** → `Download unsigned tx` → staff signs offline with
   `gnokey` → `gnokey broadcast` → paste the TX HASH →
   `Confirm from chain`.

> The desk confirms ONLY against the real chain receipt for that exact
> op/signer/payload digest. Recorded run:
> op `op-mwtjz0qn-kqrmqu`, tx
> `3j5DHNGtP6+sJG/n+I4D8rcXN3HWiEBfq0M3CvlPloY=` — state `confirmed`.

6. Public reader (`Public view` tab, unauthenticated): kit `camera` shows
   HELD, five received at B, open exception `exc` for `lens` — private
   fields absent.

## Act 3 — The lens arrives (2:00–2:40)

1. Same leg, supplemental `ReceiveDelta` from B: `lens` accepted.
   On the realm the exception resolves; the ORIGINAL five/six receipt
   stays immutable in `GetOp`/events.
2. Kit is still not `available` — it is B's held custody now.

## Act 4 — Return, assess, release (2:40–3:30)

1. B `StartReturn` → reverse leg; A `AssessReturn` per line
   (`serviceable`). Recovered-then-returned lens is included — a
   supplementary return anchors to the originating outbound delivery,
   not the immediately-last leg.
2. A `ReleaseKit` → `available: true`. Catalogue outbox attributes
   AVAILABLE to the RELEASE event, not the earlier receipt
   (provenance: `deliveryAttributedTo: "release"`).

## Act 5 — Independent verification (3:30–4:00)

1. Any reader replays the truth: `GetEvents(0)` lists every signed
   transition with height + event seq; `GetOp` per institution shows the
   exact attested payload digest.
2. The projection is derived, not authoritative:
   `node src/reindex.ts --verify` → `projection converges with realm
   inventory`.
3. Branch-scoped catalogue interchange: `GET
   /api/catalogue/partner.csv` → import on the partner side.

## Offline sidebar (optional, +30s)

Toggle DevTools offline → reload: the shell loads from the service
worker, the IndexedDB draft restores all six lines, the badge reads
"Offline — showing last known state". Reconnect → draft diffs against
the current manifest rev before sign-off.

## Evidence pointers

- Browser run: `.local/browser-qa/browser-qa-result.json`,
  `.local/browser-qa/desk-390.png`
- Signed-chain receipts: `../verification/kit-local-receipt.json`,
  `kit-recovery-receipt.json`, `kit-projection-receipt.json`
- Restore/clean-checkout: `../verification/kit-restore-result.json`,
  `../verification/kit-release-*/test.log`
- Case ledger: `docs/evidence/test-ledger.json`
