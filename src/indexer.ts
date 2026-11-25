// Durable indexer: replays the realm's deterministic event feed into the
// PostgreSQL projection. Each fetched page is applied together with the
// checkpoint advance and catalogue-outbox rows in ONE transaction, so a
// crash between "read" and "commit" replays deterministically (T-019).
// A new chain epoch, a height regression, or a feed-hash mismatch suspends
// writes and quarantines prior-epoch evidence (T-021).

import { createHash } from "node:crypto";
import type { ChainClient, RealmEvent, EventPage } from "./chain.ts";
import { inTx, type Client, type Pool } from "./db.ts";

export interface Checkpoint {
  network: string;
  chain_id: string;
  realm: string;
  epoch: string;
  height: number;
  last_seq: number;
  feed_hash: string;
  suspended: boolean;
  suspend_reason: string;
}

export async function readCheckpoint(pool: Pool): Promise<Checkpoint | null> {
  const r = await pool.query("SELECT * FROM checkpoint WHERE id = 1");
  return (r.rows[0] as Checkpoint | undefined) ?? null;
}

function feedHash(prev: string, ev: RealmEvent): string {
  return createHash("sha256")
    .update(prev + "|" + `${ev.seq}:${ev.height}:${ev.kind}:${ev.kit}:${ev.leg}:${ev.line}:${ev.org}:${ev.data}`)
    .digest("hex");
}

async function suspend(c: Client, reason: string, snapshot: unknown): Promise<void> {
  const cp = (await c.query("SELECT epoch FROM checkpoint WHERE id=1")).rows[0];
  await c.query(
    `UPDATE checkpoint SET suspended=true, suspend_reason=$1, updated_at=now() WHERE id=1`,
    [reason],
  );
  await c.query(
    `INSERT INTO epoch_evidence (epoch, reason, snapshot) VALUES ($1,$2,$3)`,
    [cp?.epoch ?? "unknown", reason, JSON.stringify(snapshot ?? {})],
  );
}

/** Upsert the full public read model for one kit into the projection. */
async function refreshKit(c: Client, chain: ChainClient, kitID: string): Promise<void> {
  const kit = (await chain.query(`GetKit(${JSON.stringify(kitID)})`)) as any;
  if (kit.error) return;
  await c.query(
    `INSERT INTO proj_kits (kit_id, owner, manifest_rev, manifest_digest, active_leg,
       available, hold, needs_assessment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (kit_id) DO UPDATE SET owner=$2, manifest_rev=$3,
       manifest_digest=$4, active_leg=$5, available=$6, hold=$7,
       needs_assessment=$8`,
    [kitID, kit.owner, kit.manifestRev, kit.manifestDigest, kit.activeLeg ?? "",
     kit.available, kit.hold, kit.needsAssessment],
  );
  for (const ln of (kit.lines ?? []) as any[]) {
    await c.query(
      `INSERT INTO proj_lines (kit_id, line_id, issued, held, transit_total, unlocated,
         quarantine, retired, assessment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (kit_id, line_id) DO UPDATE SET issued=$3, held=$4,
         transit_total=$5, unlocated=$6, quarantine=$7, retired=$8, assessment=$9`,
      [kitID, ln.id, ln.issued, JSON.stringify(ln.held ?? {}), ln.inTransit ?? 0,
       ln.unlocated, ln.quarantine, ln.retired, ln.assessment],
    );
  }
}

async function refreshLeg(c: Client, chain: ChainClient, legID: string): Promise<void> {
  if (!legID) return;
  const leg = (await chain.query(`GetLeg(${JSON.stringify(legID)})`)) as any;
  if (leg.error) return;
  await c.query(
    `INSERT INTO proj_legs (leg_id, kit, kind, sender, dest, manifest_rev, prev,
       status, open_height, close_height, qty, accepted, missing)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (leg_id) DO UPDATE SET status=$8, close_height=$10, qty=$11,
       accepted=$12, missing=$13`,
    [legID, leg.kit, leg.kind, leg.sender, leg.dest, leg.manifestRev ?? 0,
     leg.prev ?? "", leg.status, leg.openHeight ?? 0, leg.closeHeight ?? 0,
     JSON.stringify(leg.dispatched ?? leg.qty ?? {}), JSON.stringify(leg.accepted ?? {}),
     JSON.stringify(leg.reportedMissing ?? leg.missing ?? {})],
  );
}

