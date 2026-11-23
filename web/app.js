// Kit Transit staff desk. Vanilla JS, no build step.
// Rules from UI-SPEC:
//   - scan input keeps focus; Enter adds a scan, never signs
//   - unsigned drafts can be edited/undone; signed content immutable
//   - sign-off shows the full attestation; refusal leaves a stable route
//   - reconnect re-verifies and diffs the draft before signing
//   - cached views carry a badge + age; colours always have text labels

"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem("kt.token") || null,
  org: localStorage.getItem("kt.org") || null,
  addr: localStorage.getItem("kt.addr") || null,
  network: null,
  draft: null,        // { id, kit, leg, scans:[], lines:{}, exceptions:[] }
  view: "receive",
};

// ---------- api -------------------------------------------------------------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (opts.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) {
    say("Session expired — please sign in again");
    state.token = null;
    localStorage.removeItem("kt.token");
    renderWho();
    show("session");
    throw new Error("unauthorized");
  }
  return res;
}

function say(msg) { $("announce").textContent = msg; }

function renderWho() {
  $("who").textContent = state.addr
    ? `${state.org} · ${state.addr.slice(0, 10)}…`
    : "not signed in";
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
}

// ---------- cached data badge ------------------------------------------------
let lastFetchAt = 0, lastFetchOk = true;
function markCache(ok) {
  lastFetchOk = ok;
  if (ok) lastFetchAt = Date.now();
  const badge = $("cache-badge");
  if (!ok && lastFetchAt) {
    const age = Math.max(1, Math.round((Date.now() - lastFetchAt) / 1000));
    badge.hidden = false;
    badge.textContent = `Cached view — data is ${age}s old, not live`;
  } else {
    badge.hidden = ok;
    if (!ok) badge.textContent = "Offline — showing last known state";
  }
}

// ---------- drafts ------------------------------------------------------------
function blankDraft() {
  return {
    id: `draft-${Date.now()}`,
    kit: "", leg: "", scans: [], lines: {}, exceptions: [], signed: false,
  };
}

function normalizedLines(draft) {
  // Counted lines: serialized scans merge by id; plain barcodes count.
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
  state.draft.lines = normalizedLines(state.draft);
  await Drafts.save(state.draft);
  renderDraft();
}

