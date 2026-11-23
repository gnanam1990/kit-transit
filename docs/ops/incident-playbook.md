# Kit Transit — operator incident playbook

Operational procedures for the custody desk. Every procedure names the
observable symptom, the check, the recovery action and how to verify it
worked. The Gno realm is the source of truth for custody; PostgreSQL is a
rebuildable projection — when in doubt, trust the realm and re-verify the
projection.

Dashboard quick checks:

```
GET /api/health                          # {ok, checkpoint:{height,last_seq,suspended,suspend_reason}}
GET /api/reader/kit?kit=<id>             # direct realm read, no SQL
node src/reindex.ts --verify             # projection-vs-realm divergence report, no rebuild
```

## 1. Staff signer refusal / wrong key

**Symptom.** Desk is at "Review & sign"; the staff member cancels the
`gnokey sign` prompt, or signs with a key that holds no desk grant.

**What happened.** Nothing was broadcast. The case stays in its reviewed
state (`signature-request`) with the SAME case id and operation id — by
design a refused prompt never creates a new operation.

**Procedure.**

1. Re-open the case list; the same case is still there with its original
   `op_id`. Do NOT create a new case — a second case for the same intent
   would collide on the op digest.
2. If the wrong key signed, the realm rejects the tx (`lacks role` /
   `no active grant`) — confirm the staff member signs with the key
   enrolled for their org via `gnokey list -home <home>`.
3. Re-export the unsigned tx (`GET /api/cases/:id/signable`), re-sign,
   re-broadcast.

**Verify.** `GET /api/reader/op?org=<org>&op=<op>` shows the op result on
the realm; `/api/cases/:id` reaches `confirmed`.

## 2. Dropped broadcast response (hash lost, relay timeout)

**Symptom.** Staff broadcast the signed tx externally (their own
`gnokey broadcast`) but the terminal closed before the hash was captured,
or `POST /broadcast` timed out mid-submit. The case sits at `broadcast` or
`unknown` and never confirms.

**Procedure.**

1. Look the operation up directly on the realm — no guessing:

   ```
   GET /api/ops/lookup?org=<org>&op=<op-id>     # -> GetOp result incl. tx height/hash
   ```
2. Take the transaction hash from the lookup (or from
   `gnokey query txs` on the node) and submit it:
   `POST /api/cases/:id/broadcast` `{ "txhash": "..." }`.
3. `POST /api/cases/:id/confirm` — the API re-reads the chain receipt and
   confirms ONLY if org, op, function, signer and the reviewed payload
   digest all match. A wrong-hash submission stays unconfirmed; nothing
   bad happens, retry with the real hash.

**Verify.** Case state `confirmed`; `GetOp` on the realm shows
`result` non-empty.

## 3. Chain replaced / stale epoch (checkpoint suspended)

**Symptom.** `/api/health` shows `checkpoint.suspended=true` with a
`suspend_reason` like `network changed`, `epoch regression`,
`height moved backwards` or `feed hash mismatch`. The indexer refuses
writes; `/api/kits` keeps serving the last-good projection (stale).

**What happened.** The node behind `KIT_RPC_URL` now presents a different
network/chain-id, a lower height, a new epoch, or an event feed whose
prefix disagrees with `realm_events`. The indexer quarantined the
prior-epoch rows into `epoch_evidence` instead of silently overwriting
provenance.

**Procedure.**

1. Confirm with operations whether the chain really was reset/redeployed
   (a `gnodev` restart with a fresh datadir produces exactly this).
2. Read `suspend_reason` and `epoch_evidence` — they record what diverged.
3. If the new chain is legitimate: point config at it and rebuild —
   `node src/reindex.ts`. The rebuild runs in ONE transaction; a mid-run
   failure leaves the previous projection intact.
4. If the suspension is unexpected, STOP: do not clear `epoch_evidence`
   or `checkpoint` — that is the forensic record.

**Verify.** `node src/reindex.ts --verify` exits 0
(`projection converges with realm inventory`); `suspended=false`.

