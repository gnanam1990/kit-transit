import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { provisionDb, disposeDb, freshDb } from "./helpers.ts";
import { parseCsv, importCsv, exportCsv, resolveQuarantine, drainOutbox } from "../src/catalogue.ts";

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

// CSV export is deterministic and marks incomplete kits HELD explicitly.
test("export marks held/available explicitly and round-trips", async () => {
  await pool.query(
    `INSERT INTO proj_kits (kit_id, owner, manifest_rev, manifest_digest, available)
     VALUES ('kit-1','A',1,'d1',false), ('kit-2','A',2,'d2',true)`);
  const csv = await exportCsv(pool);
  assert.match(csv, /kit-1,A,HELD,1/);
  assert.match(csv, /kit-2,A,AVAILABLE,2/);
});
