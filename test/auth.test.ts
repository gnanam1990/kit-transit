// Staff sign-in release checks, exercised through the real HTTP routes:
// a bare public address can never mint a session — the desk must fetch a
// one-use challenge bound to network/realm/org/device, sign it with the
// institution key, and pass signature + derived-address + live-grant
// verification. Grant revocation revokes existing sessions' access.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { provisionDb, disposeDb, FakeChain } from "./helpers.ts";
import { createApi } from "../src/api.ts";
import { indexOnce } from "../src/indexer.ts";
import { addrFromPubkey } from "../src/authn.ts";
import type { Pool } from "../src/db.ts";

let pool: Pool;
let base: string;
let server: ReturnType<typeof createApi>;
const chain = new FakeChain();

function secp256k1StaffKey() {
  // gnokey's default key type: secp256k1, compressed 33-byte pubkey.
  const kp = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const der = kp.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const unc = der.subarray(der.length - 65); // uncompressed point 04|x|y
  const compressed = Buffer.concat([
    Buffer.from([unc[64]! & 1 ? 0x03 : 0x02]), unc.subarray(1, 33),
  ]);
  const signDoc = (doc: string) => cryptoSign(
    "sha256", Buffer.from(doc, "utf8"),
    { key: kp.privateKey, dsaEncoding: "ieee-p1363" });
  return { kp, pubkey: compressed, addr: addrFromPubkey(compressed), signDoc };
}

function ed25519StaffKey() {
  const kp = generateKeyPairSync("ed25519");
  const pubDer = kp.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pubkey = pubDer.subarray(pubDer.length - 32);
  const signDoc = (doc: string) =>
    cryptoSign(null, Buffer.from(doc, "utf8"), kp.privateKey);
  return { kp, pubkey, addr: addrFromPubkey(pubkey), signDoc };
}

const staff = secp256k1StaffKey();
const intruder = secp256k1StaffKey();

function ev(seq: number, kind: string, org = "") {
  return { seq, height: seq, kind, kit: "", leg: "", line: "", org, data: "" };
}

async function api(
  path: string, opts: { method?: string; token?: string; body?: unknown; raw?: string } = {},
) {
  const res = await fetch(base + path, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body || opts.raw ? { "content-type": "application/json" } : {}),
    },
    body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function signChallenge(key = staff) {
  const ch = await api("/api/session/challenge", {
    method: "POST",
    body: { addr: key.addr, org: "A", deviceId: "desk-1" },
  });
  if (ch.status !== 200) return { status: ch.status } as any;
  const sig = key.signDoc(ch.body.signdoc);
  const login = await api("/api/session", {
    method: "POST",
    body: {
      challengeId: ch.body.challengeId,
      pubkey: key.pubkey.toString("base64"),
      signature: sig.toString("base64"),
    },
  });
  return { status: login.status, token: login.body.token, challengeId: ch.body.challengeId };
}

test.before(async () => {
  pool = await provisionDb("auth");
  const cfg = {
    databaseUrl: "", rpcUrl: "", realm: "gno.land/r/kittransit/custody",
    evidenceDir: mkdtempSync(join(tmpdir(), "kit-ev-")),
    webDir: mkdtempSync(join(tmpdir(), "kit-web-")),
    apiPort: 0, sessionTtlSec: 3600, pollMs: 1000, pageLimit: 200,
    network: "dev",
  } as any;
  server = createApi({ cfg, pool, chain: chain as any });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Enroll org A with the staff key as admin through the projected event
  // stream — this is how real realm events populate proj_grants.
  chain.orgs["A"] = {
    active: true, enrollHeight: 1,
    grants: [{ addr: staff.addr, role: "admin", active: true, granted: 1, revoked: 0 }],
  };
  chain.feed.events = [ev(1, "org-enroll", "A")];
  chain.feed.lastSeq = 1;
  await indexOnce(pool, chain as any);
});

test.after(async () => {
  server.close();
  await disposeDb(pool, "auth");
});

test("org enrolment projects grants so staff can sign in", async () => {
  const g = await pool.query(`SELECT * FROM proj_grants WHERE org_id='A'`);
  assert.equal(g.rowCount, 1);
  assert.equal(g.rows[0].addr, staff.addr);
  assert.equal(g.rows[0].active, true);
});

test("a public address alone cannot authenticate", async () => {
  const r = await api("/api/session", {
    method: "POST", body: { addr: staff.addr, org: "A", deviceId: "desk-1" },
  });
  assert.equal(r.status, 403);
  const noRows = await pool.query(`SELECT count(*) c FROM sessions`);
  assert.equal(Number(noRows.rows[0].c), 0, "no session minted from bare address");
});

test("challenge refused for an address with no grant", async () => {
  const ch = await api("/api/session/challenge", {
    method: "POST", body: { addr: intruder.addr, org: "A", deviceId: "desk-1" },
  });
  assert.equal(ch.status, 403);
});

test("genuine secp256k1 signed login issues a working session", async () => {
  const r = await signChallenge(staff);
  assert.equal(r.status, 201, `login failed: ${JSON.stringify(r)}`);
  const kits = await api("/api/kits", { token: r.token });
  assert.equal(kits.status, 200);
});

test("signature by the wrong key is rejected", async () => {
  const ch = await api("/api/session/challenge", {
    method: "POST", body: { addr: staff.addr, org: "A", deviceId: "desk-1" },
  });
  assert.equal(ch.status, 200);
  const sig = intruder.signDoc(ch.body.signdoc);
  const login = await api("/api/session", {
    method: "POST",
    body: {
      challengeId: ch.body.challengeId,
      pubkey: intruder.pubkey.toString("base64"),
      signature: sig.toString("base64"),
    },
  });
  assert.equal(login.status, 403);
});

test("a challenge cannot be replayed", async () => {
  const ch = await api("/api/session/challenge", {
    method: "POST", body: { addr: staff.addr, org: "A", deviceId: "desk-1" },
  });
  const sig = staff.signDoc(ch.body.signdoc);
  const body = {
    challengeId: ch.body.challengeId,
    pubkey: staff.pubkey.toString("base64"),
    signature: sig.toString("base64"),
  };
  assert.equal((await api("/api/session", { method: "POST", body })).status, 201);
  assert.equal(
    (await api("/api/session", { method: "POST", body })).status, 403,
    "one-use challenge must reject replay");
});

test("grant revocation in the realm kills live session access", async () => {
  const { token } = await signChallenge(staff);
  assert.ok(token);
  assert.equal((await api("/api/kits", { token })).status, 200);

  // Realm-side revocation, projected via the event stream.
  chain.orgs["A"] = {
    active: true, enrollHeight: 1,
    grants: [{ addr: staff.addr, role: "admin", active: false, granted: 1, revoked: 40 }],
  };
  chain.feed.events = [ev(2, "role-revoke", "A")];
  chain.feed.lastSeq = 2;
  await indexOnce(pool, chain as any);

  const denied = await api("/api/kits", { token });
  assert.equal(denied.status, 401, "revoked grant must end session access");
});
