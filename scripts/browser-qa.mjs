// Portable staff-desk browser QA. Self-contained: spins a disposable
// gnodev chain (throwaway keys, no remote writes), a disposable
// PostgreSQL database and the real API server, then drives headless
// Chrome through the checks that genuinely need a browser:
//
//   T-016  offline cold reload — IndexedDB draft + shell service worker
//   T-017  stale manifest revision — diff shown, signing blocked until
//          deliberate re-review
//   T-022  keyboard-only receipt at desktop + phone widths; one
//          announcement per scan; focus retained on the scan lane
//   T-024  evidence upload retry — aborted upload leaves the receipt
//          intact; the retry succeeds
//   plus   the real B sign-in, unsigned-tx export, external gnokey
//          sign/broadcast and receipt-confirmed path.
//
// Run from the repo root: node scripts/browser-qa.mjs
// Requires: .tools/bin/{gnodev,gnokey}, docker postgres kittransit-pg
// (or KIT_DB_URL) and Chrome installed (playwright-core, channel chrome).
// Artifacts land in .local/browser-qa/; nothing is written remotely.

import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const TOOLS = join(ROOT, ".tools", "bin");
const REALM_DIR = join(ROOT, "realm", "gno.land", "r", "kittransit", "custody");
const REALM = "gno.land/r/kittransit/custody";
const CHAIN = "kit-browser-qa";
const OUT = join(ROOT, ".local", "browser-qa");
const GNOROOT = join(ROOT, ".tools", "src", "gno");
const env = { ...process.env, GNOROOT };
const PASS = randomBytes(18).toString("base64url");
const repo = (p) => import(pathToFileURL(resolve(ROOT, p)).href);

function sh(bin, args, stdin = "", check = true) {
  const p = spawnSync(bin, args, { input: stdin, encoding: "utf8", env, timeout: 60_000 });
  if (check && p.status !== 0) {
    throw new Error(`${bin} ${args[0]} failed:\n${(p.stderr + p.stdout).slice(-1200)}`);
  }
  return (p.stdout || "") + (p.stderr || "");
}

const gnokey = (args, stdin = "", check = true) =>
  sh(join(TOOLS, "gnokey"), args, stdin, check);

function maketx(home, who, fn, args) {
  const cmd = ["maketx", "call", "-home", home, "-remote", rpc,
    "-chainid", CHAIN, "-insecure-password-stdin",
    "-gas-fee", "1000000ugnot", "-gas-wanted", "50000000",
    "-pkgpath", REALM, "-func", fn];
  for (const a of args) cmd.push("-args", String(a));
  const out = gnokey([...cmd, who], PASS + "\n");
  const m = out.match(/(?:tx hash|txhash|hash)\s*[:=]\s*([A-Za-z0-9+/]{43}=)/i);
  return m?.[1] ?? null;
}