async function refreshKitExceptions(c: Client, chain: ChainClient, kitID: string): Promise<void> {
  const res = (await chain.query(`GetExceptions(${JSON.stringify(kitID)})`)) as any;
  for (const e of (res.exceptions ?? []) as any[]) {
    await c.query(
      `INSERT INTO proj_exceptions (exc_id, kit, leg, line, kind, qty, reason,
         status, open_height, close_height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (exc_id) DO UPDATE SET status=$8, open_height=$9, close_height=$10`,
      [e.id, e.kit, e.leg ?? "", e.line, e.kind, e.qty ?? 0, e.reason ?? "",
       e.status, e.openHeight ?? e.height ?? 0, e.closeHeight ?? 0],
    );
  }
  const claims = (await chain.query(`GetClaims(${JSON.stringify(kitID)})`)) as any;
  for (const cl of (claims.claims ?? []) as any[]) {
    await c.query(
      `INSERT INTO proj_claims (claim_id, kit, line, finder, qty, source_leg,
         status, height, confirm_height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (claim_id) DO UPDATE SET status=$7, confirm_height=$9`,
      [cl.id, cl.kit, cl.line, cl.finder, cl.qty, cl.sourceLeg ?? "",
       cl.status, cl.height ?? 0, cl.confirmHeight ?? 0],
    );
  }
}

/**
 * Project an institution's org record and grant history from the realm so
 * staff sign-in can verify live grants. Called on org-scoped events
 * (org-enroll, role-grant, role-revoke); grant revocation must land in the
 * projection before sessions honour it, so this runs inside the same tx.
 */
async function refreshOrg(c: Client, chain: ChainClient, orgID: string): Promise<void> {
  if (!orgID || orgID === "_registrar") return;
  const res = (await chain.query(`GetOrg(${JSON.stringify(orgID)})`)) as any;
  if (res.error) return;
  await c.query(
    `INSERT INTO proj_orgs (org_id, active, height) VALUES ($1,$2,$3)
     ON CONFLICT (org_id) DO UPDATE SET active=$2`,
    [orgID, res.active, res.enrollHeight ?? 0]);
  for (const g of (res.grants ?? []) as any[]) {
    await c.query(
      `INSERT INTO proj_grants (org_id, addr, role, active, granted, revoked)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, addr, role) DO UPDATE SET active=$4, revoked=$6`,
      [orgID, g.addr, g.role, g.active, g.granted ?? 0, g.revoked ?? 0]);
  }
}

// Availability transitions reduced from the immutable event stream — the
// ONLY realm operations that change Kit.Available. Reading current kit
// state for a historical event would misattribute a later owner release to
// an earlier receipt (provenance). Neutral events (receive, close, assess,
// exceptions, claims) emit no catalogue transition.
const AVAIL_STATES: Record<string, "HELD" | "AVAILABLE"> = {
  "manifest-define": "HELD",
  "dispatch": "HELD",
  "return-start": "HELD",
  "writeoff": "HELD",
  "release": "AVAILABLE",
};

/** Append a catalogue outbox row for an event-attributed state transition. */
async function outboxTransition(
  c: Client, kitID: string, ev: RealmEvent, state: "HELD" | "AVAILABLE",
): Promise<void> {
  const last = await c.query(
    `SELECT state FROM outbox WHERE kit_id=$1 ORDER BY seq DESC LIMIT 1`, [kitID]);
  if (last.rows[0]?.state === state) return; // unchanged — no duplicate update
  await c.query(
    `INSERT INTO outbox (kit_id, state, event_seq, height, version, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (kit_id, event_seq, state) DO NOTHING`,
    [kitID, state, ev.seq, ev.height, 0, "{}"]);
}

/**
 * One index cycle. Returns applied event count.
 * Throws IndexerSuspended once writes are suspended; callers should stop.
 */
export class IndexerSuspended extends Error {}

// Epoch / regression gate (T-021). Never write across an epoch boundary.
// Suspends the checkpoint and quarantines evidence when the observed chain
// identity disagrees with the recorded one.
export async function epochGuard(
  pool: Pool, cp: Checkpoint | null, status: { network: string; epoch: string; height: number },
): Promise<void> {
  if (cp?.suspended) {
    throw new IndexerSuspended(`indexer suspended: ${cp.suspend_reason}`);
  }
  if (!cp) return;
  const reasons: string[] = [];
  if (cp.network !== status.network) reasons.push(`network ${cp.network} -> ${status.network}`);
  if (cp.epoch !== status.epoch) reasons.push(`epoch ${cp.epoch} -> ${status.epoch}`);
  if (cp.height > status.height) reasons.push(`height regression ${cp.height} -> ${status.height}`);
  if (reasons.length > 0) {
    await inTx(pool, (c) => suspend(c, reasons.join("; "), { cp, status }));
    throw new IndexerSuspended(reasons.join("; "));
  }
}

