import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { provisionDb, disposeDb, freshDb, kitJson } from "./helpers.ts";
import { exportCase, lookupOperation, compareProjectionToRealm } from "../src/audit.ts";

const pool = await provisionDb("audit");
beforeEach(() => freshDb(pool));
after(() => disposeDb(pool, "audit"));

// T-026: a dropped broadcast response is recovered by org+op query — the
// exact receipt comes back without a duplicate leg.
test("operation lookup recovers receipt by org+op", async () => {
  const chain = {
    async query(fn: string) {
      if (fn.startsWith("GetOp(")) {
        return {
          chainId: "dev", realm: "gno.land/r/kittransit/custody", height: 27,
          status: "confirmed", op: "op-dsp-1", org: "A", kind: "Dispatch",
          digest: "ab".repeat(32), opHeight: 12,
          signer: "g1aaa", result: { leg: "leg-1", status: "open" },
        };
      }
      return {};
    },
  };
  const res = await lookupOperation(pool, chain as any, "A", "op-dsp-1");
  assert.equal((res as any).status, "confirmed");
  assert.equal((res as any).digest, "ab".repeat(32));
  const cached = await pool.query(`SELECT * FROM proj_ops WHERE op_id='op-dsp-1'`);
  assert.equal(cached.rowCount, 1);
  assert.equal(cached.rows[0].digest, "ab".repeat(32));
});

// Same operation id at two orgs resolves independently.
test("same op id at two orgs resolves per org", async () => {
  const chain = {
    async query(fn: string) {
      const org = fn.includes('"B"') ? "B" : "A";
      return { status: "confirmed", op: "op-1", org, kind: "ReceiveDelta",
        digest: org === "B" ? "bb".repeat(32) : "aa".repeat(32), opHeight: 9,
        signer: "x", result: {} };
    },
  };
  const a = await lookupOperation(pool, chain as any, "A", "op-1");
  const b = await lookupOperation(pool, chain as any, "B", "op-1");
  assert.equal((a as any).digest, "aa".repeat(32));
  assert.equal((b as any).digest, "bb".repeat(32));
  const all = await pool.query(`SELECT count(*) c FROM proj_ops WHERE op_id='op-1'`);
  assert.equal(Number(all.rows[0].c), 2);
});

// T-027: the external-reviewer export carries no private fields, no patron
// references and no object links; missing data stays explicit.
test("redacted export excludes private material and stays explicit", async () => {
  await pool.query(`INSERT INTO proj_kits (kit_id, owner, manifest_rev, manifest_digest, available, hold)
    VALUES ('kit-x','A',2,'${"d".repeat(64)}',false,true)`);
  await pool.query(`INSERT INTO proj_lines (kit_id, line_id, issued, held) VALUES ('kit-x','lens',1,'{}')`);
  await pool.query(`INSERT INTO evidence_objects (object_id, case_id, org_id, mime, bytes, sha256, uploaded_by)
    VALUES ('obj-secret','case-1','A','image/png',10,'s','g1staff')`);
  await pool.query(`INSERT INTO sessions (token, addr, org_id, device_id, expires_at)
    VALUES ('tok1','g1staff','A','dev9', now() + interval '1 hour')`);

  const out = await exportCase(pool, "kit-x");
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /obj-secret|g1staff|tok1|dev9/);
  assert.equal((out as any).privateEvidence, "excluded-by-policy");
  assert.equal((out as any).staffIdentities, "excluded-by-policy");
  assert.equal((out as any).hold, true);
});

// T-025 (comparison side): projection-vs-realm diff is empty after faithful
// reindex and non-empty when projection diverges.
test("projection/realm comparison reports divergences", async () => {
  const realmKit = kitJson({ kit: "kit-c", available: true, hold: false });
  const chain = {
    async query(fn: string) {
      if (fn.startsWith("GetKit(")) return realmKit;
      return {};
    },
  };
  await pool.query(`INSERT INTO proj_kits (kit_id, owner, manifest_rev, manifest_digest, available, hold)
    VALUES ('kit-c','A',1,'${"d".repeat(64)}',true,false)`);
  await pool.query(`INSERT INTO proj_lines (kit_id, line_id, issued, held) VALUES ('kit-c','body',1,'{"A":1}')`);
  const diffs = await compareProjectionToRealm(pool, chain as any, "kit-c");
  assert.equal(diffs.length, 0, "faithful projection has no diffs");

  await pool.query(`UPDATE proj_lines SET unlocated=1 WHERE kit_id='kit-c'`);
  const diffs2 = await compareProjectionToRealm(pool, chain as any, "kit-c");
  assert.equal(diffs2.some((d) => d.field === "line.body.unlocated"), true);
});
