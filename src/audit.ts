// Operations / audit helpers: snapshot-restore comparison, operation lookup
// for recovery (T-026) and the redacted external-reviewer export (T-027).

import type { Pool } from "./db.ts";
import type { ChainClient } from "./chain.ts";

/**
 * Compare the SQL projection against a direct realm read for one kit.
 * Returns a per-field diff; empty diff means the projection is faithful
 * (used after snapshot restore + reindex — T-025).
 */
export async function compareProjectionToRealm(
  pool: Pool, chain: ChainClient, kitId: string,
): Promise<{ field: string; projection: unknown; realm: unknown }[]> {
  const realmKit = (await chain.query(`GetKit(${JSON.stringify(kitId)})`)) as any;
  const proj = await pool.query(`SELECT * FROM proj_kits WHERE kit_id=$1`, [kitId]);
  const diffs: { field: string; projection: unknown; realm: unknown }[] = [];
  const p = proj.rows[0] as any;
  if (!p) {
    if (!realmKit.error) diffs.push({ field: "kit", projection: null, realm: "present" });
    return diffs;
  }
  // Canonical JSON for flat maps (org->qty): key order differs between a
  // jsonb column and a realm object, so compare on sorted keys.
  const canon = (v: any) => {
    if (!v || typeof v !== "object") return v ?? {};
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
  };
  const cmp = (f: string, pv: unknown, rv: unknown) => {
    if (JSON.stringify(canon(pv)) !== JSON.stringify(canon(rv))) {
      diffs.push({ field: f, projection: pv, realm: rv });
    }
  };
  cmp("owner", p.owner, realmKit.owner);
  cmp("manifestRev", Number(p.manifest_rev), realmKit.manifestRev);
  cmp("available", p.available, realmKit.available);
  cmp("hold", p.hold, realmKit.hold);
  cmp("needsAssessment", p.needs_assessment, realmKit.needsAssessment);
  cmp("activeLeg", p.active_leg ?? "", realmKit.activeLeg ?? "");
  const lines = await pool.query(`SELECT * FROM proj_lines WHERE kit_id=$1`, [kitId]);
  for (const ln of (realmKit.lines ?? []) as any[]) {
    const pl = lines.rows.find((r: any) => r.line_id === ln.id);
    cmp(`line.${ln.id}.issued`, pl ? Number(pl.issued) : null, ln.issued);
    cmp(`line.${ln.id}.held`, pl?.held ?? {}, ln.held ?? {});
    cmp(`line.${ln.id}.transit`, pl ? Number(pl.transit_total) : null, ln.inTransit ?? 0);
    cmp(`line.${ln.id}.unlocated`, pl ? Number(pl.unlocated) : null, ln.unlocated);
    cmp(`line.${ln.id}.quarantine`, pl ? Number(pl.quarantine) : null, ln.quarantine);
    cmp(`line.${ln.id}.retired`, pl ? Number(pl.retired) : null, ln.retired);
    cmp(`line.${ln.id}.assessment`, pl?.assessment ?? "none", ln.assessment ?? "none");
  }
  return diffs;
}

/**
 * Recover an operation receipt by network epoch, realm, org and operation
 * id — the recovery path after a dropped broadcast response (T-026).
 */
export async function lookupOperation(
  pool: Pool, chain: ChainClient, org: string, opId: string,
): Promise<Record<string, unknown>> {
  // Live realm read is authoritative; the projection row is cached after.
  const res = await chain.query(`GetOp(${JSON.stringify(org)},${JSON.stringify(opId)})`);
  if ((res as any).status === "confirmed") {
    const r = res as any;
    await pool.query(
      `INSERT INTO proj_ops (org_id, op_id, kind, digest, height, rev, signer, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, op_id) DO UPDATE SET digest=$4, height=$5, rev=$6,
         signer=$7, result=$8`,
      [org, opId, r.kind, r.digest, r.opHeight, r.rev ?? 0, r.signer, JSON.stringify(r.result)]);
  }
  return res;
}

/**
 * Redacted case export for an external reviewer (T-027). Includes only
 * public chain-shaped facts: opaque ids, bounded quantities, reason codes,
 * digests, heights and org identities. Private fields, patron references,
 * object links and staff addresses never appear.
 */
export async function exportCase(pool: Pool, kitId: string): Promise<Record<string, unknown>> {
  const kit = await pool.query(`SELECT * FROM proj_kits WHERE kit_id=$1`, [kitId]);
  if ((kit.rowCount ?? 0) === 0) throw new Error("unknown kit");
  const k = kit.rows[0] as any;
  const lines = (await pool.query(
    `SELECT line_id, issued, held, transit_total, unlocated, quarantine, retired, assessment
     FROM proj_lines WHERE kit_id=$1 ORDER BY line_id`, [kitId])).rows;
  const legs = (await pool.query(
    `SELECT leg_id, kind, sender, dest, manifest_rev, status, open_height, close_height,
            qty, accepted, missing FROM proj_legs WHERE kit=$1 ORDER BY leg_id`, [kitId])).rows;
  const excs = (await pool.query(
    `SELECT exc_id, kind, line, qty, reason, status, open_height, close_height
     FROM proj_exceptions WHERE kit=$1 ORDER BY exc_id`, [kitId])).rows;
  const claims = (await pool.query(
    `SELECT claim_id, line, finder, qty, status, height, confirm_height
     FROM proj_claims WHERE kit=$1 ORDER BY claim_id`, [kitId])).rows;
  return {
    export: "kit-transit-case",
    kit: k.kit_id,
    owner: k.owner,
    manifestRev: Number(k.manifest_rev),
    manifestDigest: k.manifest_digest,
    available: k.available,
    hold: k.hold,
    needsAssessment: k.needs_assessment,
    lines,
    legs,
    exceptions: excs,
    claims,
    // Explicit markers for reviewers — absence is never silent.
    privateEvidence: "excluded-by-policy",
    staffIdentities: "excluded-by-policy",
    patronReferences: "excluded-by-policy",
  };
}