/**
 * Apply one fetched event page inside an open transaction: realm_events
 * provenance, projection refreshes, outbox transitions and the checkpoint
 * advance all commit or roll back together. Returns the applied count and
 * the new contiguous sequence head.
 */
export async function indexPage(
  c: Client, chain: ChainClient, page: EventPage,
  status: { network: string; epoch: string; height: number },
): Promise<{ applied: number; lastSeq: number }> {
  // Serialize concurrent index workers on the checkpoint row.
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('kittransit-indexer'))`);
  const locked = (await c.query(
    `SELECT * FROM checkpoint WHERE id=1 FOR UPDATE`)).rows[0] as any;
  let lastSeq = Number(locked?.last_seq ?? 0);
  let hash = locked?.feed_hash ?? "";
  let applied = 0;
  for (const ev of page.events) {
    if (ev.seq <= lastSeq) continue; // already applied — overlap replay
    if (lastSeq !== 0 && ev.seq !== lastSeq + 1) break; // gap: never skip ahead
    await c.query(
      `INSERT INTO realm_events (seq,height,kind,kit,leg,line,org,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (seq) DO NOTHING`,
      [ev.seq, ev.height, ev.kind, ev.kit, ev.leg, ev.line, ev.org, ev.data]);
    if (ev.kit) {
      await refreshKit(c, chain, ev.kit);
      await refreshKitExceptions(c, chain, ev.kit);
      const st = AVAIL_STATES[ev.kind];
      if (st) await outboxTransition(c, ev.kit, ev, st);
    }
    if (ev.leg) await refreshLeg(c, chain, ev.leg);
    if (ev.org) await refreshOrg(c, chain, ev.org);
    hash = feedHash(hash, ev);
    lastSeq = ev.seq;
    applied++;
  }
  // Advance ONLY to the last contiguous applied seq — GetEvents' lastSeq
  // is the global feed head, which page limits must not skip to.
  await c.query(
    `INSERT INTO checkpoint (id, network, chain_id, realm, epoch, height,
       last_seq, feed_hash, suspended, suspend_reason)
     VALUES (1,$1,$2,$3,$4,$5,$6,$7,false,'')
     ON CONFLICT (id) DO UPDATE SET height=$5, last_seq=$6, feed_hash=$7,
       updated_at=now()`,
    [status.network, page.chainId ?? locked?.chain_id ?? "",
     page.realm ?? locked?.realm ?? "",
     locked?.epoch ?? status.epoch, status.height, lastSeq, hash]);
  return { applied, lastSeq };
}

export async function indexOnce(pool: Pool, chain: ChainClient, limit = 200): Promise<number> {
  const status = await chain.status();
  const cp = await readCheckpoint(pool);
  await epochGuard(pool, cp, status);

  const page = await chain.events(cp?.last_seq ?? 0, limit);
  if (page.events.length === 0) {
    // Still refresh height so the checkpoint tracks chain progress.
    if (cp && status.height !== cp.height) {
      await pool.query(
        `UPDATE checkpoint SET height=$1, updated_at=now() WHERE id=1 AND suspended=false`,
        [status.height]);
    }
    return 0;
  }

  const { applied } = await inTx(pool, (c) => indexPage(c, chain, page, status));
  return applied;
}

/** Daemon loop for `npm run indexer`. */
export async function runIndexer(
  pool: Pool, chain: ChainClient, pollMs: number, limit = 200,
): Promise<void> {
  for (;;) {
    try {
      const n = await indexOnce(pool, chain, limit);
      if (n > 0) process.stdout.write(`indexed ${n} events\n`);
    } catch (err) {
      if (err instanceof IndexerSuspended) {
        process.stderr.write(`${err.message} — operator action required\n`);
        return;
      }
      process.stderr.write(`index error: ${(err as Error).message}\n`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// CLI entry: node src/indexer.ts --daemon
if (process.argv[1]?.endsWith("indexer.ts") && process.argv.includes("--daemon")) {
  const { loadConfig } = await import("./config.ts");
  const { makePool, migrate } = await import("./db.ts");
  const { ChainClient } = await import("./chain.ts");
  const cfg = loadConfig();
  const pool = makePool(cfg.databaseUrl);
  await migrate(pool);
  await runIndexer(pool, new ChainClient(cfg.rpcUrl, cfg.realm), cfg.pollMs, cfg.pageLimit);
}
