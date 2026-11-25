// Catalogue CSV bridge. Import applies partner-supplied rows with sequence/
// version checks and barcode-collision quarantine (T-006); export emits a
// deterministic snapshot. Catalogue state never mutates realm custody, and
// an incomplete kit is never marked AVAILABLE from file data.

import type { Pool } from "./db.ts";

export interface CsvRow {
  branch: string;
  barcode: string;
  item_ref: string;
  state: "HELD" | "AVAILABLE";
  seq: number;
}

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0]!.split(",").map((h) => h.trim());
  const need = ["branch", "barcode", "item_ref", "state", "seq"];
  for (const n of need) {
    if (!header.includes(n)) throw new Error(`csv missing column ${n}`);
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return lines.slice(1).map((l, n) => {
    const f = l.split(",");
    const state = f[idx["state"]!]?.trim();
    if (state !== "HELD" && state !== "AVAILABLE") {
      throw new Error(`csv row ${n + 2}: bad state`);
    }
    const seq = Number(f[idx["seq"]!]);
    if (!Number.isInteger(seq) || seq < 0) throw new Error(`csv row ${n + 2}: bad seq`);
    return {
      branch: f[idx["branch"]!]!.trim(),
      barcode: f[idx["barcode"]!]!.trim(),
      item_ref: f[idx["item_ref"]!]!.trim(),
      state, seq,
    };
  });
}

export interface ImportResult {
  applied: number;
  quarantined: number;
  skipped: number;
  conflicts: { barcode: string; reason: string }[];
}

/**
 * Import catalogue rows. A barcode already bound to a different physical
 * item in the same branch parks the colliding row in barcode_quarantine —
 * explicit resolution required (T-006). Older sequences never overwrite
 * newer catalogue state.
 */
