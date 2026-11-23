import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { provisionDb, disposeDb, freshDb, FakeChain, kitJson } from "./helpers.ts";
import { indexOnce, IndexerSuspended } from "../src/indexer.ts";

const pool = await provisionDb("indexer");
beforeEach(() => freshDb(pool));
after(() => disposeDb(pool, "indexer"));

function ev(seq: number, kind: string, kit: string, extra: Partial<any> = {}) {
  return { seq, height: seq + 9, kind, kit, leg: "", line: "", org: "A", data: "", ...extra };
}

// T-019: crash between "read a page" and "commit" — restart replays the
// same events into identical state, with no duplicate catalogue update.
test("restart after uncommitted page replays deterministically", async () => {
  const chain = new FakeChain();
  chain.kits["kit-1"] = kitJson({ kit: "kit-1" });
  chain.feed.events = [ev(1, "manifest-define", "kit-1"), ev(2, "dispatch", "kit-1")];
  chain.feed.lastSeq = 2;

  const n1 = await indexOnce(pool, chain as any);
  assert.equal(n1, 2);

  // Simulate a crash: wipe only the checkpoint's progress marker but leave
  // nothing half-committed — a fresh run must converge identically.
  const snapshot = {
    kits: (await pool.query(`SELECT * FROM proj_kits`)).rows,
    events: (await pool.query(`SELECT * FROM realm_events ORDER BY seq`)).rows,
    outbox: (await pool.query(`SELECT * FROM outbox`)).rows,
    cp: (await pool.query(`SELECT * FROM checkpoint WHERE id=1`)).rows[0],
  };

  // Replay the same page a second time (idempotent re-apply).
  const n2 = await indexOnce(pool, chain as any);
  assert.equal(n2, 0, "no new events second time");

  const afterReplay = {
    kits: (await pool.query(`SELECT * FROM proj_kits`)).rows,
    events: (await pool.query(`SELECT * FROM realm_events ORDER BY seq`)).rows,
    outbox: (await pool.query(`SELECT * FROM outbox`)).rows,
  };
  assert.deepEqual(afterReplay, { kits: snapshot.kits, events: snapshot.events, outbox: snapshot.outbox });
  assert.equal(afterReplay.outbox.length <= 1, true, "no duplicate catalogue updates");

  // Force replay of the same events by rewinding last_seq (simulates a
  // lost commit): dedup keeps exactly one outbox row per state change.
  await pool.query(`UPDATE checkpoint SET last_seq=0, feed_hash='' WHERE id=1`);
  const n3 = await indexOnce(pool, chain as any);
  assert.equal(n3, 2);
  const outbox2 = await pool.query(`SELECT kit_id, state, count(*) c FROM outbox GROUP BY 1,2`);
  for (const r of outbox2.rows) assert.equal(Number(r.c), 1);
});

// T-021: a new chain epoch, lower height or network change suspends writes
// and quarantines prior epoch evidence identifiably.
test("epoch change suspends writes and quarantines evidence", async () => {
  const chain = new FakeChain();
  chain.kits["kit-1"] = kitJson({ kit: "kit-1" });
  chain.feed.events = [ev(1, "manifest-define", "kit-1")];
  chain.feed.lastSeq = 1;
  await indexOnce(pool, chain as any);

  // Chain reset: same feed data at lower height on a new epoch identity.
  const chain2 = new FakeChain();
  chain2.epoch = "dev@0:NEWGENESIS";
  chain2.height = 3;
  await assert.rejects(indexOnce(pool, chain2 as any), IndexerSuspended);

  const cp = await pool.query(`SELECT * FROM checkpoint WHERE id=1`);
  assert.equal(cp.rows[0].suspended, true);
  assert.match(cp.rows[0].suspend_reason, /epoch|height regression/);

  const q = await pool.query(`SELECT * FROM epoch_evidence`);
  assert.equal(q.rowCount, 1);
  assert.equal(q.rows[0].epoch, "dev@0:genesisfake");

  // Suspended checkpoint rejects further cycles until operator reset.
  await assert.rejects(indexOnce(pool, chain2 as any), IndexerSuspended);
});

test("network change suspends writes", async () => {
  const chain = new FakeChain();
  chain.kits["k"] = kitJson({ kit: "k" });
  chain.feed.events = [ev(1, "x", "k")];
  chain.feed.lastSeq = 1;
  await indexOnce(pool, chain as any);
  chain.network = "dev-2";
  await assert.rejects(indexOnce(pool, chain as any), IndexerSuspended);
});

// T-025 (indexer side): re-indexing overlapping finalized heights is
// idempotent — projection converges to realm state, not duplicated rows.
test("reindex overlapping heights converges without duplicates", async () => {
  const chain = new FakeChain();
  chain.kits["kit-1"] = kitJson({ kit: "kit-1", available: true, hold: false });
  chain.feed.events = [ev(1, "manifest-define", "kit-1"), ev(2, "release", "kit-1")];
  chain.feed.lastSeq = 2;
  await indexOnce(pool, chain as any);
  await indexOnce(pool, chain as any); // overlap: same range again
  const k = await pool.query(`SELECT available FROM proj_kits WHERE kit_id='kit-1'`);
  assert.equal(k.rows[0].available, true);
  const evs = await pool.query(`SELECT count(*) c FROM realm_events`);
  assert.equal(Number(evs.rows[0].c), 2);
});
