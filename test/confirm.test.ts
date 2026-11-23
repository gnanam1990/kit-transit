// Case-confirmation rules, exercised through the real HTTP routes:
//   * /transition can never set "confirmed" — client state is not a receipt.
//   * /confirm succeeds only on a realm receipt whose org, op, kind, signer
//     and op digest match the reviewed payload, and only from an expected
//     state (broadcast/unknown).
//   * Digest mismatch, wrong signer, or unreviewed replay -> 409, no
//     state change.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { provisionDb, disposeDb, FakeChain } from "./helpers.ts";
import { createApi } from "../src/api.ts";
import { caseDigest, opBody } from "../src/digest.ts";
import { issueSession } from "../src/sessions.ts";
import type { Pool } from "../src/db.ts";

const REALM = "gno.land/r/kittransit/custody";
let pool: Pool;
let base: string;
let server: ReturnType<typeof createApi>;
const chain = new FakeChain();
let token: string;
const SIGNER = "g1staffa";

async function api(
  path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {},
) {
  const res = await fetch(base + path, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.auth === false ? {} : { authorization: `Bearer ${token}` }),
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function mkReceiveCase(opId: string) {
  const r = await api("/api/cases", {
    method: "POST",
    body: {
      kind: "receive", kitId: "kit-1", opId,
      args: {
        opID: opId, legID: "leg-1",
        accepted: "body:1", conds: "", missing: "lens:1", reason: "lens missing",
      },
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.caseId as string;
}

async function moveTo(caseId: string, states: string[]) {
  for (const to of states) {
    const r = await api(`/api/cases/${caseId}/transition`, {
      method: "POST", body: { state: to },
    });
    assert.equal(r.status, 200, `-> ${to}: ${JSON.stringify(r.body)}`);
  }
}

test.before(async () => {
  pool = await provisionDb("confirm");
  const cfg = {
    databaseUrl: "", rpcUrl: "", realm: REALM,
    evidenceDir: mkdtempSync(join(tmpdir(), "kit-ev-")),
    webDir: mkdtempSync(join(tmpdir(), "kit-web-")),
    apiPort: 0, sessionTtlSec: 3600, pollMs: 1000, pageLimit: 200,
    network: "dev",
  } as any;
  server = createApi({ cfg, pool, chain: chain as any });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await pool.query(
    `INSERT INTO proj_grants (org_id, addr, role, active, granted)
     VALUES ('A',$1,'admin',true,1)`, [SIGNER]);
  const sess = await issueSession(pool, SIGNER, "A", "desk-1", 3600);
  token = sess!.token;
});

test.after(async () => {
  server.close();
  await disposeDb(pool, "confirm");
});

test("/transition can never set confirmed directly", async () => {
  const id = await mkReceiveCase("op-no-confirm");
  await moveTo(id, ["signature-request", "broadcast"]);
  const r = await api(`/api/cases/${id}/transition`, {
    method: "POST", body: { state: "confirmed" },
  });
  assert.equal(r.status, 409);
  const got = await api(`/api/cases/${id}`);
  assert.equal(got.body.state, "broadcast");
});

test("/confirm verifies op digest against the reviewed payload", async () => {
  const opId = "op-ok-confirm";
  const id = await mkReceiveCase(opId);
  await moveTo(id, ["signature-request", "broadcast"]);

  const kase = (await pool.query(
    `SELECT * FROM cases WHERE case_id=$1`, [id])).rows[0] as any;
  const digest = caseDigest(kase, "dev", REALM);
  chain.ops[`A/${opId}`] = {
    status: "confirmed", op: opId, org: "A", kind: "ReceiveDelta",
    digest, opHeight: 31, signer: SIGNER, result: { status: "open" },
  };

  const r = await api(`/api/cases/${id}/confirm`, { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "confirmed");
});

test("digest mismatch on the realm receipt blocks confirmation", async () => {
  const opId = "op-bad-digest";
  const id = await mkReceiveCase(opId);
  await moveTo(id, ["signature-request", "broadcast"]);
  chain.ops[`A/${opId}`] = {
    status: "confirmed", op: opId, org: "A", kind: "ReceiveDelta",
    digest: "ff".repeat(32), opHeight: 31, signer: SIGNER, result: {},
  };
  const r = await api(`/api/cases/${id}/confirm`, { method: "POST" });
  assert.equal(r.status, 409);
  const got = await api(`/api/cases/${id}`);
  assert.equal(got.body.state, "broadcast", "mismatched receipt changes nothing");
});

test("a different signer's receipt is not this case's confirmation", async () => {
  const opId = "op-wrong-signer";
  const id = await mkReceiveCase(opId);
  await moveTo(id, ["signature-request", "broadcast"]);
  const kase = (await pool.query(
    `SELECT * FROM cases WHERE case_id=$1`, [id])).rows[0] as any;
  chain.ops[`A/${opId}`] = {
    status: "confirmed", op: opId, org: "A", kind: "ReceiveDelta",
    digest: caseDigest(kase, "dev", REALM), opHeight: 31,
    signer: "g1other", result: {},
  };
  const r = await api(`/api/cases/${id}/confirm`, { method: "POST" });
  assert.equal(r.status, 409);
});

test("a draft-state case cannot skip to confirmed", async () => {
  const opId = "op-early";
  const id = await mkReceiveCase(opId); // stays 'draft'
  const kase = (await pool.query(
    `SELECT * FROM cases WHERE case_id=$1`, [id])).rows[0] as any;
  chain.ops[`A/${opId}`] = {
    status: "confirmed", op: opId, org: "A", kind: "ReceiveDelta",
    digest: caseDigest(kase, "dev", REALM), opHeight: 31, signer: SIGNER,
    result: {},
  };
  const r = await api(`/api/cases/${id}/confirm`, { method: "POST" });
  assert.equal(r.status, 409);
  const got = await api(`/api/cases/${id}`);
  assert.equal(got.body.state, "draft");
});

test("the canonical body matches the realm arg strings", () => {
  // ReceiveDelta body shape from legs.gno:
  // "leg=" + legID + ";acc=" + accepted + ";cond=" + conds + ";miss=" + missing + ";why=" + reason
  const body = opBody({
    func: "ReceiveDelta", legID: "leg-1", accepted: "body:1",
    conds: "", missing: "lens:1", reason: "lens missing",
  });
  assert.equal(body, "leg=leg-1;acc=body:1;cond=;miss=lens:1;why=lens missing");
});
