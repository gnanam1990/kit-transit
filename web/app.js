// Kit Transit staff desk. Vanilla JS, no build step.
// Rules from UI-SPEC:
//   - scan input keeps focus; Enter adds a scan, never signs
//   - unsigned drafts can be edited/undone; signed content immutable
//   - sign-off shows the full attestation; refusal leaves a stable route
//   - reconnect re-verifies and diffs the draft before signing
//   - cached views carry a badge + age; colours always have text labels
//   - the desk never holds keys: it exports an unsigned tx for gnokey,
//     then waits for the realm's own receipt before confirming anything
//
// Scanner race note: the scan input is cleared synchronously in the submit
// handler BEFORE any async IndexedDB work, so rapid successive scans cannot
// be lost to a mid-flight save.

"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem("kt.token") || null,
  org: localStorage.getItem("kt.org") || null,
  addr: localStorage.getItem("kt.addr") || null,
  device: localStorage.getItem("kt.device") || null,
  network: null,
  draft: null,
  kits: [],
  view: "receive",
};

// ---------- api -------------------------------------------------------------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (opts.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
    if (typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) {
    say("Session expired — please sign in again");
    clearSession();
    show("session");
    throw new Error("unauthorized");
  }
  return res;
}

function say(msg) { $("announce").textContent = msg; }

function renderWho() {
  $("who").textContent = state.addr
    ? `${state.org} · ${state.addr.slice(0, 10)}… · ${state.device || "desk"}`
    : "not signed in";
}

function clearSession() {
  state.token = null;
  for (const k of ["kt.token", "kt.org", "kt.addr", "kt.device"]) {
    localStorage.removeItem(k);
  }
  $("logout").hidden = true;
  renderWho();
}

