import { verifyRestore } from "./restore.mjs";
import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const load = (p) => import(pathToFileURL(resolve(p)).href);
const [rpc, addr, keyHome, stage] = process.argv.slice(2);
if (stage !== "partial") process.exit(0);
assert.match(rpc, /^127\.0\.0\.1:\d+$/);
const { makePool } = await load("src/db.ts");
const { ChainClient } = await load("src/chain.ts");
const { createApi } = await load("src/api.ts");
const { loadConfig } = await load("src/config.ts");
const cfg = {
  ...loadConfig(),
  evidenceDir: join(keyHome, "qa-evidence"),
  network: "kit-qa-local",
  rpcUrl: "http://" + rpc,
};
const pool = makePool(cfg.databaseUrl);
const api = createApi({
  cfg,
  pool,
  chain: new ChainClient(cfg.rpcUrl, cfg.realm),
});
try {
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const post = async (path, obj) => {
    const r = await fetch("http://127.0.0.1:" + api.address().port + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obj),
    });
    return [r.status, await r.json()];
  };
  const [code, ch] = await post("/api/session/challenge", {
    addr,
    org: "A",
    deviceId: "qa-staff-a",
  });
  assert.equal(code, 200, JSON.stringify(ch));
  const tx = ch.tx ?? ch.unsignedTx;
  assert.ok(tx, "staff API must return an unsigned Gno transaction");
  const txPath = join(keyHome, "qa-tx.json"),
    sigPath = join(keyHome, "qa-signature.json");
  await writeFile(txPath, JSON.stringify(tx), { mode: 0o600 });
  const result = spawnSync(
    resolve(".tools/bin/gnokey"),
    [
      "sign",
      "-home",
      keyHome,
      "-remote",
      rpc,
      "-chainid",
      cfg.network,
      "-insecure-password-stdin",
      "-account-number",
      "0",
      "-account-sequence",
      "0",
      "-tx-path",
      txPath,
      "-output-document",
      sigPath,
      "institutionA",
    ],
    { input: process.env.KIT_QA_EPHEMERAL_PASS + "\n", encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const s = JSON.parse(await readFile(sigPath, "utf8"));
  const key = typeof s.pub_key === "string" ? s.pub_key : s.pub_key?.value;
  const [login, body] = await post("/api/session", {
    challengeId: ch.challengeId,
    pubkey: key,
    signature: s.signature,
  });
  assert.equal(
    login,
    201,
    JSON.stringify({
      message: body.error,
      signatureKeys: Object.keys(s),
      pubKeyType: typeof s.pub_key,
      pubFields: Object.keys(s.pub_key),
      encodedLength: key?.length,
    }),
  );
  assert.equal(body.addr, addr);
  assert.equal(body.org, "A");
  assert.ok(body.token);
  const base = "http://127.0.0.1:" + api.address().port;
  const staff = (path, opts = {}) =>
    fetch(base + path, {
      ...opts,
      headers: { authorization: "Bearer " + body.token, ...opts.headers },
    });
  const kit = await staff("/api/kits/camera");
  assert.equal(kit.status, 200);
  assert.equal((await kit.json()).kit.available, false);
  const draft = await staff("/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "dispatch",
      kitId: "camera",
      opId: "qa-demo-case",
      args: {
        opID: "qa-demo-case",
        kitID: "camera",
        destOrg: "B",
        expectedRev: 1,
        prevLeg: "",
        qtys: "body:1",
      },
    }),
  });
  assert.equal(draft.status, 201);
  const c = await draft.json();
  const picture = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j81sAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = await staff(
    "/api/evidence?case=" + encodeURIComponent(c.caseId),
    { method: "POST", headers: { "content-type": "image/png" }, body: picture },
  );
  assert.equal(upload.status, 201);
  const obj = await upload.json();
  const imageUrl = "/api/evidence/" + obj.objectId;
  const image = await staff(imageUrl);
  assert.equal(image.status, 200);
  assert.match(image.headers.get("cache-control"), /no-store/);
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(picture));
  const csv = await staff("/api/catalogue/export");
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /camera,A,HELD/);
  const restore = await verifyRestore(
    cfg,
    c.caseId,
    obj.objectId,
    picture,
    keyHome,
  );
  const revoke = await staff("/api/session", { method: "DELETE" });
  assert.ok(revoke.ok);
  const after = await staff(imageUrl);
  assert.equal(after.status, 401);
  console.log(
    JSON.stringify({
      restore,
      challenge: code,
      login,
      org: body.org,
      signer: "gnokey-secp256k1",
      broadcast: false,
      kit: kit.status,
      draft: draft.status,
      attachment: upload.status,
      bytes: picture.length,
      confirmedByteMatch: true,
      postLogout: after.status,
      catalogueStatus: "HELD",
    }),
  );
} finally {
  await new Promise((r) => api.close(r));
  await pool.end();
}
