// Durable indexer: replays the realm's deterministic event feed into the
// PostgreSQL projection. Each fetched page is applied together with the
// checkpoint advance and catalogue-outbox rows in ONE transaction, so a
// crash between "read" and "commit" replays deterministically (T-019).
// A new chain epoch, a height regression, or a feed-hash mismatch suspends
// writes and quarantines prior-epoch evidence (T-021).

import { createHash } from "node:crypto";
import type { ChainClient, RealmEvent } from "./chain.ts";
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
     ON CONFLICT (leg_id) DO UPDATE SET status=$8, close_height=$10,
       accepted=$12, missing=$13`,
    [legID, leg.kit, leg.kind, leg.sender, leg.dest, leg.manifestRev ?? 0,
     leg.prev ?? "", leg.status, leg.openHeight ?? 0, leg.closeHeight ?? 0,
     JSON.stringify(leg.qty ?? {}), JSON.stringify(leg.accepted ?? {}),
     JSON.stringify(leg.missing ?? {})],
  );
}

async function refreshKitExceptions(c: Client, chain: ChainClient, kitID: string): Promise<void> {
  const res = (await chain.query(`GetExceptions(${JSON.stringify(kitID)})`)) as any;
  for (const e of (res.exceptions ?? []) as any[]) {
    await c.query(
      `INSERT INTO proj_exceptions (exc_id, kit, leg, line, kind, qty, reason,
         status, open_height, close_height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (exc_id) DO UPDATE SET status=$8, close_height=$10`,
      [e.id, e.kit, e.leg ?? "", e.line, e.kind, e.qty ?? 0, e.reason ?? "",
       e.status, e.height ?? 0, e.closeHeight ?? 0],
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

/** Append a catalogue outbox row when a kit's HELD/AVAILABLE state changed. */
async function outboxIfChanged(
  c: Client, chain: ChainClient, kitID: string, ev: RealmEvent,
): Promise<void> {
  const kit = (await chain.query(`GetKit(${JSON.stringify(kitID)})`)) as any;
  if (kit.error) return;
  const state = kit.available ? "AVAILABLE" : "HELD";
  const last = await c.query(
    `SELECT state FROM outbox WHERE kit_id=$1 ORDER BY seq DESC LIMIT 1`, [kitID]);
  if (last.rows[0]?.state === state) return;
  await c.query(
    `INSERT INTO outbox (kit_id, state, event_seq, height, version, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (kit_id, event_seq, state) DO NOTHING`,
    [kitID, state, ev.seq, ev.height, kit.manifestRev ?? 0,
     JSON.stringify({ owner: kit.owner, digest: kit.manifestDigest })],
  );
}

/**
 * One index cycle. Returns applied event count.
 * Throws IndexerSuspended once writes are suspended; callers should stop.
 */
export class IndexerSuspended extends Error {}

export async function indexOnce(pool: Pool, chain: ChainClient): Promise<number> {
  const status = await chain.status();
  const cp = await readCheckpoint(pool);

  if (cp?.suspended) {
    throw new IndexerSuspended(`indexer suspended: ${cp.suspend_reason}`);
  }

  // Epoch / regression gate (T-021). Never write across an epoch boundary.
  if (cp) {
    const reasons: string[] = [];
    if (cp.network !== status.network) reasons.push(`network ${cp.network} -> ${status.network}`);
    if (cp.epoch !== status.epoch) reasons.push(`epoch ${cp.epoch} -> ${status.epoch}`);
    if (cp.height > status.height) reasons.push(`height regression ${cp.height} -> ${status.height}`);
    if (reasons.length > 0) {
      await inTx(pool, (c) => suspend(c, reasons.join("; "), { cp, status }));
      throw new IndexerSuspended(reasons.join("; "));
    }
  }

  const page = await chain.events(cp?.last_seq ?? 0);
  if (page.events.length === 0) {
    // Still refresh height so the checkpoint tracks chain progress.
    if (cp && status.height !== cp.height) {
      await pool.query(
        `UPDATE checkpoint SET height=$1, updated_at=now() WHERE id=1 AND suspended=false`,
        [status.height]);
    }
    return 0;
  }

  return inTx(pool, async (c) => {
    let hash = cp?.feed_hash ?? "";
    for (const ev of page.events) {
      await c.query(
        `INSERT INTO realm_events (seq,height,kind,kit,leg,line,org,data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (seq) DO NOTHING`,
        [ev.seq, ev.height, ev.kind, ev.kit, ev.leg, ev.line, ev.org, ev.data]);
      if (ev.kit) {
        await refreshKit(c, chain, ev.kit);
        await refreshKitExceptions(c, chain, ev.kit);
        await outboxIfChanged(c, chain, ev.kit, ev);
      }
      if (ev.leg) await refreshLeg(c, chain, ev.leg);
      hash = feedHash(hash, ev);
    }
    await c.query(
      `INSERT INTO checkpoint (id, network, chain_id, realm, epoch, height,
         last_seq, feed_hash, suspended, suspend_reason)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,false,'')
       ON CONFLICT (id) DO UPDATE SET height=$5, last_seq=$6, feed_hash=$7,
         updated_at=now()`,
      [status.network, page.chainId ?? cp?.chain_id ?? "", page.realm ?? cp?.realm ?? "",
       cp?.epoch ?? status.epoch, status.height, page.lastSeq, hash]);
    return page.events.length;
  });
}

/** Daemon loop for `npm run indexer`. */
export async function runIndexer(pool: Pool, chain: ChainClient, pollMs: number): Promise<void> {
  for (;;) {
    try {
      const n = await indexOnce(pool, chain);
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
  await runIndexer(pool, new ChainClient(cfg.rpcUrl, cfg.realm), cfg.pollMs);
}
