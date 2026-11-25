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
  // The one reviewed thing currently being signed — a receive draft case,
  // an owner assessment, a release, or a resumed server-side case.
  review: null,
  queue: null,
  queueTab: "incoming",
  view: "queue",
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
    if (state.token) clearSession();
    else show("session");
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
  state.token = state.org = state.addr = state.device = null;
  state.draft = state.review = state.queue = null;
  for (const k of ["kt.token", "kt.org", "kt.addr", "kt.device"]) {
    localStorage.removeItem(k);
  }
  // Discard signed-in DOM, including evidence inputs and any pending network
  // callbacks, before another institution uses this shared desk.
  document.querySelector("main").hidden = true;
  location.hash = "session";
  location.reload();
}

// ---------- views -----------------------------------------------------------
const VIEWS = ["queue", "receive", "sign", "case", "session"];
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
  if (name === "queue") loadQueue();
}

// ---------- institution work queue ------------------------------------------
// Start view. Every row is institution-scoped chain/projection state — a
// desk's local scans never make anything look received or available here.
async function loadQueue() {
  const body = $("queue-body");
  body.replaceChildren();
  if (!state.token) {
    $("queue-sub").textContent =
      "Sign in with an enrolled institution key to see this desk's queue.";
    for (const t of ["incoming", "outgoing", "exceptions", "audit"]) {
      $(`qtab-${t}`).textContent = `${t[0].toUpperCase() + t.slice(1)} (0)`;
    }
    return;
  }
  try {
    const res = await api("/api/queue");
    markCache(res.ok);
    if (!res.ok) { $("queue-sub").textContent = "Queue unavailable."; return; }
    const q = await res.json();
    state.queue = q;
    $("queue-sub").textContent =
      `${q.org} — ${q.counts.incoming} incoming · ${q.counts.outgoing} outgoing · ` +
      `${q.counts.exceptions} open exceptions`;
    for (const t of ["incoming", "outgoing", "exceptions", "audit"]) {
      $(`qtab-${t}`).textContent = `${t[0].toUpperCase() + t.slice(1)} (${q.counts[t]})`;
      $(`qtab-${t}`).setAttribute("aria-selected", String(state.queueTab === t));
    }
    renderQueueTab();
  } catch {
    markCache(false);
    if (state.queue) {
      $("queue-sub").textContent = "Offline — showing the last known queue.";
      renderQueueTab();
    } else {
      $("queue-sub").textContent = "Offline — reconnect to load the institution queue. Unsigned drafts are in Receive.";
      for (const tab of ["incoming","outgoing","exceptions","audit"]) {
        $("qtab-" + tab).textContent = tab[0].toUpperCase() + tab.slice(1) + " (unknown)";
      }
    }
  }
}

const EMPTY_QUEUE = {
  incoming: "Nothing incoming — no open legs addressed to this institution.",
  outgoing: "Nothing outgoing — no dispatches awaiting partner receipt.",
  exceptions: "No open exceptions on kits this institution is party to.",
  audit: "No audited events for this institution yet.",
};

function renderQueueTab() {
  const q = state.queue, tab = state.queueTab;
  const body = $("queue-body");
  body.replaceChildren();
  if (!q) return;
  const rows = q[tab] || [];
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = EMPTY_QUEUE[tab];
    body.appendChild(li);
    return;
  }
  for (const r of rows) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    if (tab === "audit") {
      label.textContent =
        `#${r.seq} h${r.height} · ${r.kind} · ${r.kit || r.org}${r.line ? " · " + r.line : ""}`;
      li.appendChild(label);
    } else if (tab === "exceptions") {
      label.textContent =
        `${r.kit} · ${r.line} — ${r.reason || "(no reason)"} · ${r.by ? "by " + r.by : "reporting institution unknown"} · h${r.lastHeight}`;
      li.appendChild(label);
      li.appendChild(tag(r.kind === "missing" ? "bad" : "warn", r.label));
    } else if (r.row === "inspection") {
      label.textContent =
        `${r.kit} · returned to owner — assess before release · h${r.lastHeight}`;
      li.appendChild(label);
      li.appendChild(tag("warn", "needs inspection"));
    } else {
      const out = r.outstanding.map((o) => `${o.line}×${o.qty}`).join(", ");
      label.textContent =
        `${r.kit} · ${r.partner} · ${r.received}/${r.expected} received` +
        (out ? ` · outstanding ${out}` : "") +
        (r.oldestOutstanding ? ` · oldest: ${r.oldestOutstanding}` : "") +
        ` · h${r.lastHeight}`;
      li.appendChild(label);
      li.appendChild(tag("warn", r.label));
    }
    body.appendChild(li);
  }
}

