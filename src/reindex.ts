// Deterministic rebuild of the projection from realm events (M09/T-025).
//
// Safety properties:
//   * The whole rebuild runs in ONE PostgreSQL transaction — a partial
//     failure (chain unreachable mid-feed, a query error, a kill) rolls
//     back completely: no half-empty projection, no lost checkpoint.
//   * The catalogue outbox is NEVER truncated. Its rows are delivery
//     history (sent/conflict/manual_review); the deterministic replay
//     re-inserts identical transition rows idempotently via ON CONFLICT,
//     preserving every row's delivery status and attempts.
//   * realm_events provenance is likewise kept and re-populated
//     idempotently.
//   * Verification derives the realm's kit inventory from the immutable
//     GetEvents feed itself, so it still reports divergence when the
//     projection is empty while the realm has real kits.
//
// Usage:
//   node src/reindex.ts            # rebuild projection rows from seq 0
//   node src/reindex.ts --verify   # report projection-vs-realm diffs only

import { loadConfig } from "./config.ts";
import { makePool, migrate, inTx, type Pool } from "./db.ts";
import type { ChainClient, EventPage } from "./chain.ts";
import {
  indexPage, epochGuard, readCheckpoint, IndexerSuspended,
} from "./indexer.ts";
import { compareProjectionToRealm } from "./audit.ts";

/**
 * Rebuild all projection tables inside a single transaction.
 * Returns the number of feed events applied. Throws (rolling everything
 * back) on suspension, epoch mismatch or any mid-rebuild failure.
 */
export async function rebuildProjection(
  pool: Pool, chain: ChainClient, limit = 200,
): Promise<number> {
  const cp = await readCheckpoint(pool);
  const status = await chain.status();
  await epochGuard(pool, cp, status); // suspends + throws on epoch divergence

  return inTx(pool, async (c) => {
    // Hold the same lock as the live indexer for the whole rebuild, so no
    // worker can interleave a page into the staged projection.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('kittransit-indexer'))`);
    const locked = (await c.query(
      `SELECT * FROM checkpoint WHERE id=1 FOR UPDATE`)).rows[0] as any;
    if (locked?.suspended) {
      throw new IndexerSuspended(
        `indexer suspended: ${locked.suspend_reason}`);
    }

    // Stage the rebuild: projection rows are re-derived; outbox delivery
    // history and realm_events provenance are preserved, never cleared.
    await c.query(
      `TRUNCATE proj_kits, proj_lines, proj_legs, proj_exceptions,
                proj_claims, proj_orgs, proj_grants RESTART IDENTITY`);
    await c.query(
      `INSERT INTO checkpoint (id, network, chain_id, realm, epoch, height,
         last_seq, feed_hash, suspended, suspend_reason)
       VALUES (1,$1,$2,$3,$4,$5,0,'',false,'')
       ON CONFLICT (id) DO UPDATE SET last_seq=0, feed_hash='',
         height=$5, updated_at=now()`,
      [status.network, locked?.chain_id ?? "", locked?.realm ?? "",
       locked?.epoch ?? status.epoch, status.height]);

    let after = 0;
    let total = 0;
    for (;;) {
      const page = await chain.events(after, limit);
      if (page.events.length === 0) break;
      const r = await indexPage(c, chain, page, status);
      total += r.applied;
      if (r.applied === 0) break; // gap: rebuild to the contiguous prefix
      after = r.lastSeq;
    }
    return total;
  });
}

/**
 * The realm's kit inventory derived from the immutable event feed —
 * independent of whatever the projection currently holds.
 */
export async function realmKitInventory(
  chain: ChainClient, limit = 200,
): Promise<Set<string>> {
  const kits = new Set<string>();
  let after = 0;
  for (;;) {
    const page: EventPage = await chain.events(after, limit);
    for (const ev of page.events) if (ev.kit) kits.add(ev.kit);
    if (page.events.length === 0) break;
    const last = page.events[page.events.length - 1]!.seq;
    if (last >= page.lastSeq) break; // reached the feed head
    after = last;
  }
  return kits;
}

export interface KitDivergence {
  kit: string;
  diffs: { field: string; projection: unknown; realm: unknown }[];
}

/**
 * Verify the projection against the realm: every kit in the realm's
 * inventory must match its projection rows (owner, manifest rev,
 * availability, per-line held/transit/unlocated/quarantine/retired/
 * assessment), and no projection kit may be absent from the feed.
 * An empty projection against real realm kits reports every kit missing.
 */
export async function verifyProjection(
  pool: Pool, chain: ChainClient, limit = 200,
): Promise<KitDivergence[]> {
  const realmKits = await realmKitInventory(chain, limit);
  const projRows = await pool.query(`SELECT kit_id FROM proj_kits ORDER BY kit_id`);
  const projKits = new Set((projRows.rows as { kit_id: string }[]).map((r) => r.kit_id));

  const out: KitDivergence[] = [];
  for (const kit of realmKits) {
    const diffs = await compareProjectionToRealm(pool, chain, kit);
    if (diffs.length > 0) out.push({ kit, diffs });
  }
  for (const kit of projKits) {
    if (!realmKits.has(kit)) {
      out.push({ kit, diffs: [{ field: "kit", projection: "present", realm: "absent from feed" }] });
    }
  }
  return out;
}

// CLI entry: node src/reindex.ts [--verify]
if (process.argv[1]?.endsWith("reindex.ts")) {
  const verifyOnly = process.argv.includes("--verify");
  const cfg = loadConfig();
  const pool = makePool(cfg.databaseUrl);
  await migrate(pool);
  const { ChainClient } = await import("./chain.ts");
  const chain = new ChainClient(cfg.rpcUrl, cfg.realm);
  try {
    if (!verifyOnly) {
      const total = await rebuildProjection(pool, chain, cfg.pageLimit);
      console.log(`reindex complete: ${total} events applied`);
    }
    const divergent = await verifyProjection(pool, chain, cfg.pageLimit);
    for (const d of divergent) {
      console.log(`${d.kit}: ${d.diffs.length} divergence(s)`);
      for (const x of d.diffs) {
        console.log(`  ${x.field}: proj=${JSON.stringify(x.projection)} realm=${JSON.stringify(x.realm)}`);
      }
    }
    console.log(divergent.length === 0
      ? "projection converges with realm inventory"
      : `${divergent.length} kit(s) diverge`);
    await pool.end();
    process.exit(divergent.length === 0 ? 0 : 1);
  } catch (e) {
    if (e instanceof IndexerSuspended) {
      console.error(e.message);
      await pool.end();
      process.exit(2);
    }
    console.error(`reindex failed (projection untouched): ${(e as Error).message}`);
    await pool.end();
    process.exit(3);
  }
}
