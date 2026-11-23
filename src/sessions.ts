// Staff sessions. A session binds a signer address, its org (verified
// against the projection's grant table — never client-supplied identity)
// and a device. Tokens are random; revocation is immediate and checked on
// every request, including private evidence fetches (T-003).

import { randomBytes } from "node:crypto";
import type { Pool } from "./db.ts";

export interface Session {
  token: string;
  addr: string;
  org_id: string;
  device_id: string;
}

export async function createSession(
  pool: Pool, addr: string, org: string, deviceId: string, ttlSec: number,
): Promise<Session | null> {
  // The org must actually bind this address in the projected grant table.
  const g = await pool.query(
    `SELECT 1 FROM proj_grants WHERE org_id=$1 AND addr=$2 AND active=true LIMIT 1`,
    [org, addr]);
  if (g.rowCount === 0) return null;
  const token = randomBytes(24).toString("hex");
  await pool.query(
    `INSERT INTO sessions (token, addr, org_id, device_id, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
    [token, addr, org, deviceId, ttlSec]);
  return { token, addr, org_id: org, device_id: deviceId };
}

/** Re-check validity on every request — revocation and expiry are live. */
export async function getSession(pool: Pool, token: string): Promise<Session | null> {
  const r = await pool.query(
    `SELECT token, addr, org_id, device_id FROM sessions
     WHERE token=$1 AND revoked_at IS NULL AND expires_at > now()`,
    [token]);
  return (r.rows[0] as Session | undefined) ?? null;
}

export async function revokeSession(pool: Pool, token: string): Promise<void> {
  await pool.query(`UPDATE sessions SET revoked_at=now() WHERE token=$1`, [token]);
}