// ---------- minimal tm2 rpc/qeval (avoids chain.ts; plain-node portable) ----
let rpc = "";
async function rpcGet(path) {
  const res = await fetch(`http://${rpc}/${path}`);
  const j = await res.json();
  if (j.error) throw new Error(`${path}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function qeval(expr) {
  const data = Buffer.from(`${REALM}.${expr}`, "utf8").toString("base64");
  const r = await rpcGet(`abci_query?path="vm/qeval"&data="${data}"`);
  const raw = Buffer.from(r?.response?.ResponseBase?.Data ?? r?.response?.data ?? "", "base64").toString();
  const m = raw.match(/^\("((?:[^"\\]|\\.)*)"/s);
  return m ? JSON.parse(`"${m[1]}"`) : raw;
}
const chain = {
  realmPath: () => REALM,
  async status() {
    const r = await rpcGet("status");
    return {
      network: r?.node_info?.network ?? "",
      height: Number(r?.sync_info?.latest_block_height ?? 0),
      epoch: `${r?.node_info?.network}@${r?.sync_info?.earliest_block_height ?? 0}:${r?.node_info?.id ?? "0"}`,
    };
  },
  async events(afterSeq = 0, limit = 200) {
    return JSON.parse(await qeval(`GetEvents(${afterSeq},${limit})`));
  },
  async query(fn) {
    try { return JSON.parse(await qeval(fn)); } catch { return { raw: "" }; }
  },
};

function accountSeq(addr) {
  const out = gnokey(["query", "-remote", rpc, `auth/accounts/${addr}`]);
  const n = out.match(/"account_number"\s*:\s*"?(\d+)/i)?.[1];
  const s = out.match(/"sequence"\s*:\s*"?(\d+)/i)?.[1];
  assert.ok(n && s, `cannot read account: ${out.slice(-400)}`);
  return { n: Number(n), s: Number(s) };
}

// ---------- chain fixture ---------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "kt-bqa-"));
const homes = {};
const addrs = {};
for (const who of ["registrar", "institutionA", "institutionB"]) {
  const h = join(tmp, who);
  mkdirSync(h, { mode: 0o700 });
  gnokey(["add", "-home", h, "-insecure-password-stdin", "-nobackup", who],
    `${PASS}\n${PASS}\n`);
  const list = gnokey(["list", "-home", h]);
  addrs[who] = list.match(/\bg1[a-z0-9]{38}\b/)[0];
  homes[who] = h;
}

const realmCopy = join(tmp, "custody");
cpSync(REALM_DIR, realmCopy, { recursive: true });
for (const f of readdirSync(realmCopy)) {
  if (f.endsWith("test.gno")) rmSync(join(realmCopy, f));
}

// Free port for the node RPC.
const { createServer: mkProbe } = await import("node:net");
const port = await new Promise((res) => {
  const s = mkProbe().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
rpc = `127.0.0.1:${port}`;
const gnodevCmd = [
  "local", "-home", join(tmp, "node"), "-no-watch", "-no-web",
  "-unsafe-api=false", "-node-rpc-listener", rpc, "-chain-id", CHAIN,
  "-deploy-key", addrs.registrar,
  ...Object.values(addrs).map((a) => `-add-account=${a}=100000000000ugnot`),
  realmCopy,
];
const node = spawn(join(TOOLS, "gnodev"), gnodevCmd, { env, stdio: "ignore" });
process.on("exit", () => { try { node.kill(); } catch {} });

async function waitChain() {
  for (let i = 0; i < 100; i++) {
    if (node.exitCode !== null) throw new Error("gnodev exited early");
    try {
      const r = await rpcGet("status");
      if (r?.node_info?.network === CHAIN && await qeval("Registrar()") === addrs.registrar) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("gnodev startup timed out");
}

const PARTS = ["body", "lens", "strap", "cable", "card", "cap"];

// ---------- disposable PostgreSQL -------------------------------------------
const { makePool, migrate } = await repo("src/db.ts");
const { indexOnce } = await repo("src/indexer.ts");
const { createApi } = await repo("src/api.ts");
const pg = (await import("pg")).default;
const adminUrl = (process.env.KIT_DB_URL ??
  "postgres://kittransit:kittransit-local-dev@127.0.0.1:5433/kittransit")
  .replace(/\/[^/?]+$/, "/postgres");
const DB = `kit_bqa_${process.pid}_${randomBytes(3).toString("hex")}`;
const dbUrl = adminUrl.replace(/\/postgres$/, `/${DB}`);
let pool;

async function provisionDb() {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${DB}`);
  } finally { await admin.end(); }
  pool = makePool(dbUrl);
  await migrate(pool);
}
async function dropDb() {
  try { await pool?.end(); } catch {}
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  } finally { await admin.end(); }
}

async function drainIndexer() {
  for (;;) {
    const n = await indexOnce(pool, chain, 200);
    if (n === 0) break;
  }
}

// ---------- tiny PNG for evidence upload ------------------------------------
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

