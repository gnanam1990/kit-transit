// Kit Transit staff API. Session-scoped staff routes, the public read-only
// realm reader (independent of the SQL projection), the private evidence
// proxy, the catalogue CSV bridge and ops/audit recovery endpoints.
// The API never signs and never holds institution keys.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import type { Pool } from "./db.ts";
import type { ChainClient } from "./chain.ts";
import {
  createChallenge, redeemChallenge, getSession, revokeSession, AuthError,
  type Session,
} from "./sessions.ts";
import { storeEvidence, fetchEvidence, EvidenceError } from "./evidence.ts";
import { parseCsv, importCsv, exportCsv, partnerCsv, drainOutbox } from "./catalogue.ts";
import { exportCase, lookupOperation, compareProjectionToRealm } from "./audit.ts";
import { caseDigest } from "./digest.ts";
import { caseTx, caseSigndoc } from "./txbuild.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const REALM_FN: Record<string, string> = {
  dispatch: "Dispatch",
  receive: "ReceiveDelta",
  resolve: "ResolveException",
  "return": "StartReturn",
  assess: "AssessReturn",
  release: "ReleaseKit",
  close: "CloseLeg",
  cancel: "CancelLeg",
  found: "ReportFound",
  confirm: "ConfirmRecovery",
  reject: "RejectRecovery",
  writeoff: "WriteOffUnit",
};

export interface ApiDeps {
  cfg: Config;
  pool: Pool;
  chain: ChainClient;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function sessionOf(
  req: IncomingMessage, pool: Pool,
): Promise<Session | null> {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) return null;
  return getSession(pool, h.slice(7));
}

// Allowlisted signing payload: only chain-call fields the realm expects —
// private fields (notes, patron data, image refs) never enter it.
function buildPayload(kind: string, args: Record<string, unknown>): Record<string, unknown> {
  const fn = REALM_FN[kind];
  if (!fn) throw new Error(`unknown case kind ${kind}`);
  const allow: Record<string, string[]> = {
    Dispatch: ["opID", "kitID", "destOrg", "expectedRev", "prevLeg", "qtys"],
    ReceiveDelta: ["opID", "legID", "accepted", "conds", "missing", "reason"],
    ResolveException: ["opID", "excID", "disposition", "reason"],
    StartReturn: ["opID", "kitID", "qtys"],
    AssessReturn: ["opID", "kitID", "assessments"],
    ReleaseKit: ["opID", "kitID"],
    CloseLeg: ["opID", "legID"],
    CancelLeg: ["opID", "legID"],
    ReportFound: ["opID", "kitID", "lineID", "qty", "sourceLeg"],
    ConfirmRecovery: ["opID", "claimID"],
    RejectRecovery: ["opID", "claimID", "reason"],
    WriteOffUnit: ["opID", "kitID", "lineID", "qty", "reason"],
  };
  const out: Record<string, unknown> = { func: fn };
  for (const k of allow[fn] ?? []) {
    if (args[k] !== undefined) out[k] = args[k];
  }
  return out;
}

const execFileP = promisify(execFile);