## 4. Indexer lag or gap in the event feed

**Symptom.** `checkpoint.last_seq` stops advancing while realm queries
show newer state.

**Check.** `GetEvents(afterSeq)` returned a non-contiguous page (real gap)
or the node is down (`/api/health` unreachable vs. just stale).

**Procedure.**

1. Restart the API/indexer process — `indexOnce` resumes from
   `last_seq` and replays overlapping events idempotently (dedup is on
   `(kit_id, event_seq, state)` for the outbox and on seq for
   `realm_events`).
2. A page limit (`KIT_PAGE_LIMIT`) never overshoots: the checkpoint only
   advances to the last CONTIGUOUS applied seq.
3. Persistent gap (node skipped seqs): rebuild via `node src/reindex.ts`,
   which applies only the contiguous prefix and reports the boundary.

**Verify.** `checkpoint.last_seq` reaches the feed head; `--verify`
converges.

## 5. Catalogue conflict / manual review

**Symptom.** `POST /api/catalogue/drain` reports `conflicts > 0`;
`outbox.status='conflict'` on the feed row.

**What happened.** The branch's `catalogue_items` row already carries a
newer `seq` than the outbox transition — typically a partner CSV import
applied later data than the custody feed. Delivery state is per-branch
(`outbox_delivery`): branch A's conflict never blocks branch B.

**Procedure.**

1. Inspect: `SELECT * FROM outbox_delivery WHERE status='conflict'` and
   compare against `catalogue_items` for that branch/barcode.
2. If the catalogue row is right (newer data wins), leave it — the
   delivery stays `conflict` for audit and the feed row rolls up to
   `conflict` as an attention flag.
3. If the custody transition should win, reconcile the catalogue row's
   `seq` (re-import with corrected seq or resolve via partner exchange),
   then re-run the drain — `conflict` rows are retried, not dropped.

**Verify.** `drainOutbox` returns `sent` for the branch; `partner.csv`
reflects the reconciled state. Realm custody is never touched by any of
this — confirm via `GET /api/reader/kit`.

## 6. Evidence upload failure

**Symptom.** The case view reports "upload failed" or the API returns 4xx
on `POST /api/evidence`.

**Causes, in order.**

- Unsupported content type — the store accepts only validated photo/PDF
  magic bytes (415). Convert the file, retry.
- Case not confirmed/authorized for the caller's org (403) — attachments
  are case-scoped; pick the case from the desk's own case list.
- Store unreachable / disk error (5xx) — retry; the failure does NOT
  touch the case or the chain receipt.

**Procedure.** Use the desk's retry button (the file is retained), or
re-select the file and upload again. Duplicate content under the same
case deduplicates; the same bytes under a different case create a
separately-authorized object — that is intended.

**Verify.** `GET /api/evidence/:object` (authorized session) returns the
bytes; the case stays `confirmed` throughout.

## 7. Reindex crashed mid-run

**Symptom.** `reindex failed` exit 3, or the process was killed.

**What happened.** The whole rebuild is a single PostgreSQL transaction —
projection rows and the checkpoint either land together or not at all.
Nothing is half-applied. `outbox` delivery history and `realm_events`
provenance are never truncated by a rebuild.

**Procedure.** Fix the cause (usually chain connectivity), re-run
`node src/reindex.ts`. Safe to repeat.

**Verify.** Exit 0, then `--verify` shows no divergences.

## 8. Staff sign-in failures

- `403` on challenge request: the address holds no active grant in that
  org — enroll/rotate the key on-chain first (registrar `EnrollOrg`,
  org admin `GrantRole`), let the indexer project `proj_grants`, retry.
- `403` challenge invalid/used/expired: challenges are one-use and live
  120s — request a fresh one.
- `403` signature/binding errors: the signed doc must be the challenge's
  own `tx` field signed with `-account-number 0 -account-sequence 0`
  (it is a proof doc, never broadcast); `tools/staff-sign.sh` does this.
- Sessions die the moment the grant is revoked — grants are re-checked
  on every request, not just at login.