// ---------- main ------------------------------------------------------------
const results = { chain: CHAIN, checks: {}, screenshots: [] };
let phoneView = null; // Playwright handles for the 390px context (not serialized)
let browser, api;
try {
  await waitChain();

  // Two-org fixture: enroll A + B, six-part manifest, dispatch to B.
  maketx(homes.registrar, "registrar", "EnrollOrg", ["enroll-a", "A", addrs.institutionA]);
  maketx(homes.registrar, "registrar", "EnrollOrg", ["enroll-b", "B", addrs.institutionB]);
  const manifest = PARTS.map((p) => `${p}:1:1:unit:${p}`).join(";");
  maketx(homes.institutionA, "institutionA", "DefineManifest", ["define", "camera", manifest, "inspect-each-return"]);
  maketx(homes.institutionA, "institutionA", "Dispatch", ["ship", "camera", "B", 1, "", PARTS.map((p) => `${p}:1`).join(";")]);
  const leg = (await chain.query(`GetKit("camera")`)).activeLeg;
  assert.ok(leg, "no active leg after dispatch");
  results.leg = leg;
  // A second kit stays fully unreceived — the queue then shows a real
  // oldest-outstanding row alongside the partial camera receipt.
  maketx(homes.institutionA, "institutionA", "DefineManifest",
    ["define-scope", "scope", "tube:1:1:unit:tube", "inspect-each-return"]);
  maketx(homes.institutionA, "institutionA", "Dispatch",
    ["ship-scope", "scope", "B", 1, "", "tube:1"]);

  await provisionDb();
  await drainIndexer();
  const cfg = {
    databaseUrl: dbUrl, rpcUrl: `http://${rpc}`, realm: REALM,
    evidenceDir: join(tmp, "evidence"), webDir: join(ROOT, "web"),
    apiPort: 0, sessionTtlSec: 3600, pollMs: 1000, pageLimit: 200,
    network: CHAIN, gnokeyBin: "",
  };
  api = createApi({ cfg, pool, chain });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.address().port}`;

  browser = await chromium.launch({ channel: "chrome", headless: true });
  let staffToken = null;

  async function loginStaff(page, { org, who, device }) {
    await page.locator('[data-nav="session"]').click();
    await page.locator("#login-org").fill(org);
    await page.locator("#login-addr").fill(addrs[who]);
    await page.locator("#login-device").fill(device);
    await page.getByRole("button", { name: "Get sign-in challenge" }).click();
    await page.waitForFunction(() => document.querySelector("#ch-tx")?.value?.trim());
    const txPath = join(tmp, `ch-${org}-${device}.json`), sigPath = join(tmp, `ch-${org}-${device}-sig.json`);
    writeFileSync(txPath, await page.locator("#ch-tx").inputValue(), { mode: 0o600 });
    // The sign-in challenge is a proof doc only — never broadcast — so the
    // API contract fixes account_number/sequence at 0/0 for it. Custody txs
    // below DO use live account numbers before broadcast.
    gnokey(["sign", "-home", homes[who], "-remote", rpc, "-chainid", CHAIN,
      "-account-number", "0", "-account-sequence", "0",
      "-insecure-password-stdin", "-tx-path", txPath,
      "-output-document", sigPath, who], PASS + "\n");
    const sig = JSON.parse(readFileSync(sigPath, "utf8"));
    await page.locator("#ch-pubkey").fill(sig.pub_key.value);
    await page.locator("#ch-sig").fill(sig.signature);
    const login = page.waitForResponse(
      (r) => r.url().endsWith("/api/session") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Complete sign-in" }).click();
    const resp = await login;
    assert.equal(resp.status(), 201);
    return (await resp.json()).token;
  }
  async function loginB(page, device) {
    staffToken = await loginStaff(page, { org: "B", who: "institutionB", device });
    // Wait for the kit picker to be enabled (kits loaded).
    await page.locator('[data-nav="receive"]').click();
    await page.waitForFunction(() =>
      !document.querySelector("#kit-sel")?.disabled);
  }

  // Drive the whole sign view: sign with the real gnokey, broadcast, paste
  // the hash, and require an exact confirmed receipt.
  async function signBroadcastConfirm(page, who) {
    await page.locator("#do-sign").click();
    await page.waitForFunction(() => document.querySelector("#unsigned-tx")?.value?.trim());
    const tx = JSON.parse(await page.locator("#unsigned-tx").inputValue());
    const p = join(tmp, `${tx.msg[0].func}-${who}.json`);
    writeFileSync(p, JSON.stringify(tx), { mode: 0o600 });
    const { n, s } = accountSeq(addrs[who]);
    gnokey(["sign", "-home", homes[who], "-remote", rpc, "-chainid", CHAIN,
      "-account-number", String(n), "-account-sequence", String(s),
      "-insecure-password-stdin", "-tx-path", p, who], PASS + "\n");
    const bcast = gnokey(["broadcast", "-home", homes[who], "-remote", rpc, p]);
    const txhash = bcast.match(/TX HASH:\s*(\S+)/)?.[1];
    assert.ok(txhash, `no tx hash: ${bcast.slice(-300)}`);
    // A failed deliver still yields a hash — verify the tx actually applied
    // before asking the API to confirm, so failures name the realm panic.
    const txRes = await rpcGet(
      `tx?hash=0x${Buffer.from(txhash, "base64").toString("hex").toUpperCase()}`);
    const code = Number(txRes?.tx_result?.code ?? 0);
    assert.equal(code, 0,
      `broadcast applied? log=${JSON.stringify(txRes?.tx_result?.log ?? txRes?.tx_result?.info)}`);
    await page.locator("#txhash-in").fill(txhash);
    const conf = page.waitForResponse((r) => r.url().endsWith("/confirm"));
    await page.locator("#mark-broadcast").click();
    const body = await (await conf).json();
    assert.equal(body.state, "confirmed", JSON.stringify(body));
    return { tx, txhash };
  }

  // -- T-022 keyboard-only scan at desktop and phone widths ------------------
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 850 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(12_000);
    await page.goto(base);
    await loginB(page, `desk-${width}`);
    await page.locator("#kit-sel").selectOption("camera");
    await page.waitForFunction(
      (l) => document.querySelector("#leg-info")?.textContent.includes(l), leg);
    const legInfo = await page.locator("#leg-info").innerText();
    assert.match(legInfo, new RegExp(`${addrs.institutionA.slice(0, 8)}|A →`), "leg sender shown");
    assert.match(legInfo, /lens×1/, "dispatched qty shown");

    // Keyboard only: type + Enter per part; single announcement per scan;
    // focus must remain on the scan lane after every entry.
    await page.evaluate(() => {
      window.scanAnnouncements = [];
      const region = document.querySelector("#announce");
      new MutationObserver(() => window.scanAnnouncements.push(region.textContent))
        .observe(region, {childList:true, subtree:true, characterData:true});
    });
    if (width === 390) {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await ctx.setOffline(true);
    }
    async function tabTo(selector) {
      const visited = [];
      for (let count = 0; count < 45; count++) {
        visited.push(await page.evaluate(()=> document.activeElement.tagName+"#"+document.activeElement.id));
        if (await page.locator(selector).evaluate(el => el === document.activeElement)) return;
        await page.keyboard.press("Tab");
      }
      throw new Error("Keyboard cannot reach " + selector + " via "+visited.join(", "));
    }
    await tabTo("#scan");
    const received = PARTS.filter((p) => p !== "lens");
    for (const part of received) {
      await page.keyboard.type(part);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (p) => document.querySelector("#announce")?.textContent.includes(p), part);
      const announce = await page.locator("#announce").innerText();
      assert.equal(announce, `${part} added`, "one announcement per scan");
      assert.equal(
        await page.evaluate(() => document.activeElement.id), "scan",
        "focus retained on scan lane");
    }
    assert.equal(await page.locator("#lines li").count(), 5, "5 counted lines");

    // Exception flow via keyboard; focus returns to the scan lane.
    await tabTo("#exception-panel summary");
    await page.keyboard.press("Enter");
    await tabTo("#exc-line");
    await page.keyboard.type("lens");
    await tabTo("#exc-reason");
    await page.keyboard.type("lens missing");
    await tabTo("#exc-add");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "scan" &&
      document.querySelector("#lines")?.children.length === 6);
    const spoken = await page.evaluate(() => window.scanAnnouncements.filter(text => text.endsWith(" added")));
    assert.deepEqual(spoken,received.map(label => label + " added"));
    assert.equal(await page.locator("#lines li").count(), 6,
      "five parts + one exception row");
    results.checks[`T-022 keyboard ${width}px`] = {
      scans: received.length, announcedOnce: true, focusRetained: true, exceptionViaKeyboard: true,
    };
    if (width === 390) phoneView = { page, ctx };
    else await ctx.close();
  }

  const { page, ctx } = phoneView;

  // -- T-016 offline cold reload ---------------------------------------------
  await page.evaluate(() => navigator.serviceWorker.ready);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll("#lines li").length >= 5);
  const offlineLines = await page.locator("#lines li").count();
  assert.equal(offlineLines, 6, "IndexedDB draft reappears after offline reload");
  const badge = await page.locator("#cache-badge").innerText().catch(() => "");
  // An actual owner amendment occurs while the receiving desk is disconnected.
  maketx(homes.institutionA, "institutionA", "AmendManifest",
    ["amend-1", "camera", PARTS.map((p) => `${p}:1:1:unit:${p}`).join(";"), "inspect-each-return"]);
  await drainIndexer();
  await ctx.setOffline(false);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#lines li").length >= 5);
  results.checks["T-016 offline cold reload"] = {
    shellServedOffline: true, scansEnteredWhileOffline: 5, draftLines: offlineLines, badge,
  };

  // -- T-017 stale manifest revision ------------------------------------------
  // After a cold reload the desk opens on the queue (UI-SPEC default); the
  // restored draft resumes when the staff member returns to Receive.
  await page.locator('[data-nav="receive"]').click();
  await page.locator("#signoff").click();
  await page.waitForFunction(
    () => document.querySelector("#sign-status")?.textContent.includes("Manifest changed"));
  assert.equal(await page.locator("#do-sign").isDisabled(), true,
    "signing blocked on stale revision");
  // The persisted before/after diff is shown and requires deliberate
  // re-review confirmation before signing is allowed again.
  assert.equal(await page.locator("#revdiff").isVisible(), true,
    "revision diff panel shown");
  const revText = await page.locator("#revdiff-lines").innerText();
  assert.match(revText, /rev 1 → rev 2|rev \d+ → rev \d+/, "before/after revisions shown");
  // The change must still be reviewed if a staff member leaves and reopens the draft.
  await page.locator("#back-draft").click();
  await page.locator("#signoff").click();
  await page.locator("#revdiff").waitFor();
  assert.equal(await page.locator("#do-sign").isDisabled(), true);
  await page.locator("#re-review").click();
  await page.waitForFunction(() => !document.querySelector("#do-sign")?.disabled);
  results.checks["T-017 stale revision"] = {
    diffShown: true, blockedUntilReReview: true, deliberateConfirm: true,
    diff: revText.split("\n")[0],
  };

  // -- real sign -> external broadcast -> confirm -----------------------------
  const recv = await signBroadcastConfirm(page, "institutionB");
  const msg = recv.tx.msg[0];
  assert.equal(msg.func, "ReceiveDelta");
  assert.equal(msg.caller, addrs.institutionB);
  assert.equal(msg.args[1], leg);
  assert.equal(msg.args[4], "lens:1");
  assert.equal(msg.args[2].split(";").length, 5);
  results.checks["receive journey"] = {
    op: msg.args[0], txhash: recv.txhash, state: "confirmed",
  };
  const onChain = await chain.query(`GetOp("B",${JSON.stringify(msg.args[0])})`);
  assert.equal(onChain.status, "confirmed");
  assert.equal(onChain.signer, addrs.institutionB);

  // -- institution queue: B sees the open incoming legs + open exception ------
  // Let the app's post-confirm view settle (it returns to the receive view
  // ~1.4 s after confirmation), drain the receipt into the projection, then
  // wait for the fresh /api/queue response and rendered rows — the tab
  // counts from the earlier load persist while the body is re-fetched.
  await page.waitForTimeout(1700);
  await drainIndexer();
  const qres = page.waitForResponse((r) => r.url().endsWith("/api/queue"));
  await page.locator('[data-nav="queue"]').click();
  await qres;
  await page.waitForFunction(() =>
    document.querySelectorAll("#queue-body li").length >= 2);
  const qIn = await page.locator("#queue-body").innerText();
  assert.match(qIn, /camera · A · 5\/6 received/, "partial receipt projected");
  assert.match(qIn, /scope · A · 0\/1 received/, "unreceived leg projected");
  assert.match(qIn, /outstanding tube×1 · oldest: tube/, "oldest outstanding component");
  assert.match(qIn, /pending movement/, "pending movement label");
  assert.match(qIn, /h\d+/, "last confirmed height shown");
  await page.locator("#qtab-exceptions").click();
  await page.waitForFunction(() =>
    document.querySelector("#queue-body")?.textContent.includes("lens"));
  const qExc = await page.locator("#queue-body").innerText();
  assert.match(qExc, /lens/, "exception names the missing line");
  assert.match(qExc, /missing/, "missing label");
  results.checks["queue incoming+exceptions (B)"] = {
    incoming: 2, exceptions: 1, oldestOutstanding: "tube",
  };

  // -- T-024 evidence upload retry after confirmation -------------------------
  await page.waitForTimeout(1600); // draft reset + view switch
  await page.locator('[data-nav="case"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#ev-case option").length > 0);
  await page.locator("#ev-case").selectOption({ index: 0 });
  await page.locator("#ev-file").setInputFiles({
    name: "lens-photo.png", mimeType: "image/png", buffer: PNG,
  });
  await page.route("**/api/evidence*", (r) => r.abort());
  await page.locator("#ev-upload").click();
  await page.waitForFunction(
    () => document.querySelector("#ev-status")?.textContent.includes("Upload failed"));
  assert.equal(await page.locator("#ev-retry").isVisible(), true,
    "retry control appears on failure");
  // The receipt stays visible and unaffected by the failed upload.
  const caseList = await page.locator("#case-list").innerText();
  assert.match(caseList, /confirmed/, "confirmed case unaffected by failed upload");
  await page.unroute("**/api/evidence*");
  await page.locator("#ev-retry").click();
  await page.waitForFunction(
    () => document.querySelector("#ev-status")?.textContent.includes("Attachment stored"));
  results.checks["T-024 upload retry"] = {
    failureSurfaced: true, receiptIntact: true, retrySucceeded: true,
  };

  // -- catalogue export sanity ------------------------------------------------
  // Drain the outbox (HELD transition from manifest-define/dispatch), then
  // export the partner interchange CSV for this branch.
  await drainIndexer();
  const drain = await fetch(`${base}/api/catalogue/drain`, {
    method: "POST", headers: { authorization: `Bearer ${staffToken}` },
  });
  assert.equal(drain.status, 200);
  const csv = await (await fetch(`${base}/api/catalogue/partner.csv`, {
    headers: { authorization: `Bearer ${staffToken}` },
  })).text();
  assert.match(csv, /camera/, "partner CSV carries the kit");
  assert.match(csv, /HELD/, "incomplete kit exports HELD");
  results.checks["catalogue export"] = {
    rows: csv.trim().split("\n").length - 1,
    drain: await drain.json().catch(() => ({})),
  };

  // -- return + recovery path via direct signed calls --------------------------
  // B's UI receipt is done; drive the standard recovery leg so the kit
  // reaches "needs owner assessment" for the desk-level checks below.
  const five = PARTS.filter((p) => p !== "lens").map((p) => `${p}:1`).join(";");
  const exc = (await chain.query(`GetExceptions("camera")`)).exceptions[0];
  maketx(homes.institutionA, "institutionA", "ResolveException",
    ["close-missing", exc.id, "close-unreceived", "await partner search"]);
  maketx(homes.institutionB, "institutionB", "CloseLeg", ["close-out", leg]);
  maketx(homes.institutionB, "institutionB", "StartReturn", ["send-back", "camera", five]);
  const backLeg = (await chain.query(`GetKit("camera")`)).activeLeg;
  maketx(homes.institutionA, "institutionA", "ReceiveDelta",
    ["received-return", backLeg, five, "", "", "received"]);
  maketx(homes.institutionA, "institutionA", "CloseLeg", ["close-back", backLeg]);
  maketx(homes.institutionB, "institutionB", "ReportFound",
    ["found", "camera", "lens", 1, leg]);
  const claim = (await chain.query(`GetClaims("camera")`)).claims[0].id;
  maketx(homes.institutionA, "institutionA", "ConfirmRecovery", ["confirm", claim]);
  maketx(homes.institutionB, "institutionB", "StartReturn",
    ["return-recovered", "camera", "lens:1"]);
  const lateLeg = (await chain.query(`GetKit("camera")`)).activeLeg;
  maketx(homes.institutionA, "institutionA", "ReceiveDelta",
    ["receive-recovered", lateLeg, "lens:1", "", "", "lens received"]);
  maketx(homes.institutionA, "institutionA", "CloseLeg", ["close-recovered", lateLeg]);
  await drainIndexer();
  const heldKit = await chain.query(`GetKit("camera")`);
  assert.equal(heldKit.needsAssessment, true, "kit needs owner assessment");
  results.checks["return+recovery (CLI legs)"] = {
    lensRecoveredToB: true, allHeldByA:
      heldKit.lines.every((l) => (l.held.A ?? 0) === l.required),
  };

  // -- non-owner sees no assessment control -----------------------------------
  // The phone page still holds B's session.
  await page.locator('[data-nav="case"]').click();
  await page.locator("#case-kit").fill("camera");
  await page.locator("#case-load").click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".case-meta")]
      .some((el) => el.textContent.includes("owner assessment")));
  assert.equal(await page.locator("#assess-panel").isVisible(), false,
    "non-owner gets no assessment control");
  assert.equal(await page.locator("#release-kit").isVisible(), false,
    "non-owner gets no release control");
  results.checks["non-owner controls hidden"] = true;

  // -- owner assessment + release through the desk (separate A signer) --------
  const aCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const aPage = await aCtx.newPage();
  aPage.setDefaultTimeout(15_000);
  await aPage.goto(base);
  await loginStaff(aPage, { org: "A", who: "institutionA", device: "owner-desk" });
  // Queue: owner sees the needs-inspection row.
  const aQres = aPage.waitForResponse((r) => r.url().endsWith("/api/queue"));
  await aPage.locator('[data-nav="queue"]').click();
  await aQres;
  await aPage.waitForFunction(() =>
    document.querySelector("#queue-body")?.textContent.includes("needs inspection"));
  const aQ = await aPage.locator("#queue-body").innerText();
  assert.match(aQ, /camera/, "inspection row names the kit");
  results.checks["queue needs-inspection (A)"] = true;

  // Case view: assessment panel lists the six required lines.
  await aPage.locator('[data-nav="case"]').click();
  await aPage.locator("#case-kit").fill("camera");
  await aPage.locator("#case-load").click();
  await aPage.waitForFunction(() =>
    document.querySelectorAll("#assess-lines select[data-line]").length === 6);
  assert.equal(await aPage.locator("#assess-panel").isVisible(), true);
  // All six lines assessed serviceable (defaults are already "ok").
  await aPage.locator("#assess-review").click();
  await aPage.waitForFunction(() =>
    document.querySelector("#attest")?.textContent.includes("owning institution"));
  const assessed = await signBroadcastConfirm(aPage, "institutionA");
  assert.equal(assessed.tx.msg[0].func, "AssessReturn");
  assert.equal(assessed.tx.msg[0].caller, addrs.institutionA);
  assert.equal(assessed.tx.msg[0].args[2].split(";").length, 6,
    "six per-line assessments in payload");
  results.checks["owner assessment (A signer)"] = {
    op: assessed.tx.msg[0].args[0], txhash: assessed.txhash,
  };

  // Release: after the assess receipt lands, the release control appears.
  await aPage.waitForFunction(() =>
    !document.querySelector("#release-kit")?.hidden, { timeout: 15_000 });
  await aPage.locator("#release-kit").click();
  await aPage.waitForFunction(() =>
    document.querySelector("#attest")?.textContent.includes("circulation"));
  const rel = await signBroadcastConfirm(aPage, "institutionA");
  assert.equal(rel.tx.msg[0].func, "ReleaseKit");
  assert.equal(rel.tx.msg[0].caller, addrs.institutionA);
  results.checks["owner release (A signer)"] = {
    op: rel.tx.msg[0].args[0], txhash: rel.txhash,
  };

  // Final state: realm says available; the audit tab records the release.
  await drainIndexer();
  const fin = await chain.query(`GetKit("camera")`);
  assert.equal(fin.available, true, "kit available after release");
  assert.equal(fin.hold, false);
  // Same post-confirm settle as above before navigating.
  await aPage.waitForTimeout(1700);
  const aQres2 = aPage.waitForResponse((r) => r.url().endsWith("/api/queue"));
  await aPage.locator('[data-nav="queue"]').click();
  await aQres2;
  await aPage.waitForFunction(() =>
    document.querySelector("#qtab-incoming")?.textContent.includes("(0)"));
  await aPage.locator("#qtab-audit").click();
  await aPage.waitForFunction(() =>
    document.querySelector("#queue-body")?.textContent.includes("release"));
  const audit = await aPage.locator("#queue-body").innerText();
  assert.match(audit, /release/, "audit tab records the release event");
  results.checks["queue audit (A)"] = { releaseRecorded: true, available: true };
  // A visitor can verify the sequence independently through the public reader.
  const visitor = await browser.newContext({viewport: {width:360, height:780}, reducedMotion:"reduce"});
  const publicPage = await visitor.newPage();
  await publicPage.goto(base + "/public.html");
  await publicPage.locator("#pub-load").click();
  await publicPage.waitForFunction(() => [...document.querySelectorAll("li[data-sequence]")]
    .some(row => row.textContent.includes("release")));
  const publicRows = await publicPage.locator("li[data-sequence]").allTextContents();
  const feed = (await chain.events(0, 200)).events.filter(ev => ev.kit === "camera");
  assert.equal(publicRows.length, feed.length);
  feed.forEach((ev, i) => {
    assert.ok(publicRows[i].includes(ev.kind) && publicRows[i].endsWith("height " + ev.height));
  });
  assert.match(await publicPage.locator("#pub-body").innerText(), /AVAILABLE/);
  results.checks["independent visitor"] = {events: feed.length, releaseHeight: feed.at(-1).height,
    finalState:"AVAILABLE", loginRequired:false};
  await visitor.close();
  const shot2 = join(OUT, "owner-release-1280.png");
  await aPage.screenshot({ path: shot2, fullPage: true });
  results.screenshots.push(shot2);
  await aPage.locator('[data-nav="session"]').click();
  await aPage.locator("#logout").click();
  await aPage.waitForFunction(() => !localStorage.getItem("kt.token") &&
    document.querySelector("#who")?.textContent === "not signed in");
  assert.equal(await aPage.locator("#case-list li").count(), 0);
  assert.equal(await aPage.locator("#assess-lines select").count(), 0);
  results.checks["owner signed out"] = { privateDeskCleared: true };
  await aCtx.close();

  mkdirSync(OUT, { recursive: true });
  const shot = join(OUT, "desk-390.png");
  await page.screenshot({ path: shot, fullPage: true });
  results.screenshots.push(shot);
} finally {
  try { await browser?.close(); } catch {}
  try { api?.close(); } catch {}
  try { node.kill(); } catch {}
  try { await dropDb(); } finally { rmSync(tmp, {recursive:true, force:true}); }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "browser-qa-result.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