// ---------- views -----------------------------------------------------------
const VIEWS = ["receive", "sign", "case", "session"];
function show(name) {
  state.view = name;
  for (const v of VIEWS) $("view-" + v).hidden = v !== name;
  document.querySelectorAll("[data-nav]").forEach((b) => {
    const match = b.dataset.nav === name || (name === "sign" && b.dataset.nav === "receive");
    if (match) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (name === "receive") $("scan").focus();
  if (name === "case") loadCaseList();
}

// ---------- cached data badge ------------------------------------------------
let lastFetchAt = 0;
function markCache(ok) {
  if (ok) lastFetchAt = Date.now();
  const badge = $("cache-badge");
  if (!ok) {
    badge.hidden = false;
    badge.textContent = lastFetchAt
      ? `Cached view — data is ${Math.max(1, Math.round((Date.now() - lastFetchAt) / 1000))}s old, not live`
      : "Offline — showing last known state";
  } else {
    badge.hidden = true;
  }
}

// ---------- drafts (scoped to org/account/device) ------------------------------
// A draft belongs to one sign-in scope only: org + address + device. Drafts
// from another scope are never loaded into this desk's working state.
function scopeKey() {
  return `${state.org || "anon"}:${state.addr || "none"}:${state.device || "desk"}`;
}

function newOpId() {
  // One stable op per draft — generated once, persisted, reused on retry.
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function blankDraft() {
  return {
    id: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    scope: scopeKey(),
    kit: "", leg: "", origin: "", manifestRev: undefined,
    opId: newOpId(), caseId: null,
    scans: [], lines: {}, exceptions: [], signed: false,
  };
}

function normalizedLines(draft) {
  const out = {};
  for (const s of draft.scans) {
    const key = s.serial ? `${s.code}#${s.serial}` : s.code;
    out[key] = out[key] || { code: s.code, serial: s.serial || null, count: 0 };
    out[key].count += 1;
  }
  return out;
}

async function saveDraft() {
  if (!state.draft) return;
  state.draft.scope = scopeKey();
  state.draft.lines = normalizedLines(state.draft);
  await Drafts.save(state.draft);
  renderDraft();
}

function tag(className, text) {
  const s = document.createElement("span");
  s.className = `tag ${className}`;
  s.textContent = text;
  return s;
}

function renderDraft() {
  const d = state.draft;
  if (!d) return;
  $("draft-state").textContent =
    `Draft ${d.signed ? "(signed — immutable)" : "unsigned"} · ` +
    `${d.kit ? `kit ${d.kit} · leg ${d.leg || "?"} · ` : "no kit selected · "}` +
    `${d.scans.length} raw scans · ${Object.keys(d.lines).length} counted lines`;
  $("undo").disabled = d.signed || d.scans.length === 0;
  $("discard").disabled = d.signed;
  $("signoff").disabled = d.signed || !d.leg || Object.keys(d.lines).length === 0;
  const ul = $("lines");
  ul.replaceChildren();
  for (const ln of Object.values(d.lines)) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = ln.serial ? `${ln.code} · serial ${ln.serial}` : ln.code;
    li.appendChild(label);
    li.appendChild(ln.serial ? tag("ok", "serialized ×1") : tag("warn", `count ${ln.count}`));
    ul.appendChild(li);
  }
  for (const e of d.exceptions) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${e.line || "kit"} — ${e.kind}: ${e.reason}`;
    li.appendChild(label);
    li.appendChild(tag("bad", "exception"));
    ul.appendChild(li);
  }
}

// ---------- incoming kits / legs ---------------------------------------------
async function loadKits() {
  const sel = $("kit-sel");
  if (!state.token) {
    sel.disabled = true;
    sel.replaceChildren(new Option("— sign in to load incoming kits —", ""));
    return;
  }
  try {
    const res = await api("/api/kits");
    markCache(res.ok);
    if (!res.ok) return;
    const { kits } = await res.json();
    state.kits = kits || [];
    sel.replaceChildren(new Option("— choose the kit you are receiving —", ""));
    for (const k of state.kits) {
      sel.appendChild(new Option(`${k.kit_id} (rev ${k.manifest_rev})`, k.kit_id));
    }
    sel.disabled = false;
    if (state.draft?.kit) sel.value = state.draft.kit;
    updateLegInfo();
  } catch {
    markCache(false);
  }
}

async function updateLegInfo() {
  const d = state.draft;
  const kitId = $("kit-sel").value;
  if (!kitId) {
    $("leg-info").textContent = "Select the kit whose delivery you are receiving.";
    return;
  }
  try {
    const res = await api(`/api/kits/${encodeURIComponent(kitId)}`);
    markCache(res.ok);
    if (!res.ok) { $("leg-info").textContent = "Could not load kit detail."; return; }
    const { kit, legs } = await res.json();
    // proj_legs SQL columns: leg_id, sender, dest, status, qty (dispatched
    // units as JSONB). The leg we can receive is the OPEN leg addressed to us.
    const open = (legs || []).filter((l) => l.status === "open" && l.dest === state.org);
    if (d && d.kit !== kitId) {
      d.kit = kitId;
      d.manifestRev = kit.manifest_rev;
      d.caseId = null; // a different kit means a different case
      d.opId = d.opId || newOpId();
    }
    if (open.length === 0) {
      if (d) { d.leg = ""; d.origin = ""; }
      $("leg-info").textContent =
        "No open leg addressed to your institution on this kit — nothing to receive.";
    } else {
      const leg = open[0];
      if (d) { d.leg = leg.leg_id; d.origin = leg.sender; }
      const qty = Object.entries(leg.qty || {})
        .map(([k, v]) => `${k}×${v}`).join(", ");
      $("leg-info").textContent =
        `Active leg ${leg.leg_id}: ${leg.sender} → ${state.org}, dispatched ${qty || "?"}` +
        (open.length > 1 ? ` (${open.length} open legs — receiving oldest)` : "");
    }
    if (d) await saveDraft();
  } catch {
    markCache(false);
    $("leg-info").textContent = "Offline — kit detail unavailable.";
  }
}

// ---------- scanner -----------------------------------------------------------
function parseScan(text) {
  const t = text.trim();
  const m = t.match(/^([^\[\]]+)(?:\[(.+)\])?$/);
  return { code: (m?.[1] || t).trim(), serial: m?.[2]?.trim() || null };
}

async function addScan(text) {
  if (!state.draft || state.draft.signed) return;
  const p = parseScan(text);
  const isDup = state.draft.scans.some(
    (s) => s.code === p.code && s.serial === p.serial);
  state.draft.scans.push(p);
  await saveDraft();
  if (isDup) {
    say(p.serial
      ? `Serial ${p.serial} was already counted once — the count did not change`
      : `${p.code} scanned again — now counted ${state.draft.lines[p.code]?.count ?? 1} times`);
  } else {
    say(`${p.code} added`);
  }
  $("scan").focus();
}

// ---------- payload + case -----------------------------------------------------
function buildPayload() {
  const d = state.draft;
  const accepted = [], missing = [], conds = [];
  for (const ln of Object.values(d.lines)) {
    accepted.push(`${ln.code}:${ln.serial ? 1 : ln.count}`);
  }
  for (const e of d.exceptions) {
    if (e.kind === "missing") missing.push(`${e.line}:1`);
    else conds.push(`${e.line}:${e.kind}`);
  }
  return {
    kind: "receive",
    kitId: d.kit,
    opId: d.opId,
    args: {
      opID: d.opId,
      legID: d.leg,
      accepted: accepted.join(";"),
      conds: conds.join(";"),
      missing: missing.join(";"),
      reason: d.exceptions.map((e) => e.reason).join("; ") || "",
    },
  };
}

// One reviewed op + payload per draft, persisted across reload/retry.
async function ensureCase() {
  const d = state.draft;
  if (d.caseId) return d.caseId;
  const payload = buildPayload();
  const res = await api("/api/cases", {
    method: "POST",
    body: { kind: payload.kind, kitId: payload.kitId, opId: payload.opId, args: payload.args },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `case create failed (${res.status})`);
  d.caseId = b.caseId;
  await saveDraft();
  return d.caseId;
}

// ---------- sign-off -----------------------------------------------------------
let reReviewNeeded = false;

async function openSignOff() {
  const d = state.draft;
  if (!d || !d.leg) return;
  reReviewNeeded = false;
  try {
    const res = await api(`/api/kits/${encodeURIComponent(d.kit)}`);
    markCache(res.ok);
    if (res.ok) {
      const j = await res.json();
      const manifestRev = j.kit?.manifest_rev;
      if (d.manifestRev !== undefined && d.manifestRev !== manifestRev) {
        reReviewNeeded = true;
        d.manifestRev = manifestRev;
        d.caseId = null; // the reviewed payload predates the change
        await saveDraft();
      }
      d.manifestRev = manifestRev;
    }
  } catch {
    markCache(false);
  }

  const pv = $("preview");
  const lines = Object.values(d.lines);
  pv.replaceChildren();
  const rows = [
    ["Origin", d.origin || "(partner institution)"],
    ["Destination", state.org || "(your institution)"],
    ["Kit / leg", `${d.kit} · ${d.leg}`],
    ["Operation id", d.opId],
    ["Manifest version", d.manifestRev !== undefined ? `rev ${d.manifestRev}` : "unverified — offline"],
    ["Accepted lines", lines.map((l) => `${l.code}×${l.serial ? 1 : l.count}`).join("; ") || "none"],
    ["Missing lines", d.exceptions.filter((e) => e.kind === "missing").map((e) => e.line).join("; ") || "none"],
    ["Condition flags", d.exceptions.filter((e) => e.kind !== "missing").map((e) => `${e.line}:${e.kind}`).join("; ") || "none"],
    ["Signing account", state.addr || "not signed in"],
    ["Network", state.network || "local dev chain"],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    pv.append(dt, dd);
  }
  $("attest").textContent =
    "This signature attests that the listed components physically arrived " +
    "at your institution in the stated condition, and records the exceptions " +
    "shown as part of the kit's permanent custody record.";
  $("sign-steps").hidden = true;
  $("do-sign").disabled = reReviewNeeded;
  $("sign-status").textContent = reReviewNeeded
    ? "Manifest changed since drafting — go back and re-review the draft before signing."
    : "";
  if (reReviewNeeded) say("Manifest changed — re-review required");
  show("sign");
}

// Wallet/signature refusal leaves the stable route: the draft and case
// survive, nothing is broadcast, staff can retry or go back.
async function beginSigning() {
  const d = state.draft;
  if (!d || reReviewNeeded) return;
  $("sign-status").textContent = "";
  try {
    const caseId = await ensureCase();
    // Signature-request is the deliberate state change before any signing.
    const tr = await api(`/api/cases/${encodeURIComponent(caseId)}/transition`, {
      method: "POST", body: { state: "signature-request" },
    });
    if (!tr.ok && tr.status !== 409) {
      const e = await tr.json().catch(() => ({}));
      $("sign-status").textContent = e.error || `transition refused (${tr.status})`;
      return;
    }
    const sg = await api(`/api/cases/${encodeURIComponent(caseId)}/signable`);
    const sb = await sg.json();
    if (!sg.ok) {
      $("sign-status").textContent = sb.error || `signable failed (${sg.status})`;
      return;
    }
    $("unsigned-tx").value = JSON.stringify(sb.tx, null, 2);
    state.signdoc = sb.signdoc;
    state.chainId = sb.chainId;
    $("sign-steps").hidden = false;
    $("sign-status").textContent =
      `Case ${caseId} — unsigned tx ready for chain ${sb.chainId}. ` +
      "Sign with the institution key; nothing is broadcast by this desk.";
    say("Unsigned transaction ready");
    $("txhash-in").focus();
  } catch (e) {
    $("sign-status").textContent = `Could not prepare the transaction — draft preserved. (${e.message})`;
  }
}

async function markBroadcast() {
  const d = state.draft;
  const txhash = $("txhash-in").value.trim();
  if (!d?.caseId || !txhash) {
    $("sign-status").textContent = "Paste the transaction hash from the external broadcast.";
    return;
  }
  const res = await api(`/api/cases/${encodeURIComponent(d.caseId)}/broadcast`, {
    method: "POST", body: { txhash },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("sign-status").textContent = b.error || `broadcast record refused (${res.status})`;
    return;
  }
  $("sign-status").textContent =
    `Broadcast recorded (${b.txhash.slice(0, 12)}…). Now check the chain receipt.`;
  say("Broadcast recorded — awaiting chain receipt");
  await checkReceipt();
}

async function relaySigned() {
  const d = state.draft;
  let doc;
  try { doc = JSON.parse($("signed-doc").value); }
  catch { $("sign-status").textContent = "The signed document is not valid JSON."; return; }
  if (!d?.caseId) return;
  const res = await api(`/api/cases/${encodeURIComponent(d.caseId)}/broadcast`, {
    method: "POST", body: { signedDoc: doc },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("sign-status").textContent = b.error || `relay failed (${res.status})`;
    return;
  }
  $("sign-status").textContent =
    `Relayed (${String(b.txhash).slice(0, 12)}…). Now check the chain receipt.`;
  say("Broadcast relayed — awaiting chain receipt");
  await checkReceipt();
}

async function checkReceipt() {
  const d = state.draft;
  if (!d?.caseId) return;
  const res = await api(`/api/cases/${encodeURIComponent(d.caseId)}/confirm`, { method: "POST" });
  const b = await res.json().catch(() => ({}));
  if (b.state === "confirmed") {
    d.signed = true;
    await Drafts.save(d);
    $("sign-status").textContent =
      `Receipt confirmed on chain (case ${d.caseId}). Draft is now immutable.`;
    say("Receipt confirmed on chain");
    setTimeout(() => { state.draft = blankDraft(); renderDraft(); show("receive"); }, 1400);
  } else if (b.state === "unknown") {
    $("sign-status").textContent =
      "No chain receipt yet — the case stays recoverable in the Case view. " +
      "Broadcast the signed tx, then check again.";
  } else {
    $("sign-status").textContent = b.error || `confirmation state: ${b.state || res.status}`;
  }
}

// ---------- case view -----------------------------------------------------------
async function loadCaseList() {
  const ul = $("case-list");
  ul.replaceChildren();
  if (!state.token) return;
  try {
    const res = await api("/api/cases");
    if (!res.ok) return;
    const { cases } = await res.json();
    for (const c of cases || []) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${c.case_id} · ${c.kind} · kit ${c.kit_id} · op ${c.op_id}`;
      li.appendChild(label);
      li.appendChild(tag(c.state === "confirmed" ? "ok" : c.state === "failed" ? "bad" : "warn", c.state));
      if (c.state !== "confirmed" && c.state !== "failed") {
        const btn = document.createElement("button");
        btn.className = "btn ghost";
        btn.type = "button";
        btn.textContent = "Check receipt";
        btn.onclick = async () => {
          const r = await api(`/api/cases/${encodeURIComponent(c.case_id)}/confirm`, { method: "POST" });
          const b = await r.json().catch(() => ({}));
          say(b.state === "confirmed" ? `${c.case_id} confirmed` : `${c.case_id}: ${b.state || r.status}`);
          loadCaseList();
        };
        li.appendChild(btn);
      }
      ul.appendChild(li);
    }
    if (!ul.children.length) {
      const li = document.createElement("li");
      li.textContent = "No cases for this institution yet.";
      ul.appendChild(li);
    }
  } catch { markCache(false); }
}

