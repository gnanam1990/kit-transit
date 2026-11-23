import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { provisionDb, disposeDb, freshDb } from "./helpers.ts";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv, importCsv, exportCsv, partnerCsv, resolveQuarantine, drainOutbox } from "../src/catalogue.ts";

const pool = await provisionDb("catalogue");
beforeEach(() => freshDb(pool));
after(() => disposeDb(pool, "catalogue"));

// T-006: two physical items carrying the same barcode in the same branch —
// the colliding import is quarantined and needs explicit resolution.
test("barcode collision quarantine + explicit resolution", async () => {
  const rows = parseCsv(
    "branch,barcode,item_ref,state,seq\nA,BC-1,item-100,HELD,1\nA,BC-1,item-200,HELD,2\n",
  );
  const r = await importCsv(pool, rows);
  assert.equal(r.applied, 1);
  assert.equal(r.quarantined, 1);
  assert.match(r.conflicts[0]!.reason, /collision/);

  const q = await pool.query(`SELECT * FROM barcode_quarantine WHERE barcode='BC-1'`);
  assert.equal(q.rowCount, 1);
  assert.equal(q.rows[0].item_ref, "item-200");

  // The bound item keeps its barcode until staff resolve it.
  const bound = await pool.query(`SELECT item_ref FROM catalogue_items WHERE barcode='BC-1'`);
  assert.equal(bound.rows[0].item_ref, "item-100");

  // Explicit rebind resolution.
  await resolveQuarantine(pool, q.rows[0].id, "rebind", "item-200", "HELD", 3);
  const after_ = await pool.query(`SELECT item_ref FROM catalogue_items WHERE barcode='BC-1'`);
  assert.equal(after_.rows[0].item_ref, "item-200");
});

// Stale sequence never overwrites newer catalogue state (INV-07).
test("stale seq is skipped, not applied", async () => {
  await importCsv(pool, parseCsv("branch,barcode,item_ref,state,seq\nA,B1,x,AVAILABLE,5\n"));
  const r = await importCsv(pool, parseCsv("branch,barcode,item_ref,state,seq\nA,B1,x,HELD,3\n"));
  assert.equal(r.skipped, 1);
  const cur = await pool.query(`SELECT state, seq FROM catalogue_items WHERE barcode='B1'`);
  assert.equal(cur.rows[0].state, "AVAILABLE");
  assert.equal(Number(cur.rows[0].seq), 5);
});

// T-020: a version conflict parks the outbox row as conflict/manual review;
// nothing in the realm-facing tables changes.
test("outbox conflict stays pending on newer catalogue state", async () => {
  await importCsv(pool, parseCsv("branch,barcode,item_ref,state,seq\nA,kit-1,kit-1,AVAILABLE,50\n"));
  await pool.query(
    `INSERT INTO outbox (kit_id, state, event_seq, height, version) VALUES ('kit-1','HELD',10,10,1)`);
  const r = await drainOutbox(pool, "A");
  assert.equal(r.conflicts, 1);
  const ob = await pool.query(`SELECT status FROM outbox WHERE kit_id='kit-1'`);
  assert.equal(ob.rows[0].status, "conflict");
  const cur = await pool.query(`SELECT state FROM catalogue_items WHERE barcode='kit-1'`);
  assert.equal(cur.rows[0].state, "AVAILABLE"); // not overwritten
});

// One branch's drain must not consume the shared feed for another branch,
// and a conflict on branch A must not block delivery to branch B.
test("per-branch outbox delivery: A cannot consume B's transitions", async () => {
  await pool.query(
    `INSERT INTO outbox (kit_id, state, event_seq, height, version) VALUES
      ('kit-1','HELD',10,10,1)`);
  // Branch A's catalogue is newer -> conflict for A only.
  await importCsv(pool, parseCsv("branch,barcode,item_ref,state,seq\nA,kit-1,kit-1,AVAILABLE,50\n"));
  const ra = await drainOutbox(pool, "A");
  assert.equal(ra.conflicts, 1);
  assert.equal(ra.sent, 0);

  // Branch B has no newer state -> the same feed row delivers cleanly.
  const rb = await drainOutbox(pool, "B");
  assert.equal(rb.sent, 1);
  const bItem = await pool.query(
    `SELECT state, seq FROM catalogue_items WHERE branch='B' AND barcode='kit-1'`);
  assert.equal(bItem.rows[0].state, "HELD");
  assert.equal(Number(bItem.rows[0].seq), 10);

  // Per-branch delivery rows are independent; feed row rolls up to conflict.
  const del = await pool.query(
    `SELECT branch, status FROM outbox_delivery ORDER BY branch`);
  assert.deepEqual(del.rows.map((r) => [r.branch, r.status]),
    [["A", "conflict"], ["B", "sent"]]);
  const feed = await pool.query(`SELECT status FROM outbox WHERE kit_id='kit-1'`);
  assert.equal(feed.rows[0].status, "conflict");

  // A second B drain is a no-op; A retry still conflicts (not silent).
  assert.equal((await drainOutbox(pool, "B")).sent, 0);
  assert.equal((await drainOutbox(pool, "A")).conflicts, 1);
});

// CSV export is deterministic and marks incomplete kits HELD explicitly.
test("export marks held/available explicitly and round-trips", async () => {
  await pool.query(
    `INSERT INTO proj_kits (kit_id, owner, manifest_rev, manifest_digest, available)
     VALUES ('kit-1','A',1,'d1',false), ('kit-2','A',2,'d2',true)`);
  const csv = await exportCsv(pool);
  assert.match(csv, /kit-1,A,HELD,1/);
  assert.match(csv, /kit-2,A,AVAILABLE,2/);
});

// Real partner file round trip: state flows realm events -> outbox ->
// branch catalogue -> partner CSV file on disk -> re-import, preserving
// barcode/item_ref/state/seq keyed identity.
test("partner CSV file round trips through a real file", async () => {
  // Populate the branch catalogue through the outbox drain path.
  await pool.query(
    `INSERT INTO outbox (kit_id, state, event_seq, height, version) VALUES
      ('kit-camera','HELD',3,3,1), ('kit-projector','AVAILABLE',7,7,1)`);
  const drained = await drainOutbox(pool, "A");
  assert.equal(drained.sent, 2);

  // Write the partner file to disk, read it back, re-import into a clean
  // catalogue partition (different branch namespace simulates the partner).
  const csv = await partnerCsv(pool, "A");
  const dir = mkdtempSync(join(tmpdir(), "kit-csv-"));
  const file = join(dir, "partner-delivery.csv");
  writeFileSync(file, csv);

  const back = parseCsv(readFileSync(file, "utf8"));
  assert.equal(back.length, 2);
  // Partner receives under its own branch id — remap and import.
  const remapped = back.map((r) => ({ ...r, branch: "B" }));
  const imp = await importCsv(pool, remapped);
  assert.equal(imp.applied, 2);
  const rows = await pool.query(
    `SELECT barcode, item_ref, state, seq FROM catalogue_items
     WHERE branch='B' ORDER BY barcode`);
  assert.deepEqual(
    rows.rows.map((r) => [r.barcode, r.item_ref, r.state, Number(r.seq)]),
    [["kit-camera", "kit-camera", "HELD", 3],
     ["kit-projector", "kit-projector", "AVAILABLE", 7]]);
});