// ---------- cached data badge ------------------------------------------------
let lastFetchAt = 0;
function markCache(ok) {
  if (ok) lastFetchAt = Date.now();
  const badge = $("cache-badge");
  if (!ok) {
    badge.hidden = false;
    const timestamp = state.draft?.sourceCheckedAt ?? lastFetchAt;
    badge.textContent = timestamp
      ? `Cached view — data last checked ${Math.max(0, Math.round((Date.now() - timestamp) / 1000))}s ago`
      : "Offline — the age of this view is unknown";
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
    if (d) d.sourceCheckedAt = Date.now();
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

// One reviewed op + payload per case, persisted across reload/retry.
// The case is created lazily at signing time for receive drafts, or
// immediately for assessment/release/resume flows.
async function ensureReviewCase() {
  const r = state.review;
  if (r.caseId) return r.caseId;
  const res = await api("/api/cases", {
    method: "POST",
    body: { kind: r.kind, kitId: r.kitId, opId: r.opId, args: r.args },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `case create failed (${res.status})`);
  r.caseId = b.caseId;
  if (state.draft && r.kind === "receive") {
    state.draft.caseId = r.caseId;
    await saveDraft();
  }
  return r.caseId;
}

// ---------- sign-off -----------------------------------------------------------
let reReviewNeeded = false;

function openReview(review) {
  state.review = review;
  state.signdoc = null;
  for (const field of ["unsigned-tx", "signed-doc", "txhash-in"]) $(field).value = "";
  $("revdiff").hidden = true; // populated later by renderRevDiff when needed
  const pv = $("preview");
  pv.replaceChildren();
  for (const [k, v] of review.rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    pv.append(dt, dd);
  }
  $("attest").textContent = review.attest;
  $("sign-steps").hidden = true;
  $("sign-status").textContent = review.statusNote || "";
  $("do-sign").disabled = reReviewNeeded;
  show("sign");
}

// Real before/after manifest diff: both revisions are immutable on the
// realm, so the diff is fetched from the realm itself — never recomputed
// from local guesses.
async function renderRevDiff(kit, oldRev, newRev) {
  const box = $("revdiff"), ul = $("revdiff-lines");
  ul.replaceChildren();
  $("re-review").disabled = true;
  try {
    const [a, b] = await Promise.all([
      api(`/api/reader/manifest?kit=${encodeURIComponent(kit)}&rev=${oldRev}`),
      api(`/api/reader/manifest?kit=${encodeURIComponent(kit)}&rev=${newRev}`),
    ]);
    markCache(a.ok && b.ok);
    const oldM = a.ok ? await a.json() : null;
    const newM = b.ok ? await b.json() : null;
    if (!oldM?.digest || !newM?.digest || !Array.isArray(oldM.lines) || !Array.isArray(newM.lines)) {
      throw new Error("Manifest revisions unavailable");
    }
    if (oldM.policy !== newM.policy) {
      const li = document.createElement("li");
      li.textContent = `Policy changed: ${oldM.policy} → ${newM.policy}`;
      ul.appendChild(li);
    }
    const oldL = new Map((oldM?.lines || []).map((l) => [l.id, l]));
    const newL = new Map((newM?.lines || []).map((l) => [l.id, l]));
    const describe = (l) => l ? `${l.qty}× ${l.label || l.id}${Number(l.serialized) === 1 ? " · serialized" : ""}` : "";
    for (const id of [...new Set([...oldL.keys(), ...newL.keys()])].sort()) {
      const o = oldL.get(id), n = newL.get(id);
      const li = document.createElement("li");
      const span = document.createElement("span");
      if (o && !n) {
        span.textContent = `${id} removed — was ${describe(o)}`;
        li.append(span, tag("bad", "removed"));
      } else if (!o && n) {
        span.textContent = `${id} added — now ${describe(n)}`;
        li.append(span, tag("warn", "added"));
      } else {
        const same = o.qty === n.qty && o.label === n.label &&
          o.serialized === n.serialized && o.unit === n.unit;
        if (same) continue;
        span.textContent = `${id} changed — ${describe(o)} → ${describe(n)}`;
        li.append(span, tag("warn", "changed"));
      }
      ul.appendChild(li);
    }
    $("re-review").disabled = false;
    if (!ul.children.length) {
      const li = document.createElement("li");
      li.textContent = `rev ${oldRev} → rev ${newRev}: no line changes (policy/digest only)`;
      ul.appendChild(li);
    }
  } catch {
    $("re-review").disabled = true;
    markCache(false);
    const li = document.createElement("li");
    li.textContent = `rev ${oldRev} → rev ${newRev} (revision detail unavailable offline)`;
    ul.appendChild(li);
  }
  box.hidden = false;
}

async function openSignOff() {
  const d = state.draft;
  if (!d || !d.leg) return;
  reReviewNeeded = Boolean(d.pendingManifestReview);
  const oldRev = d.pendingManifestReview?.from ?? d.manifestRev;
  try {
    const res = await api(`/api/kits/${encodeURIComponent(d.kit)}`);
    markCache(res.ok);
    if (res.ok) {
      const j = await res.json();
      const manifestRev = j.kit?.manifest_rev;
      if (d.manifestRev !== undefined && d.manifestRev !== manifestRev) {
        d.pendingManifestReview = { from: oldRev, to: manifestRev };
        reReviewNeeded = true;
        d.caseId = null; // the reviewed payload predates the change
      }
      d.manifestRev = manifestRev;
    }
  } catch {
    markCache(false);
  }

  const lines = Object.values(d.lines);
  openReview({
    kind: "receive", opId: d.opId, kitId: d.kit,
    args: buildPayload().args, caseId: d.caseId, after: "receive",
    rows: [
      ["Origin", d.origin || "(partner institution)"],
      ["Destination", state.org || "(your institution)"],
      ["Kit / leg", `${d.kit} · ${d.leg}`],
      ["Operation id", d.opId],
      ["Manifest version", d.manifestRev !== undefined
        ? `rev ${d.manifestRev}${oldRev !== undefined && oldRev !== d.manifestRev ? ` (was rev ${oldRev})` : ""}`
        : "unverified — offline"],
      ["Accepted lines", lines.map((l) => `${l.code}×${l.serial ? 1 : l.count}`).join("; ") || "none"],
      ["Missing lines", d.exceptions.filter((e) => e.kind === "missing").map((e) => e.line).join("; ") || "none"],
      ["Condition flags", d.exceptions.filter((e) => e.kind !== "missing").map((e) => `${e.line}:${e.kind}`).join("; ") || "none"],
      ["Signing account", state.addr || "not signed in"],
      ["Network", state.network || "local dev chain"],
    ],
    attest:
      "This signature attests that the listed components physically arrived " +
      "at your institution in the stated condition, and records the exceptions " +
      "shown as part of the kit's permanent custody record.",
    statusNote: reReviewNeeded
      ? "Manifest changed since drafting — re-review the diff above, then confirm."
      : "",
  });
  if (reReviewNeeded) {
    say("Manifest changed — re-review required");
    await renderRevDiff(d.kit, oldRev, d.manifestRev);
    await saveDraft();
  }
}

// Wallet/signature refusal leaves the stable route: the case and draft
// survive, nothing is broadcast, staff can retry or go back.
async function beginSigning() {
  const requestedReview = state.review;
  if (!requestedReview || reReviewNeeded) return;
  $("sign-status").textContent = "";
  try {
    const caseId = await ensureReviewCase();
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
    if (state.review !== requestedReview) return;
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
    $("sign-status").textContent = `Could not prepare the transaction — review preserved. (${e.message})`;
  }
}

async function markBroadcast() {
  const txhash = $("txhash-in").value.trim();
  if (!state.review?.caseId || !txhash) {
    $("sign-status").textContent = "Paste the transaction hash from the external broadcast.";
    return;
  }
  const res = await api(`/api/cases/${encodeURIComponent(state.review.caseId)}/broadcast`, {
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
  let doc;
  try { doc = JSON.parse($("signed-doc").value); }
  catch { $("sign-status").textContent = "The signed document is not valid JSON."; return; }
  if (!state.review?.caseId) return;
  const res = await api(`/api/cases/${encodeURIComponent(state.review.caseId)}/broadcast`, {
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
  const r = state.review;
  if (!r?.caseId) return;
  const res = await api(`/api/cases/${encodeURIComponent(r.caseId)}/confirm`, { method: "POST" });
  const b = await res.json().catch(() => ({}));
  if (b.state === "confirmed") {
    $("sign-status").textContent =
      `Receipt confirmed on chain (case ${r.caseId}).`;
    say("Receipt confirmed on chain");
    if (r.after === "receive" && state.draft && state.draft.caseId === r.caseId) {
      state.draft.signed = true;
      await Drafts.save(state.draft);
      setTimeout(() => { state.draft = blankDraft(); renderDraft(); show("receive"); }, 1400);
    } else if (r.after === "assess" || r.after === "release") {
      setTimeout(() => { loadCase(); show("case"); }, 1200);
    }
  } else if (b.state === "unknown") {
    $("sign-status").textContent =
      "No chain receipt yet — the case stays recoverable in the Case view. " +
      "Broadcast the signed tx, then check again.";
  } else {
    $("sign-status").textContent = b.error || `confirmation state: ${b.state || res.status}`;
  }
}

// ---------- private evidence attachment ---------------------------------------
// Attachments are separate from the receipt: a failed upload never affects
// case state, and a permitted user can always retry (T-024). The file bytes
// are held in memory until the retry succeeds — nothing is sent on submit.
let lastEvFile = null;
async function uploadEvidence() {
  const caseId = $("ev-case").value;
  const file = $("ev-file").files[0] || lastEvFile;
  if (!caseId) {
    $("ev-status").textContent = "Choose the case this attachment belongs to.";
    return;
  }
  if (!file) {
    $("ev-status").textContent = "Choose a photo or PDF first.";
    return;
  }
  lastEvFile = file;
  try {
    const res = await api(`/api/evidence?case=${encodeURIComponent(caseId)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(b.error || `upload failed (${res.status})`);
    $("ev-status").textContent =
      `Attachment stored privately (${b.bytes} bytes) — visible only to ${state.org} staff on this case.`;
    $("ev-retry").hidden = true;
    say("Attachment uploaded");
  } catch (e) {
    // The receipt is unaffected; only this attachment needs retrying.
    $("ev-status").textContent =
      `Upload failed — the receipt itself is unaffected. (${e.message})`;
    $("ev-retry").hidden = false;
    say("Attachment upload failed — retry available");
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
    const evSel = $("ev-case");
    evSel.replaceChildren();
    for (const c of cases || []) {
      evSel.appendChild(new Option(`${c.case_id} · ${c.kind} · ${c.state}`, c.case_id));
    }
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
        // Resume the exact reviewed case — the signable tx is rebuilt from
        // the server-side payload, so nothing is re-derived locally.
        const resume = document.createElement("button");
        resume.className = "btn ghost";
        resume.type = "button";
        resume.textContent = "Resume signing";
        resume.onclick = () => {
          reReviewNeeded = false;
          $("revdiff").hidden = true;
          openReview({
            kind: c.kind, opId: c.op_id, kitId: c.kit_id,
            caseId: c.case_id, after: c.kind === "receive" ? "receive" : "assess",
            rows: [
              ["Case", `${c.case_id} · ${c.kind}`],
              ["Kit", c.kit_id],
              ["Operation id", c.op_id],
              ["State", c.state],
              ["Signing account", state.addr || "not signed in"],
              ["Network", state.network || "local dev chain"],
            ],
            attest:
              "This signature attests the reviewed payload held by this " +
              "case — exactly what you reviewed, nothing re-derived.",
          });
        };
        li.appendChild(resume);
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
  $("assess-panel").hidden = true;
  $("release-kit").hidden = true;
  try {
    const calls = [
      api(`/api/reader/exceptions?id=${encodeURIComponent(kit)}`),
      api(`/api/reader/kit?id=${encodeURIComponent(kit)}`),
    ];
    const [excRes, kitRes] = await Promise.all(calls);
    markCache(excRes.ok && kitRes.ok);
    const excs = (await excRes.json()).exceptions || [];
    const kitJ = await kitRes.json();


    void showKitTimeline(body, kit, legId);
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
      kitJ.needsAssessment ? "owner assessment required" :
      kitJ.available ? "kit available — no action" :
      kitJ.activeLeg ? "receiving desk at destination" :
      kitJ.hold ? "held — awaiting movement" : "no action pending"}`;
    body.appendChild(np);

    // Owner assessment: requires the realm's needsAssessment flag AND the
    // caller to be the owner — the realm enforces the same check on the
    // signature, so a non-owner sees no control and a forged call fails.
    const isOwner = state.org && kitJ.owner === state.org;
    const panel = $("assess-panel");
    const relBtn = $("release-kit");
    panel.hidden = !(isOwner && kitJ.needsAssessment);
    if (isOwner && kitJ.needsAssessment) {
      const ul = $("assess-lines");
      ul.replaceChildren();
      for (const ln of kitJ.lines || []) {
        const li = document.createElement("li");
        const span = document.createElement("span");
        const heldByOwner = (ln.held && ln.held[kitJ.owner]) || 0;
        span.textContent =
          `${ln.id} — required ${ln.required}, owner holds ${heldByOwner}` +
          ` · last assessment: ${ln.assessment || "pending"}`;
        const sel = document.createElement("select");
        sel.dataset.line = ln.id;
        sel.setAttribute("aria-label", `assessment for ${ln.id}`);
        for (const code of ["ok", "damaged", "disputed"]) {
          sel.appendChild(new Option(code, code));
        }
        li.append(span, sel);
        ul.appendChild(li);
      }
      panel.dataset.kit = kit;
      $("assess-status").textContent = "";
    }
    // Release: owner only, all lines serviceable, custody home, no open
    // exceptions or active leg. The realm re-checks all of it on the tx.
    const releaseReady = isOwner && kitJ.hold && !kitJ.available &&
      !kitJ.needsAssessment && !kitJ.activeLeg &&
      (kitJ.openExceptions || []).length === 0 &&
      (kitJ.lines || []).every((ln) => ln.assessment === "serviceable" &&
        ((ln.held && ln.held[kitJ.owner]) || 0) >= ln.required);
    relBtn.hidden = !releaseReady;
    if (releaseReady) relBtn.dataset.kit = kit;
  } catch (e) {
    markCache(false);
    $("assess-panel").hidden = true;
    $("release-kit").hidden = true;
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load case: ${e.message}`;
    body.appendChild(p);
  }
}

// ---------- owner assessment + release ----------------------------------------
// Same real pipeline as receive: reviewed payload -> case -> unsigned tx ->
// staff signs with the institution key -> broadcast -> realm receipt -> confirm.
async function reviewAssessment() {
  const kit = $("assess-panel").dataset.kit;
  const picks = [...$("assess-lines").querySelectorAll("select[data-line]")]
    .map((s) => `${s.dataset.line}:${s.value}`);
  if (!kit || !picks.length) {
    $("assess-status").textContent = "Nothing to assess.";
    return;
  }
  const opId = newOpId();
  const assessments = picks.join(";");
  const res = await api("/api/cases", {
    method: "POST",
    body: { kind: "assess", kitId: kit, opId,
            args: { opID: opId, kitID: kit, assessments } },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("assess-status").textContent = b.error || `case refused (${res.status})`;
    return;
  }
  reReviewNeeded = false;
  $("revdiff").hidden = true;
  openReview({
    kind: "assess", opId, kitId: kit, caseId: b.caseId, after: "assess",
    args: { opID: opId, kitID: kit, assessments },
    rows: [
      ["Kit", kit],
      ["Operation id", opId],
      ["Per-line outcome", picks.join("; ")],
      ["Signing account", state.addr || "not signed in"],
      ["Network", state.network || "local dev chain"],
    ],
    attest:
      "This signature attests that you, as the owning institution, " +
      "physically inspected each returned component and record the " +
      "serviceability outcome shown as part of the kit's permanent " +
      "custody record.",
  });
}

async function reviewRelease() {
  const kit = $("release-kit").dataset.kit;
  if (!kit) return;
  const opId = newOpId();
  const res = await api("/api/cases", {
    method: "POST",
    body: { kind: "release", kitId: kit, opId,
            args: { opID: opId, kitID: kit } },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    say(`Release case refused: ${b.error || res.status}`);
    return;
  }
  reReviewNeeded = false;
  $("revdiff").hidden = true;
  openReview({
    kind: "release", opId, kitId: kit, caseId: b.caseId, after: "release",
    args: { opID: opId, kitID: kit },
    rows: [
      ["Kit", kit],
      ["Operation id", opId],
      ["Effect", "kit becomes available for dispatch"],
      ["Signing account", state.addr || "not signed in"],
      ["Network", state.network || "local dev chain"],
    ],
    attest:
      "This signature attests that every required component is held by " +
      "your institution and assessed serviceable, and returns the kit " +
      "to circulation.",
  });
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
  show("queue");
}

async function logout() {
  try {
    const res = await api("/api/session", { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    clearSession();
  } catch {
    if (state.token) say("Could not end the session. Reconnect and retry sign-out.");
  }
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
  for (const t of ["incoming", "outgoing", "exceptions", "audit"]) {
    $(`qtab-${t}`).addEventListener("click", () => {
      state.queueTab = t;
      for (const u of ["incoming", "outgoing", "exceptions", "audit"]) {
        $(`qtab-${u}`).setAttribute("aria-selected", String(u === t));
      }
      renderQueueTab();
    });
  }
  $("assess-review").addEventListener("click", reviewAssessment);
  $("release-kit").addEventListener("click", reviewRelease);
  // Deliberate confirmation: signing stays blocked until the staff member
  // explicitly re-reviews the persisted before/after revision diff.
  $("re-review").addEventListener("click", async () => {
    if (!state.draft?.pendingManifestReview || $("re-review").disabled) return;
    delete state.draft.pendingManifestReview;
    await saveDraft();
    reReviewNeeded = false;
    $("do-sign").disabled = false;
    $("revdiff").hidden = true;
    $("sign-status").textContent = "Re-review confirmed — you may sign.";
    say("Re-review confirmed");
  });
  $("back-draft").addEventListener("click", () => { show("receive"); });
  $("do-sign").addEventListener("click", beginSigning);
  $("mark-broadcast").addEventListener("click", markBroadcast);
  $("relay-btn").addEventListener("click", relaySigned);
  $("check-receipt").addEventListener("click", checkReceipt);
  $("back-sign").addEventListener("click", () => { show("receive"); });
  $("ev-upload").addEventListener("click", uploadEvidence);
  $("ev-retry").addEventListener("click", uploadEvidence);
  $("download-tx").addEventListener("click", () => {
    const blob = new Blob([$("unsigned-tx").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.review?.caseId || state.draft?.caseId || "tx"}-unsigned.json`;
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

  // A shared desk returns to sign-in after logout. Normal entry opens the queue.
  show(location.hash === "#session" && !state.token ? "session" : "queue");
});