function renderDraft() {
  const d = state.draft;
  if (!d) return;
  $("draft-state").textContent =
    `Draft ${d.signed ? "(signed — immutable)" : "unsaved signature"} · ` +
    `${d.scans.length} raw scans · ${Object.keys(d.lines).length} counted lines`;
  $("undo").disabled = d.signed || d.scans.length === 0;
  $("discard").disabled = d.signed;
  $("signoff").disabled = d.signed || Object.keys(d.lines).length === 0;
  const ul = $("lines");
  ul.innerHTML = "";
  for (const [key, ln] of Object.entries(d.lines)) {
    const li = document.createElement("li");
    const label = ln.serial ? `${ln.code} · serial ${ln.serial}` : ln.code;
    const tag = ln.serial
      ? `<span class="tag ok">serialized ×1</span>`
      : `<span class="tag warn">count ${ln.count}</span>`;
    li.innerHTML = `<span>${label}</span>${tag}`;
    ul.appendChild(li);
  }
  for (const e of d.exceptions) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${e.line || "kit"} — ${e.kind}: ${e.reason}</span>` +
      `<span class="tag bad">exception</span>`;
    ul.appendChild(li);
  }
}

// ---------- scanner -----------------------------------------------------------
// Barcode "code[serial]" — a serial suffix marks a serialized unit which is
// always counted once; identical re-scans are merged with an explanation.
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
  $("scan").value = "";
  $("scan").focus();
}

// ---------- sign-off -----------------------------------------------------------
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
    kitId: d.kit || "kit",
    opId: `desk-${Date.now()}`,
    args: {
      opID: `desk-${Date.now()}`,
      legID: d.leg || "leg",
      accepted: accepted.join(";"),
      conds: conds.join(";"),
      missing: missing.join(";"),
      reason: d.exceptions.map((e) => e.reason).join("; ") || "",
    },
  };
}

async function openSignOff() {
  const d = state.draft;
  if (!d) return;
  // Reconnect check: refetch kit state and diff the draft before preview.
  let diff = "";
  try {
    const res = await api(`/api/kits/${encodeURIComponent(d.kit || "kit")}`);
    markCache(res.ok);
    if (res.ok) {
      const kit = await res.json();
      const manifestRev = kit.kit?.manifest_rev;
      const revChanged = d.manifestRev !== undefined && d.manifestRev !== manifestRev;
      d.manifestRev = manifestRev;
      if (revChanged) {
        diff = `Manifest changed since drafting (now rev ${manifestRev}) — please re-review.`;
      }
    }
  } catch {
    markCache(false);
    diff = "Offline — the preview below is from your local draft only.";
  }

  const pv = $("preview");
  const lines = Object.values(d.lines);
  pv.innerHTML = "";
  const rows = [
    ["Origin", d.origin || "(partner institution)"],
    ["Destination", state.org || "(your institution)"],
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
  $("sign-status").textContent = "";
  if (diff) say(diff);
  show("sign");
}

// Wallet/signature refusal leaves the stable route: stay on the sign view,
// keep the draft, let the desk retry or go back.
async function submitSignature() {
  const pubkey = $("sig-pubkey").value.trim();
  const sig = $("sig-value").value.trim();
  if (!pubkey || !sig) {
    $("sign-status").textContent = "Paste both pub_key and signature values.";
    return;
  }
  const payload = buildPayload();
  try {
    const c = await api("/api/cases", {
      method: "POST",
      body: { kind: payload.kind, kitId: payload.kitId, opId: payload.opId, args: payload.args },
    });
    if (!c.ok) {
      const err = await c.json().catch(() => ({}));
      $("sign-status").textContent = `Case rejected: ${err.error || c.status}`;
      return;
    }
    const kase = await c.json();
    await api(`/api/cases/${kase.caseId}/transition`, {
      method: "POST", body: { state: "signature-request" },
    });
    await api(`/api/cases/${kase.caseId}/transition`, {
      method: "POST", body: { state: "broadcast" },
    });
    // Confirmation is the realm receipt — never the transport response.
    const conf = await api(`/api/cases/${kase.caseId}/confirm`, { method: "POST" });
    const confBody = await conf.json();
    if (confBody.state === "confirmed") {
      state.draft.signed = true;
      await Drafts.save(state.draft);
      $("sign-status").textContent =
        `Receipt confirmed on chain (case ${kase.caseId}). Draft is now immutable.`;
      say("Receipt confirmed on chain");
      setTimeout(() => { state.draft = blankDraft(); renderDraft(); show("receive"); }, 1200);
    } else {
      $("sign-status").textContent =
        `Broadcast state: ${confBody.state || conf.status} — case ${kase.caseId} ` +
        `is recoverable via the case view once the chain confirms.`;
    }
  } catch (e) {
    $("sign-status").textContent = `Could not reach the API — draft preserved. (${e.message})`;
  }
}

// ---------- case view -----------------------------------------------------------
async function loadCase() {
  const kit = $("case-kit").value.trim();
  if (!kit) return;
  const body = $("case-body");
  body.innerHTML = "";
  try {
    const [legRes, excRes, kitRes] = await Promise.all([
      api(`/api/reader/leg?id=${encodeURIComponent("leg-1")}`),
      api(`/api/reader/exceptions?id=${encodeURIComponent(kit)}`),
      api(`/api/reader/kit?id=${encodeURIComponent(kit)}`),
    ]);
    markCache(legRes.ok && excRes.ok && kitRes.ok);
    const leg = await legRes.json();
    const excs = (await excRes.json()).exceptions || [];
    const kitJ = await kitRes.json();

    // Both institutional statements chronologically, with heights.
    const statements = [];
    if (leg.openHeight) {
      statements.push({
        org: leg.sender, h: leg.openHeight,
        text: `dispatched ${Object.entries(leg.dispatched || {}).map(([k, v]) => `${k}×${v}`).join(", ")}`,
      });
    }
    if (leg.observed) {
      statements.push({
        org: leg.dest, h: leg.openHeight,
        text: `received ${Object.entries(leg.accepted || {}).map(([k, v]) => `${k}×${v}`).join(", ") || "nothing"}`,
      });
    }
    if (leg.closeHeight) {
      statements.push({ org: leg.sender, h: leg.closeHeight, text: "leg closed" });
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
      div.innerHTML = `<h4>${s.org}</h4><p>${s.text}</p>` +
        `<p class="case-meta">block height ${s.h}</p>`;
      body.appendChild(div);
    }
    const disputed = excs.filter((e) => e.status === "open");
    if (disputed.length) {
      const p = document.createElement("p");
      p.innerHTML = `<span class="tag bad">disputed</span> ` +
        disputed.map((e) => `${e.line}: ${e.kind}`).join(", ");
      body.appendChild(p);
    }
    const next = kitJ.hold ? "owner assessment required" :
      kitJ.available ? "kit available — no action" : "awaiting receiving desk";
    const np = document.createElement("p");
    np.className = "case-meta";
    np.textContent = `Next authorized role: ${next}`;
    body.appendChild(np);
    // Owner-side assessment control appears only to the owner org's staff.
    if (state.org && kitJ.owner === state.org && kitJ.needsAssessment) {
      const b = document.createElement("button");
      b.className = "btn primary";
      b.textContent = "Open assessment";
      b.onclick = () => { state.draft = blankDraft(); state.draft.kit = kit; show("receive"); };
      body.appendChild(b);
    }
  } catch (e) {
    markCache(false);
    body.innerHTML = `<p class="hint">Could not load case: ${e.message}</p>`;
  }
}

// ---------- session -------------------------------------------------------------
async function requestChallenge(ev) {
  ev.preventDefault();
  const org = $("login-org").value.trim();
  const addr = $("login-addr").value.trim();
  const deviceId = $("login-device").value.trim();
  const res = await api("/api/session/challenge", {
    method: "POST", body: JSON.stringify({ addr, org, deviceId }),
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
  renderWho();
  $("logout").hidden = false;
  $("login-status").textContent = `Signed in as ${b.org}.`;
  say("Signed in");
  show("receive");
}

async function logout() {
  await api("/api/session", { method: "DELETE" });
  state.token = null;
  localStorage.removeItem("kt.token");
  $("logout").hidden = true;
  renderWho();
  say("Signed out");
}

// ---------- wiring -----------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  state.draft = (await Drafts.all()).find((d) => !d.signed) || blankDraft();
  renderDraft();
  renderWho();

  document.querySelectorAll("[data-nav]").forEach((b) => {
    b.addEventListener("click", () => show(b.dataset.nav));
  });

  $("scan-form").addEventListener("submit", (e) => {
    e.preventDefault(); // Enter adds a scan — it never signs.
    const v = $("scan").value.trim();
    if (v) addScan(v);
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
    $("scan").focus(); // focus returns to the scan lane afterwards
  });
  $("signoff").addEventListener("click", openSignOff);
  $("back-draft").addEventListener("click", () => { show("receive"); });
  $("do-sign").addEventListener("click", () => {
    // Build the unsigned case locally — the desk never holds keys.
    $("sign-steps").hidden = false;
    const payload = buildPayload();
    $("unsigned-tx").value = JSON.stringify(
      { note: "create POST /api/cases with this payload after signing externally",
        payload }, null, 2);
    $("sig-pubkey").focus();
  });
  $("confirm-sign").addEventListener("click", submitSignature);
  $("case-load").addEventListener("click", loadCase);
  $("challenge-form").addEventListener("submit", requestChallenge);
  $("ch-submit").addEventListener("click", completeLogin);
  $("logout").addEventListener("click", logout);
  $("logout").hidden = !state.token;

  // Refocus the scan lane after any interaction ends outside a form field.
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