// Transmit a staff-signed tx document through the configured gnokey binary.
// The relay only broadcasts what staff signed — it never produces signatures.
// Runs with an isolated empty -home so no real keybase is touched.
async function relaySigned(cfg: Config, signedDoc: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kt-relay-"));
  try {
    const file = join(dir, "signed.json");
    await writeFile(file, JSON.stringify(signedDoc));
    const remote = cfg.rpcUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const { stdout, stderr } = await execFileP(cfg.gnokeyBin,
      ["broadcast", "-remote", remote, "-home", join(dir, "home"), file],
      { timeout: 30_000 });
    const out = `${stdout}\n${stderr}`;
    const h = out.match(/TX HASH:\s*(\S+)/);
    if (!h) {
      throw new Error(`gnokey broadcast returned no tx hash: ${out.trim()}`);
    }
    return h[1]!;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};

export function createApi({ cfg, pool, chain }: ApiDeps) {
  const webRoot = resolve(cfg.webDir);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // ---------- public realm reader (no session; public fields only) ----
      if (path === "/api/reader/kit" && method === "GET") {
        const kit = url.searchParams.get("id") ?? "";
        json(res, 200, await chain.query(`GetKit(${JSON.stringify(kit)})`));
        return;
      }
      if (path === "/api/reader/leg" && method === "GET") {
        const leg = url.searchParams.get("id") ?? "";
        json(res, 200, await chain.query(`GetLeg(${JSON.stringify(leg)})`));
        return;
      }
      if (path === "/api/reader/op" && method === "GET") {
        const org = url.searchParams.get("org") ?? "";
        const op = url.searchParams.get("op") ?? "";
        json(res, 200, await chain.query(
          `GetOp(${JSON.stringify(org)},${JSON.stringify(op)})`));
        return;
      }
      if (path === "/api/reader/exceptions" && method === "GET") {
        const kit = url.searchParams.get("id") ?? "";
        json(res, 200, await chain.query(`GetExceptions(${JSON.stringify(kit)})`));
        return;
      }
      if (path === "/api/reader/timeline" && method === "GET") {
        const kit = url.searchParams.get("kit");
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!kit || !Number.isSafeInteger(after) || after < 0) {
          json(res, 400, { error: "Kit and a nonnegative integer cursor required" }); return;
        }
        const page = await chain.events(after, 100);
        const cursor = page.events.at(-1)?.seq ?? after;
        json(res, 200, {
          events: page.events.filter(event => event.kit === kit),
          cursor, more: cursor > after && cursor < page.lastSeq,
        });
        return;
      }
      // Immutable manifest revision — used to show the real before/after
      // diff when a manifest changed between draft and sign-off.
      if (path === "/api/reader/manifest" && method === "GET") {
        const kit = url.searchParams.get("kit") ?? "";
        const rev = Number(url.searchParams.get("rev") ?? "0");
        if (!Number.isInteger(rev) || rev <= 0) {
          json(res, 400, { error: "rev must be a positive integer" }); return;
        }
        json(res, 200, await chain.query(
          `GetManifest(${JSON.stringify(kit)},${rev})`));
        return;
      }

      // ---------- sessions ------------------------------------------------
      // POST /api/session/challenge {addr, org, deviceId} issues a one-use,
      // short-lived challenge bound to network/realm/org/device. Refused
      // outright when the address has no active grant — a bare public
      // address gets nothing to sign.
      if (path === "/api/session/challenge" && method === "POST") {
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        if (typeof b.addr !== "string" || typeof b.org !== "string" ||
            typeof b.deviceId !== "string") {
          json(res, 400, { error: "addr, org, deviceId required" });
          return;
        }
        const ch = await createChallenge(pool, {
          addr: b.addr, org: b.org, deviceId: b.deviceId,
          network: cfg.network, realm: cfg.realm,
        });
        if (!ch) { json(res, 403, { error: "no active grant for addr in org" }); return; }
        json(res, 200, ch);
        return;
      }
      // POST /api/session {challengeId, pubkey, signature} redeems a signed
      // challenge. A session is issued only after the ed25519 signature
      // verifies, sha256(pubkey)[:20] derives the claimed address, and the
      // grant is still active.
      if (path === "/api/session" && method === "POST") {
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        try {
          const s = await redeemChallenge(pool, String(b.challengeId ?? ""),
            String(b.pubkey ?? ""), String(b.signature ?? ""), cfg.sessionTtlSec);
          json(res, 201, { token: s.token, org: s.org_id, addr: s.addr });
        } catch (e) {
          if (e instanceof AuthError) {
            json(res, 403, { error: e.message });
          } else { throw e; }
        }
        return;
      }
      if (path === "/api/session" && method === "DELETE") {
        const s = await sessionOf(req, pool);
        if (s) await revokeSession(pool, s.token);
        json(res, 204, {});
        return;
      }

      // ---------- staff projection reads (session required) ---------------
      if (path === "/api/kits" && method === "GET") {
        if (!(await sessionOf(req, pool))) { json(res, 401, { error: "session required" }); return; }
        const rows = await pool.query(
          `SELECT kit_id, owner, manifest_rev, available, hold, needs_assessment
           FROM proj_kits ORDER BY kit_id`);
        json(res, 200, { kits: rows.rows });
        return;
      }
      let m: RegExpMatchArray | null;
      if ((m = path.match(/^\/api\/kits\/([^/]+)$/)) && method === "GET") {
        if (!(await sessionOf(req, pool))) { json(res, 401, { error: "session required" }); return; }
        const kit = await pool.query(`SELECT * FROM proj_kits WHERE kit_id=$1`, [m[1]]);
        if ((kit.rowCount ?? 0) === 0) { json(res, 404, { error: "unknown kit" }); return; }
        const lines = await pool.query(
          `SELECT * FROM proj_lines WHERE kit_id=$1 ORDER BY line_id`, [m[1]]);
        const legs = await pool.query(
          `SELECT * FROM proj_legs WHERE kit=$1 ORDER BY leg_id`, [m[1]]);
        const excs = await pool.query(
          `SELECT * FROM proj_exceptions WHERE kit=$1 ORDER BY exc_id`, [m[1]]);
        json(res, 200, { kit: kit.rows[0], lines: lines.rows, legs: legs.rows, exceptions: excs.rows });
        return;
      }
      // Institution-specific work queue (UI-SPEC): incoming/outgoing open
      // legs, open exceptions on kits the org is party to, owner kits
      // needing inspection, and the org-scoped audit tail. Labels come
      // only from chain-derived projection state — never local scans.
      if (path === "/api/queue" && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const org = s.org_id;
        const heights = await pool.query(
          `SELECT kit, MAX(height) AS h FROM realm_events GROUP BY kit`);
        const kitH = new Map(heights.rows.map((r: any) => [r.kit, Number(r.h)]));
        const legRow = (l: any, dir: "in" | "out") => {
          const outstanding = Object.entries(l.qty ?? {})
            .map(([line, q]: [string, any]) => ({
              line, qty: Number(q) - Number(l.accepted?.[line] ?? 0) - Number(l.missing?.[line] ?? 0),
            }))
            .filter((o) => o.qty > 0)
            .sort((a, b) => a.line.localeCompare(b.line));
          return {
            row: "leg", legId: l.leg_id, kit: l.kit,
            partner: dir === "in" ? l.sender : l.dest, direction: dir,
            expected: Object.values(l.qty ?? {}).reduce<number>((a, b) => a + Number(b), 0),
            received: Object.values(l.accepted ?? {}).reduce<number>((a, b) => a + Number(b), 0),
            outstanding,
            oldestOutstanding: outstanding[0]?.line ?? null,
            lastHeight: Math.max(Number(l.open_height), Number(l.close_height), kitH.get(l.kit) ?? 0),
            label: "pending movement",
          };
        };
        const legsIn = await pool.query(
          `SELECT * FROM proj_legs WHERE dest=$1 AND status='open' ORDER BY open_height`, [org]);
        const legsOut = await pool.query(
          `SELECT * FROM proj_legs WHERE sender=$1 AND status='open' ORDER BY open_height`, [org]);
        const inspect = await pool.query(
          `SELECT k.kit_id, k.manifest_rev FROM proj_kits k
           WHERE k.owner=$1 AND k.needs_assessment ORDER BY k.kit_id`, [org]);
        const excs = await pool.query(
          `SELECT e.*, reporter.org AS raised_by
           FROM proj_exceptions e
           LEFT JOIN LATERAL (
             SELECT min(org) AS org FROM realm_events v
             WHERE v.kind='exception' AND v.kit=e.kit AND v.leg=e.leg AND v.line=e.line
               AND v.height=e.open_height AND split_part(v.data,';',1)='kind=' || e.kind
             HAVING count(DISTINCT org)=1
           ) reporter ON true
           WHERE e.status='open' AND (
             EXISTS (SELECT 1 FROM proj_kits k WHERE k.kit_id=e.kit AND k.owner=$1)
             OR EXISTS (SELECT 1 FROM proj_legs l
                        WHERE l.kit=e.kit AND (l.sender=$1 OR l.dest=$1)))
           ORDER BY e.open_height`, [org]);
        const audit = await pool.query(
          `SELECT seq, height, kind, kit, leg, line, org, data FROM realm_events
           WHERE org=$1 OR kit IN (
             SELECT kit_id FROM proj_kits WHERE owner=$1
             UNION SELECT kit FROM proj_legs WHERE sender=$1 OR dest=$1)
           ORDER BY seq DESC LIMIT 30`, [org]);
        const incoming = [
          ...legsIn.rows.map((l: any) => legRow(l, "in")),
          ...inspect.rows.map((k: any) => ({
            row: "inspection", kit: k.kit_id, partner: "returned to owner",
            direction: "in", expected: null, received: null, outstanding: [],
            oldestOutstanding: null,
            lastHeight: kitH.get(k.kit_id) ?? 0,
            label: "needs inspection",
          })),
        ];
        const outgoing = legsOut.rows.map((l: any) => legRow(l, "out"));
        const exceptions = excs.rows.map((e: any) => ({
          excId: e.exc_id, kit: e.kit, leg: e.leg, line: e.line,
          kind: e.kind, qty: Number(e.qty), reason: e.reason, by: e.raised_by,
          lastHeight: Number(e.open_height),
          label: e.kind === "missing" ? "missing"
               : e.kind === "damaged" ? "damaged" : e.kind,
        }));
        json(res, 200, {
          org,
          counts: {
            incoming: incoming.length, outgoing: outgoing.length,
            exceptions: exceptions.length, audit: audit.rows.length,
          },
          incoming, outgoing, exceptions,
          audit: audit.rows.map((r: any) => ({
            seq: Number(r.seq), height: Number(r.height), kind: r.kind,
            kit: r.kit, leg: r.leg, line: r.line, org: r.org, data: r.data,
          })),
        });
        return;
      }

      // ---------- cases: distinct draft->signature->broadcast->confirm ----
      if (path === "/api/cases" && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const rows = await pool.query(
          `SELECT case_id, kind, kit_id, op_id, state, txhash, updated_at
           FROM cases WHERE org_id=$1 ORDER BY updated_at DESC LIMIT 100`,
          [s.org_id]);
        json(res, 200, { cases: rows.rows });
        return;
      }
      if (path === "/api/cases" && method === "POST") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        if (typeof b.kind !== "string" || typeof b.kitId !== "string" ||
            typeof b.opId !== "string" || typeof b.args !== "object" || !b.args) {
          json(res, 400, { error: "kind, kitId, opId, args required" }); return;
        }
        let payload: Record<string, unknown>;
        try { payload = buildPayload(b.kind, b.args); }
        catch (e) { json(res, 400, { error: (e as Error).message }); return; }
        const caseId = `case-${randomBytes(8).toString("hex")}`;
        const nonce = randomBytes(12).toString("hex");
        await pool.query(
          `INSERT INTO cases (case_id, org_id, kind, kit_id, op_id, payload, nonce, signer)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [caseId, s.org_id, b.kind, b.kitId, b.opId,
           JSON.stringify(payload), nonce, s.addr]);
        // The payload is bound to nonce + signer + chain + operation.
        json(res, 201, {
          caseId, nonce, state: "draft", payload,
          bound: { signer: s.addr, org: s.org_id, realm: chain.realmPath() },
        });
        return;
      }
      if ((m = path.match(/^\/api\/cases\/([^/]+)\/transition$/)) && method === "POST") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        const c = await pool.query(`SELECT * FROM cases WHERE case_id=$1`, [m[1]]);
        const kase = c.rows[0] as any;
        if (!kase || kase.org_id !== s.org_id) { json(res, 404, { error: "unknown case" }); return; }
        const to = String(b.state ?? "");
        // "confirmed" is deliberately absent: only /confirm can move a case
        // there, and only on a verified matching chain receipt.
        const legal: Record<string, string[]> = {
          draft: ["signature-request"],
          "signature-request": ["broadcast", "draft", "failed"],
          broadcast: ["unknown", "failed"],
          unknown: ["broadcast", "failed"],
          confirmed: [], failed: [],
        };
        if (!(legal[kase.state] ?? []).includes(to)) {
          json(res, 409, { error: `illegal transition ${kase.state} -> ${to}` }); return;
        }
        await pool.query(
          `UPDATE cases SET state=$2, txhash=COALESCE($3,txhash), updated_at=now() WHERE case_id=$1`,
          [m[1], to, typeof b.txhash === "string" ? b.txhash : null]);
        json(res, 200, { caseId: m[1], state: to });
        return;
      }
      if ((m = path.match(/^\/api\/cases\/([^/]+)\/confirm$/)) && method === "POST") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const c = await pool.query(`SELECT * FROM cases WHERE case_id=$1`, [m[1]]);
        const kase = c.rows[0] as any;
        if (!kase || kase.org_id !== s.org_id) { json(res, 404, { error: "unknown case" }); return; }
        // Confirmation is the realm receipt, never a transport response —
        // and only a receipt whose op digest matches the reviewed payload.
        const op = await lookupOperation(pool, chain, kase.org_id, kase.op_id) as any;
        if (op.status === "confirmed") {
          const payload = typeof kase.payload === "string"
            ? JSON.parse(kase.payload) : kase.payload;
          const expected = caseDigest(kase, cfg.network, chain.realmPath());
          const identityOk =
            op.org === kase.org_id && op.op === kase.op_id &&
            op.kind === payload.func && op.signer === kase.signer &&
            op.digest === expected;
          if (!identityOk) {
            json(res, 409, {
              error: "chain receipt does not match the reviewed operation",
              expected: { kind: payload.func, digest: expected },
              observed: { kind: op.kind, digest: op.digest, signer: op.signer },
            });
            return;
          }
          // Conditional expected-state guard: only broadcast/unknown cases
          // may confirm; the update is a no-op otherwise (idempotent).
          const up = await pool.query(
            `UPDATE cases SET state='confirmed', receipt=$2, updated_at=now()
             WHERE case_id=$1 AND state IN ('broadcast','unknown')`,
            [m[1], JSON.stringify(op)]);
          if ((up.rowCount ?? 0) === 0) {
            json(res, 409, {
              error: `case is ${kase.state}; only broadcast or unknown may confirm`,
            });
            return;
          }
          json(res, 200, { state: "confirmed", receipt: op });
        } else {
          if (kase.state === "broadcast") {
            await pool.query(
              `UPDATE cases SET state='unknown', updated_at=now() WHERE case_id=$1`, [m[1]]);
          }
          json(res, 200, { state: "unknown" });
        }
        return;
      }
      if ((m = path.match(/^\/api\/cases\/([^/]+)$/)) && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const c = await pool.query(
          `SELECT case_id, org_id, kind, kit_id, op_id, state, nonce, txhash, receipt
           FROM cases WHERE case_id=$1`, [m[1]]);
        const kase = c.rows[0] as any;
        if (!kase || kase.org_id !== s.org_id) { json(res, 404, { error: "unknown case" }); return; }
        json(res, 200, kase);
        return;
      }
      // GET /api/cases/:id/signable — the reviewed payload rendered as a real
      // unsigned Gno tx plus the canonical gnokey signdoc. Staff signs it
      // offline with their own key; this API never signs or holds keys.
      if ((m = path.match(/^\/api\/cases\/([^/]+)\/signable$/)) && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const c = await pool.query(`SELECT * FROM cases WHERE case_id=$1`, [m[1]]);
        const kase = c.rows[0] as any;
        if (!kase || kase.org_id !== s.org_id) { json(res, 404, { error: "unknown case" }); return; }
        const payload = typeof kase.payload === "string"
          ? JSON.parse(kase.payload) : kase.payload;
        let chainId = cfg.network;
        try { chainId = (await chain.status()).network || chainId; } catch { /* offline cfg */ }
        json(res, 200, {
          caseId: m[1], chainId,
          tx: caseTx({ realm: chain.realmPath(), caller: kase.signer, payload }),
          signdoc: caseSigndoc({
            chainId, realm: chain.realmPath(), caller: kase.signer, payload,
          }),
        });
        return;
      }
      // POST /api/cases/:id/broadcast — one of two real paths:
      //   {txhash}    staff broadcast the signed tx with an external wallet /
      //               gnokey; the hash is recorded and /confirm verifies the
      //               chain receipt before the case may confirm.
      //   {signedDoc} relay the staff-signed tx through the configured local
      //               gnokey (KIT_GNOKEY_BIN). The relay only transmits what
      //               staff signed; it never signs or holds keys.
      if ((m = path.match(/^\/api\/cases\/([^/]+)\/broadcast$/)) && method === "POST") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        const c = await pool.query(`SELECT * FROM cases WHERE case_id=$1`, [m[1]]);
        const kase = c.rows[0] as any;
        if (!kase || kase.org_id !== s.org_id) { json(res, 404, { error: "unknown case" }); return; }
        if (!["signature-request", "broadcast", "unknown"].includes(kase.state)) {
          json(res, 409, {
            error: `case is ${kase.state}; move it to signature-request first`,
          });
          return;
        }
        let txhash = typeof b.txhash === "string" && b.txhash ? b.txhash : "";
        if (!txhash && b.signedDoc && typeof b.signedDoc === "object") {
          if (!cfg.gnokeyBin) {
            json(res, 400, {
              error: "no relay configured (KIT_GNOKEY_BIN); broadcast with " +
                "gnokey and POST {txhash}",
            });
            return;
          }
          try {
            txhash = await relaySigned(cfg, b.signedDoc);
          } catch (e) {
            json(res, 502, { error: `relay failed: ${(e as Error).message}` });
            return;
          }
        }
        if (!txhash) { json(res, 400, { error: "txhash or signedDoc required" }); return; }
        await pool.query(
          `UPDATE cases SET state='broadcast', txhash=$2, updated_at=now()
           WHERE case_id=$1`, [m[1], txhash]);
        json(res, 200, { caseId: m[1], state: "broadcast", txhash });
        return;
      }

      // ---------- private evidence proxy ----------------------------------
      if (path === "/api/evidence" && method === "POST") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const caseId = url.searchParams.get("case") ?? "";
        if (!caseId) { json(res, 400, { error: "case id required" }); return; }
        const buf = await readBody(req);
        const stored = await storeEvidence(pool, cfg.evidenceDir, s, caseId, buf);
        json(res, 201, stored);
        return;
      }
      if ((m = path.match(/^\/api\/evidence\/([^/]+)$/)) && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const ev = await fetchEvidence(pool, cfg.evidenceDir, s, m[1]!);
        res.writeHead(200, {
          "content-type": ev.meta.mime,
          "content-length": ev.body.length,
          "cache-control": "private, no-store",
        });
        res.end(ev.body);
        return;
      }

      // ---------- catalogue CSV bridge ------------------------------------
      if (path === "/api/catalogue/import" && method === "POST") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const rows = parseCsv((await readBody(req)).toString());
        // Catalogue state is branch-scoped: a desk may only write rows for
        // its own institution's branch.
        const foreign = rows.filter((r) => r.branch !== s.org_id);
        if (foreign.length > 0) {
          json(res, 403, {
            error: `import contains ${foreign.length} row(s) for other branches`,
            branches: [...new Set(foreign.map((r) => r.branch))],
          });
          return;
        }
        json(res, 200, await importCsv(pool, rows));
        return;
      }
      if (path === "/api/catalogue/export" && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const csv = await exportCsv(pool);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
        res.end(csv);
        return;
      }
      // Partner file interchange: the caller's own branch state in the
      // agreed re-importable schema.
      if (path === "/api/catalogue/partner.csv" && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const csv = await partnerCsv(pool, s.org_id);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
        res.end(csv);
        return;
      }
      if (path === "/api/catalogue/drain" && method === "POST") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        // Branch is always the caller's org — no cross-branch drains.
        json(res, 200, await drainOutbox(pool, s.org_id));
        return;
      }

      // ---------- ops / audit ---------------------------------------------
      if ((m = path.match(/^\/api\/audit\/export\/([^/]+)$/)) && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        json(res, 200, await exportCase(pool, m[1]!));
        return;
      }
      if (path === "/api/ops/lookup" && method === "GET") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        json(res, 200, await lookupOperation(
          pool, chain, url.searchParams.get("org") ?? "", url.searchParams.get("op") ?? ""));
        return;
      }
      if ((m = path.match(/^\/api\/ops\/reindex\/([^/]+)$/)) && method === "POST") {
        const s = await sessionOf(req, pool);
        if (!s) { json(res, 401, { error: "session required" }); return; }
        const diffs = await compareProjectionToRealm(pool, chain, m[1]!);
        json(res, 200, { kit: m[1], diffs });
        return;
      }
      if (path === "/api/health" && method === "GET") {
        const cp = await pool.query(`SELECT * FROM checkpoint WHERE id=1`);
        json(res, 200, { ok: true, checkpoint: cp.rows[0] ?? null });
        return;
      }

      // ---------- static staff desk ---------------------------------------
      if (!path.startsWith("/api/") && method === "GET") {
        const rel = path === "/" ? "index.html" : path.slice(1);
        const file = resolve(webRoot, rel);
        if (!file.startsWith(webRoot + sep) || !existsSync(file) || !statSync(file).isFile()) {
          json(res, 404, { error: "not found" });
          return;
        }
        res.writeHead(200, {
          "content-type": STATIC_MIME[extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(readFileSync(file));
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof EvidenceError) {
        const code = err.code === "denied" ? 403 : err.code === "missing" ? 404 : 400;
        json(res, code, { error: err.message });
        return;
      }
      json(res, 500, { error: (err as Error).message });
    }
  });
}

// CLI entry: node src/api.ts
if (process.argv[1]?.endsWith("api.ts")) {
  const { loadConfig } = await import("./config.ts");
  const { makePool, migrate } = await import("./db.ts");
  const { ChainClient } = await import("./chain.ts");
  const cfg = loadConfig();
  const pool = makePool(cfg.databaseUrl);
  await migrate(pool);
  const server = createApi({ cfg, pool, chain: new ChainClient(cfg.rpcUrl, cfg.realm) });
  server.listen(cfg.apiPort, () => {
    console.log(`kit-transit api on :${cfg.apiPort}`);
  });
}
