// Rebuild safety (M09/T-025):
//   * rebuild runs in ONE transaction — a mid-feed failure rolls back
//     completely: no half-empty projection, no cleared delivery history
//   * outbox rows are delivery history — status/attempts survive rebuilds
//   * verification uses the realm's own event-feed inventory, so an empty
//     projection against real realm kits reports every kit as missing
//   * per-org held, transit totals and per-line assessment are compared

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { provisionDb, disposeDb, freshDb, FakeChain, kitJson } from "./helpers.ts";
import { indexOnce, IndexerSuspended } from "../src/indexer.ts";
import {
  rebuildProjection, verifyProjection, realmKitInventory,
} from "../src/reindex.ts";

const pool = await provisionDb("reindex");
beforeEach(() => freshDb(pool));
after(() => disposeDb(pool, "reindex"));

function ev(seq: number, kind: string, kit: string, extra: Partial<any> = {}) {
  return { seq, height: seq + 9, kind, kit, leg: "", line: "", org: "A", data: "", ...extra };
}

function twoOrgKit() {
  return kitJson({
    kit: "kit-1", owner: "A", available: false, hold: true,
    needsAssessment: false,
    lines: [
      { id: "body", label: "Body", required: 1, issued: 1,
        held: { A: 0, B: 1 }, inTransit: 0, unlocated: 0, quarantine: 0,
        retired: 0, assessment: "serviceable" },
      { id: "lens", label: "Lens", required: 1, issued: 1,
        held: { A: 0, B: 0 }, inTransit: 1, unlocated: 0, quarantine: 0,
        retired: 0, assessment: "pending" },
    ],
  });
}

function feedWithKit() {
  const chain = new FakeChain();
  chain.kits["kit-1"] = twoOrgKit();
  chain.feed.events = [
    ev(1, "manifest-define", "kit-1"),
    ev(2, "dispatch", "kit-1"),
    ev(3, "receive", "kit-1"),
  ];
  chain.feed.lastSeq = 3;
  return chain;
}

test("rebuild preserves outbox delivery history and converges", async () => {
  const chain = feedWithKit();
  await indexOnce(pool, chain as any);
  // Mark a transition as delivered — that status IS delivery history.
  await pool.query(
    `UPDATE outbox SET status='sent', attempts=2 WHERE kit_id='kit-1'`);
  const before = await pool.query(
    `SELECT kit_id, event_seq, state, status, attempts FROM outbox ORDER BY seq`);

  const n = await rebuildProjection(pool, chain as any);
  assert.equal(n, 3);
  const after = await pool.query(
    `SELECT kit_id, event_seq, state, status, attempts FROM outbox ORDER BY kit_id, event_seq, state`);
  // Same transitions, still marked sent with attempt counts intact.
  const sorted = before.rows
    .sort((a: any, b: any) => `${a.kit_id}${a.event_seq}${a.state}`
      .localeCompare(`${b.kit_id}${b.event_seq}${b.state}`));
  assert.deepEqual(after.rows, sorted);
  // Projection rebuilt to current realm state.
  const k = await pool.query(`SELECT owner, hold FROM proj_kits WHERE kit_id='kit-1'`);
  assert.equal(k.rows[0].owner, "A");
  assert.equal(k.rows[0].hold, true);
  // And verification agrees with the realm.
  assert.deepEqual(await verifyProjection(pool, chain as any), []);
});