async function loadCase() {
  const kit = $("case-kit").value.trim();
  const legId = $("case-leg").value;
  if (!kit) return;
  const body = $("case-body");
  body.replaceChildren();
  try {
    const calls = [
      api(`/api/reader/exceptions?id=${encodeURIComponent(kit)}`),
      api(`/api/reader/kit?id=${encodeURIComponent(kit)}`),
    ];
    if (legId) calls.push(api(`/api/reader/leg?id=${encodeURIComponent(legId)}`));
    const [excRes, kitRes, legRes] = await Promise.all(calls);
    markCache(excRes.ok && kitRes.ok && (!legRes || legRes.ok));
    const excs = (await excRes.json()).exceptions || [];
    const kitJ = await kitRes.json();
    const leg = legRes ? await legRes.json() : null;

    const statements = [];
    if (leg && leg.openHeight) {
      statements.push({
        org: leg.sender, h: leg.openHeight,
        text: `dispatched ${Object.entries(leg.qty || {}).map(([k, v]) => `${k}×${v}`).join(", ")}`,
      });
      if (leg.observed) {
        statements.push({
          org: leg.dest, h: leg.openHeight,
          text: `received ${Object.entries(leg.accepted || {}).map(([k, v]) => `${k}×${v}`).join(", ") || "nothing"}`,
        });
      }
      if (leg.closeHeight) {
        statements.push({ org: leg.sender, h: leg.closeHeight, text: "leg closed" });
      }
    }
    for (const e of excs) {
      statements.push({
        org: e.by, h: e.openHeight,
        text: `${e.kind} exception on ${e.line} — ${e.reason} (${e.status})`,
      });
    }
    statements.sort((a, b) => a.h - b.h);
    for (const s of statements) {
      const div = document.createElement("div");
      div.className = "case-statement";
      const h = document.createElement("h4"); h.textContent = s.org;
      const p = document.createElement("p"); p.textContent = s.text;
      const meta = document.createElement("p");
      meta.className = "case-meta";
      meta.textContent = `block height ${s.h}`;
      div.append(h, p, meta);
      body.appendChild(div);
    }
    const disputed = excs.filter((e) => e.status === "open");
    if (disputed.length) {
      const p = document.createElement("p");
      p.appendChild(tag("bad", "disputed"));
      p.appendChild(document.createTextNode(
        " " + disputed.map((e) => `${e.line}: ${e.kind}`).join(", ")));
      body.appendChild(p);
    }
    const np = document.createElement("p");
    np.className = "case-meta";
    np.textContent = `Next authorized role: ${
      kitJ.hold ? "owner assessment required" :
      kitJ.available ? "kit available — no action" : "awaiting receiving desk"}`;
    body.appendChild(np);
    if (state.org && kitJ.owner === state.org && kitJ.needsAssessment) {
      const b = document.createElement("button");
      b.className = "btn primary";
      b.textContent = "Open assessment";
      b.onclick = () => {
        state.draft = blankDraft();
        state.draft.kit = kit;
        saveDraft();
        show("receive");
      };
      body.appendChild(b);
    }
  } catch (e) {
    markCache(false);
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load case: ${e.message}`;
    body.appendChild(p);
  }
}

// Populate the leg selector whenever the case kit changes.
async function loadCaseLegs() {
  const kit = $("case-kit").value.trim();
  const sel = $("case-leg");
  sel.replaceChildren();
  if (!kit || !state.token) { sel.appendChild(new Option("", "")); return; }
  try {
    const res = await api(`/api/kits/${encodeURIComponent(kit)}`);
    if (!res.ok) { sel.appendChild(new Option("", "")); return; }
    const { legs } = await res.json();
    for (const l of legs || []) {
      sel.appendChild(new Option(`${l.leg_id} · ${l.sender} → ${l.dest} · ${l.status}`, l.leg_id));
    }
    if (!legs?.length) sel.appendChild(new Option("(no legs)", ""));
  } catch {
    sel.appendChild(new Option("", ""));
  }
}

// ---------- session -------------------------------------------------------------
async function requestChallenge(ev) {
  ev.preventDefault();
  const org = $("login-org").value.trim();
  const addr = $("login-addr").value.trim();
  const deviceId = $("login-device").value.trim();
  const res = await api("/api/session/challenge", {
    method: "POST", body: { addr, org, deviceId },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("login-status").textContent =
      res.status === 403
        ? "That address holds no active grant in this institution — an address alone cannot sign you in."
        : `Challenge failed: ${b.error || res.status}`;
    $("challenge-steps").hidden = false;
    return;
  }
  state.challengeId = b.challengeId;
  state.device = deviceId;
  $("ch-tx").value = JSON.stringify(b.tx, null, 2);
  $("challenge-steps").hidden = false;
  $("login-status").textContent = "Challenge issued — sign it with the institution key.";
  say("Challenge issued");
}

async function completeLogin() {
  const pubkey = $("ch-pubkey").value.trim();
  const sig = $("ch-sig").value.trim();
  const res = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({ challengeId: state.challengeId, pubkey, signature: sig }),
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("login-status").textContent = `Sign-in refused: ${b.error || res.status}`;
    return;
  }
  state.token = b.token;
  state.org = b.org;
  state.addr = b.addr;
  localStorage.setItem("kt.token", b.token);
  localStorage.setItem("kt.org", b.org);
  localStorage.setItem("kt.addr", b.addr);
  if (state.device) localStorage.setItem("kt.device", state.device);
  renderWho();
  $("logout").hidden = false;
  $("login-status").textContent = `Signed in as ${b.org}.`;
  say("Signed in");
  await loadKits();
  // Reload the scope's unsigned draft after sign-in.
  const drafts = await Drafts.all();
  state.draft = drafts.find((d) => !d.signed && d.scope === scopeKey()) || blankDraft();
  renderDraft();
  if (state.draft.kit) $("kit-sel").value = state.draft.kit;
  show("receive");
}

async function logout() {
  await api("/api/session", { method: "DELETE" });
  clearSession();
  await loadKits();
  say("Signed out");
}

// ---------- wiring -----------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  const drafts = await Drafts.all();
  state.draft = drafts.find((d) => !d.signed && d.scope === scopeKey()) || blankDraft();
  renderDraft();
  renderWho();
  await loadKits();

  document.querySelectorAll("[data-nav]").forEach((b) => {
    b.addEventListener("click", () => show(b.dataset.nav));
  });

  // The input is cleared synchronously — before addScan's async IndexedDB
  // write — so a fast next scan can't be overwritten by a mid-flight save.
  $("scan-form").addEventListener("submit", (e) => {
    e.preventDefault(); // Enter adds a scan — it never signs.
    const v = $("scan").value;
    $("scan").value = "";
    if (v.trim()) addScan(v);
  });
  $("lookup").addEventListener("click", () => {
    const v = prompt("Component id or barcode:");
    if (v) addScan(v);
  });
  $("undo").addEventListener("click", async () => {
    const s = state.draft.scans.pop();
    await saveDraft();
    say(s ? `${s.code} removed` : "Nothing to undo");
    $("scan").focus();
  });
  $("discard").addEventListener("click", async () => {
    if (state.draft.signed) return;
    if (confirm("Discard this unsigned draft?")) {
      await Drafts.remove(state.draft.id);
      state.draft = blankDraft();
      renderDraft();
      say("Draft discarded");
      $("scan").focus();
    }
  });
  $("exc-add").addEventListener("click", async () => {
    if (state.draft.signed) return;
    const e = {
      kind: $("exc-kind").value,
      line: $("exc-line").value.trim(),
      reason: $("exc-reason").value.trim(),
    };
    if (!e.reason) { say("Exception needs a reason"); $("exc-reason").focus(); return; }
    state.draft.exceptions.push(e);
    await saveDraft();
    say(`${e.kind} exception recorded for ${e.line || "kit"}`);
    $("exc-line").value = "";
    $("exc-reason").value = "";
    $("scan").focus();
  });
  $("kit-sel").addEventListener("change", updateLegInfo);
  $("signoff").addEventListener("click", openSignOff);
  $("back-draft").addEventListener("click", () => { show("receive"); });
  $("do-sign").addEventListener("click", beginSigning);
  $("mark-broadcast").addEventListener("click", markBroadcast);
  $("relay-btn").addEventListener("click", relaySigned);
  $("check-receipt").addEventListener("click", checkReceipt);
  $("back-sign").addEventListener("click", () => { show("receive"); });
  $("download-tx").addEventListener("click", () => {
    const blob = new Blob([$("unsigned-tx").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.draft?.caseId || "tx"}-unsigned.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("copy-tx").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("unsigned-tx").value).catch(() => {});
    say("Unsigned transaction copied");
  });
  $("case-load").addEventListener("click", loadCase);
  $("case-kit").addEventListener("change", loadCaseLegs);
  $("challenge-form").addEventListener("submit", requestChallenge);
  $("ch-submit").addEventListener("click", completeLogin);
  $("logout").addEventListener("click", logout);
  $("logout").hidden = !state.token;

  document.addEventListener("focusin", (e) => {
    if (state.view === "receive" &&
        !/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) {
      $("scan").focus();
    }
  });

  try {
    const res = await fetch("/api/health");
    if (res.ok) {
      const h = await res.json();
      state.network = h.checkpoint?.network || "local dev chain";
      $("net").textContent = `network ${state.network} · checkpoint seq ${h.checkpoint?.last_seq ?? 0}`;
      markCache(true);
    }
  } catch {
    $("net").textContent = "API unreachable — working offline";
    markCache(false);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