export async function importCsv(pool: Pool, rows: CsvRow[]): Promise<ImportResult> {
  const res: ImportResult = { applied: 0, quarantined: 0, skipped: 0, conflicts: [] };
  for (const row of rows) {
    const existing = await pool.query(
      `SELECT item_ref, seq FROM catalogue_items WHERE branch=$1 AND barcode=$2`,
      [row.branch, row.barcode]);
    const cur = existing.rows[0];
    if (cur && cur.item_ref !== row.item_ref) {
      // Same barcode, different physical item -> collision quarantine.
      const q = await pool.query(
        `INSERT INTO barcode_quarantine (branch, barcode, item_ref)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
        [row.branch, row.barcode, row.item_ref]);
      res.quarantined++;
      res.conflicts.push({
        barcode: row.barcode,
        reason: (q.rowCount ?? 0) ? `collision with bound item ${cur.item_ref}` : "already quarantined",
      });
      continue;
    }
    if (cur && row.seq < Number(cur.seq)) {
      res.skipped++; // stale import must not overwrite newer state
      continue;
    }
    await pool.query(
      `INSERT INTO catalogue_items (branch, barcode, item_ref, state, seq)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (branch, barcode) DO UPDATE SET item_ref=$3, state=$4, seq=$5, updated_at=now()`,
      [row.branch, row.barcode, row.item_ref, row.state, row.seq]);
    res.applied++;
  }
  return res;
}

/** Deterministic export: one row per projected kit line-bucket summary. */
export async function exportCsv(pool: Pool): Promise<string> {
  const kits = await pool.query(
    `SELECT k.kit_id, k.owner, k.available, k.manifest_rev,
            string_agg(l.line_id || ':' || COALESCE((l.held->>k.owner)::text,'0'), ';' ORDER BY l.line_id) AS held
     FROM proj_kits k LEFT JOIN proj_lines l ON l.kit_id = k.kit_id
     GROUP BY k.kit_id, k.owner, k.available, k.manifest_rev
     ORDER BY k.kit_id`);
  const out = ["kit_id,owner,state,manifest_rev,held"];
  for (const k of kits.rows) {
    out.push(`${k.kit_id},${k.owner},${k.available ? "AVAILABLE" : "HELD"},${k.manifest_rev},${k.held ?? ""}`);
  }
  return out.join("\n") + "\n";
}

/**
 * Partner file interchange: emit a branch's catalogue state in the agreed
 * import schema so the same file a partner receives can be re-imported —
 * a genuine round trip keyed by barcode/item_ref/seq.
 */
export async function partnerCsv(pool: Pool, branch: string): Promise<string> {
  const rows = await pool.query(
    `SELECT barcode, item_ref, state, seq FROM catalogue_items
     WHERE branch=$1 ORDER BY barcode`, [branch]);
  const out = ["branch,barcode,item_ref,state,seq"];
  for (const r of rows.rows) {
    out.push(`${branch},${r.barcode},${r.item_ref},${r.state},${r.seq}`);
  }
  return out.join("\n") + "\n";
}

/** Resolve a quarantined barcode explicitly: rebind or reject. */
export async function resolveQuarantine(
  pool: Pool, id: number, action: "rebind" | "reject", itemRef: string, state: "HELD" | "AVAILABLE", seq: number,
): Promise<void> {
  const q = await pool.query(
    `SELECT * FROM barcode_quarantine WHERE id=$1 AND status='quarantined'`, [id]);
  if ((q.rowCount ?? 0) === 0) throw new Error("no quarantined record");
  const row = q.rows[0];
  if (action === "rebind") {
    await pool.query(
      `INSERT INTO catalogue_items (branch, barcode, item_ref, state, seq)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (branch, barcode) DO UPDATE SET item_ref=$3, state=$4, seq=$5, updated_at=now()`,
      [row.branch, row.barcode, itemRef, state, seq]);
  }
  await pool.query(
    `UPDATE barcode_quarantine SET status=$2, resolution=$3, resolved_at=now() WHERE id=$1`,
    [id, action === "rebind" ? "resolved" : "rejected", action]);
}

/**
 * Drain pending catalogue outbox rows into the CALLER'S branch catalogue
 * (barcode = kit_id for the kit-level sync contract). Delivery state is
 * per (outbox row, branch): one branch's sent/conflict never consumes the
 * feed for another branch. Failures stay pending or move to conflict —
 * realm state is never touched (T-020).
 */
export async function drainOutbox(pool: Pool, branch: string): Promise<{ sent: number; conflicts: number }> {
  const rows = await pool.query(
    `SELECT o.* FROM outbox o
     LEFT JOIN outbox_delivery d ON d.outbox_seq=o.seq AND d.branch=$1
     WHERE d.outbox_seq IS NULL OR d.status IN ('pending','conflict')
     ORDER BY o.seq LIMIT 200`, [branch]);
  let sent = 0, conflicts = 0;
  const mark = async (seq: number, status: string, err = "") => {
    await pool.query(
      `INSERT INTO outbox_delivery (outbox_seq, branch, status, attempts, last_error)
       VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (outbox_seq, branch) DO UPDATE SET
         status=$3, attempts=outbox_delivery.attempts+1,
         last_error=$4, updated_at=now()`,
      [seq, branch, status, err]);
  };
  for (const r of rows.rows) {
    const cur = await pool.query(
      `SELECT seq FROM catalogue_items WHERE branch=$1 AND barcode=$2`, [branch, r.kit_id]);
    const curSeq = cur.rows[0] ? Number(cur.rows[0].seq) : -1;
    if (curSeq > Number(r.event_seq)) {
      await mark(r.seq, "conflict", "newer catalogue state exists");
      conflicts++;
      continue;
    }
    try {
      await pool.query(
        `INSERT INTO catalogue_items (branch, barcode, item_ref, state, seq)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (branch, barcode) DO UPDATE SET state=$4, seq=$5, updated_at=now()`,
        [branch, r.kit_id, r.kit_id, r.state, r.event_seq]);
      await mark(r.seq, "sent");
      sent++;
    } catch (err) {
      await mark(r.seq, "pending", (err as Error).message);
    }
  }
  // Roll the per-branch deliveries up to the shared feed row so operators
  // can see the feed state at a glance. A branch that has not drained yet
  // is invisible here by design — its pending rows are still selected above.
  if (rows.rows.length > 0) {
    await pool.query(
      `UPDATE outbox o SET status=(
         SELECT CASE WHEN COUNT(*) FILTER (WHERE d.status IN ('conflict','manual_review')) > 0
                     THEN 'conflict'
                     WHEN COUNT(*) FILTER (WHERE d.status <> 'sent') = 0 AND COUNT(*) > 0
                     THEN 'sent'
                     ELSE 'pending' END
         FROM outbox_delivery d WHERE d.outbox_seq=o.seq),
         updated_at=now()
       WHERE o.seq = ANY($1)`,
      [rows.rows.map((r) => r.seq)]);
  }
  return { sent, conflicts };
}