test("mid-feed failure rolls back: no half-empty projection, history intact", async () => {
  const chain = feedWithKit();
  await indexOnce(pool, chain as any);
  const snap = {
    kits: (await pool.query(`SELECT * FROM proj_kits ORDER BY kit_id`)).rows,
    lines: (await pool.query(`SELECT * FROM proj_lines ORDER BY kit_id, line_id`)).rows,
    outbox: (await pool.query(`SELECT * FROM outbox ORDER BY seq`)).rows,
    events: (await pool.query(`SELECT * FROM realm_events ORDER BY seq`)).rows,
    cp: (await pool.query(`SELECT * FROM checkpoint WHERE id=1`)).rows[0],
  };

  // A chain that dies while the rebuild is paging the feed.
  const flaky = new FakeChain();
  Object.assign(flaky.kits, chain.kits);
  flaky.feed = chain.feed;
  let calls = 0;
  const orig = flaky.events.bind(flaky);
  flaky.events = async (afterSeq = 0, limit = 200) => {
    calls++;
    if (calls === 2) throw new Error("chain rpc dropped mid-rebuild");
    return orig(afterSeq, limit);
  };
  // Small page so the failure hits after the first applied page.
  await assert.rejects(
    rebuildProjection(pool, flaky as any, 2), /dropped mid-rebuild/);

  const now = {
    kits: (await pool.query(`SELECT * FROM proj_kits ORDER BY kit_id`)).rows,
    lines: (await pool.query(`SELECT * FROM proj_lines ORDER BY kit_id, line_id`)).rows,
    outbox: (await pool.query(`SELECT * FROM outbox ORDER BY seq`)).rows,
    events: (await pool.query(`SELECT * FROM realm_events ORDER BY seq`)).rows,
    cp: (await pool.query(`SELECT * FROM checkpoint WHERE id=1`)).rows[0],
  };
  assert.deepEqual(now, snap, "rollback restored every table byte-for-byte");
});

test("empty projection vs real realm feed reports every kit missing", async () => {
  const chain = feedWithKit();
  await indexOnce(pool, chain as any);
  // Simulate a wiped projection (e.g. restored DB missing proj tables).
  await pool.query(`TRUNCATE proj_kits, proj_lines, proj_legs, proj_exceptions,
                    proj_claims, proj_orgs, proj_grants`);
  const divs = await verifyProjection(pool, chain as any);
  assert.equal(divs.length, 1);
  assert.equal(divs[0]!.kit, "kit-1");
  assert.deepEqual(divs[0]!.diffs, [{ field: "kit", projection: null, realm: "present" }]);
});

test("per-org held, transit and assessment are compared", async () => {
  const chain = feedWithKit();
  await indexOnce(pool, chain as any);
  assert.deepEqual(await verifyProjection(pool, chain as any), []);

  // Diverge the realm's held map and assessment under the projection.
  chain.kits["kit-1"] = twoOrgKit();
  chain.kits["kit-1"].lines[0].held = { A: 1, B: 0 };
  chain.kits["kit-1"].lines[0].assessment = "pending";
  chain.kits["kit-1"].lines[1].inTransit = 0;

  const divs = await verifyProjection(pool, chain as any);
  assert.equal(divs.length, 1);
  const fields = divs[0]!.diffs.map((d) => d.field).sort();
  assert.deepEqual(fields, [
    "line.body.assessment", "line.body.held", "line.lens.transit",
  ]);
});

test("rebuild refuses across a suspended checkpoint", async () => {
  const chain = feedWithKit();
  await indexOnce(pool, chain as any);
  await pool.query(
    `UPDATE checkpoint SET suspended=true, suspend_reason='test suspend' WHERE id=1`);
  const before = await pool.query(`SELECT count(*) c FROM proj_kits`);
  await assert.rejects(
    rebuildProjection(pool, chain as any), IndexerSuspended);
  const after = await pool.query(`SELECT count(*) c FROM proj_kits`);
  assert.equal(after.rows[0].c, before.rows[0].c, "projection untouched");
});

test("realm inventory derives kit ids from the event feed", async () => {
  const chain = feedWithKit();
  chain.kits["kit-2"] = kitJson({ kit: "kit-2" });
  chain.feed.events.push(ev(4, "manifest-define", "kit-2"));
  chain.feed.lastSeq = 4;
  const kits = await realmKitInventory(chain as any, 2); // small pages
  assert.deepEqual([...kits].sort(), ["kit-1", "kit-2"]);
});
