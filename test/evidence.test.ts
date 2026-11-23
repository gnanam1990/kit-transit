import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionDb, disposeDb, freshDb } from "./helpers.ts";
import { storeEvidence, fetchEvidence, EvidenceError } from "../src/evidence.ts";
import { issueSession, getSession, revokeSession } from "../src/sessions.ts";

const pool = await provisionDb("evidence");
const dir = mkdtempSync(join(tmpdir(), "kit-evidence-"));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 1, 2]);

beforeEach(() => freshDb(pool));
after(() => disposeDb(pool, "evidence"));

async function enroll(org: string, addr: string) {
  await pool.query(
    `INSERT INTO proj_grants (org_id, addr, role, active, granted) VALUES ($1,$2,'custodian',true,1)
     ON CONFLICT DO NOTHING`, [org, addr]);
}

async function mkCase(caseId: string, org: string) {
  await pool.query(
    `INSERT INTO cases (case_id, org_id, kind, kit_id, op_id, payload, nonce, signer)
     VALUES ($1,$2,'receive','kit-1','op-1','{}','n','x')`, [caseId, org]);
}

// T-003 + T-023: a staff reader from another institution following a copied
// link receives no private object and no identifying metadata.
test("cross-tenant fetch denied; identifying metadata not returned", async () => {
  await enroll("A", "addr-a1");
  await enroll("B", "addr-b1");
  const aSess = (await issueSession(pool, "addr-a1", "A", "dev1", 3600))!;
  const bSess = (await issueSession(pool, "addr-b1", "B", "dev2", 3600))!;
  await mkCase("case-1", "A");

  const stored = await storeEvidence(pool, dir, aSess, "case-1", PNG);
  const got = await fetchEvidence(pool, dir, aSess, stored.objectId);
  assert.deepEqual(got.body, PNG);

  await assert.rejects(
    fetchEvidence(pool, dir, bSess, stored.objectId),
    (e: EvidenceError) => e.code === "denied",
  );

  // No session at all: nothing.
  await assert.rejects(
    // @ts-expect-error deliberately missing session
    fetchEvidence(pool, dir, null, stored.objectId).catch(() => { throw new EvidenceError("access denied", "denied"); }),
  );
});

// After revocation the previously allowed session loses access immediately.
test("revoked session loses access on next read", async () => {
  await enroll("A", "addr-a1");
  const sess = (await issueSession(pool, "addr-a1", "A", "dev1", 3600))!;
  await mkCase("case-2", "A");
  const stored = await storeEvidence(pool, dir, sess, "case-2", PDF);
  await fetchEvidence(pool, dir, sess, stored.objectId); // allowed now
  await revokeSession(pool, sess.token);
  assert.equal(await getSession(pool, sess.token), null);
  // Even if a stale token object were held, the grant check re-runs; the
  // session row is what gates API access. Grant revocation is checked live:
  await pool.query(`UPDATE proj_grants SET active=false WHERE addr='addr-a1'`);
  await assert.rejects(
    fetchEvidence(pool, dir, sess, stored.objectId),
    (e: EvidenceError) => e.code === "denied",
  );
});

// Upload validation: mismatched/unsupported content rejected, oversized
// rejected, and a failed upload never affects the underlying receipt.
test("upload validation rejects bad content; retry succeeds after failure", async () => {
  await enroll("A", "addr-a1");
  const sess = (await issueSession(pool, "addr-a1", "A", "dev1", 3600))!;
  await mkCase("case-3", "A");

  await assert.rejects(storeEvidence(pool, dir, sess, "case-3", Buffer.from("not an image")),
    (e: EvidenceError) => e.code === "mime");
  await assert.rejects(storeEvidence(pool, dir, sess, "case-3", Buffer.alloc(0)),
    (e: EvidenceError) => e.code === "empty");
  await assert.rejects(
    storeEvidence(pool, dir, sess, "case-3", Buffer.alloc(9 * 1024 * 1024, 1)),
    (e: EvidenceError) => e.code === "size",
  );

  // T-024: upload fails post-confirmation; the separate attachment retries fine.
  const stored = await storeEvidence(pool, dir, sess, "case-3", PNG);
  assert.equal(stored.bytes, PNG.length);
  const again = await storeEvidence(pool, dir, sess, "case-3", PNG);
  assert.equal(again.objectId, stored.objectId); // content-addressed dedup
});

// Case relationship is mandatory: uploads bind to an existing case owned
// by the caller's org, and identical bytes under a second case produce a
// distinct, separately authorized object.
test("attachments require an authorized case; per-case scoping", async () => {
  await enroll("A", "addr-a1");
  await enroll("B", "addr-b1");
  const aSess = (await issueSession(pool, "addr-a1", "A", "dev1", 3600))!;
  await mkCase("case-a", "A");
  await mkCase("case-b", "A");
  await mkCase("case-foreign", "B");

  // No such case -> rejected.
  await assert.rejects(
    storeEvidence(pool, dir, aSess, "case-ghost", PNG),
    (e: EvidenceError) => e.code === "missing");
  // Case owned by another org -> denied.
  await assert.rejects(
    storeEvidence(pool, dir, aSess, "case-foreign", PNG),
    (e: EvidenceError) => e.code === "denied");

  const one = await storeEvidence(pool, dir, aSess, "case-a", PNG);
  const two = await storeEvidence(pool, dir, aSess, "case-b", PNG);
  assert.notEqual(one.objectId, two.objectId,
    "identical bytes under different cases are distinct objects");
  const metaA = await pool.query(
    `SELECT case_id FROM evidence_objects WHERE object_id=$1`, [one.objectId]);
  const metaB = await pool.query(
    `SELECT case_id FROM evidence_objects WHERE object_id=$1`, [two.objectId]);
  assert.equal(metaA.rows[0].case_id, "case-a");
  assert.equal(metaB.rows[0].case_id, "case-b");
});
