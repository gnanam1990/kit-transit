// Staff sessions. A public address alone can never authenticate: the desk
// first requests a one-use challenge bound to network/realm/org/device/addr,
// signs it with the institution key, and the API verifies the ed25519
// signature, the address derived from the supplied pubkey, and the CURRENT
// active grant in the projection. Grants are re-checked on every session
// and private-evidence read (revocation is live).

import { randomBytes } from "node:crypto";
import type { Pool } from "./db.ts";
import { addrFromPubkey, verifySignature, challengeSigndoc } from "./authn.ts";

export interface Session {
  token: string;
  addr: string;
  org_id: string;
  device_id: string;
}

const CHALLENGE_TTL_SEC = 120;

async function hasActiveGrant(pool: Pool, org: string, addr: string): Promise<boolean> {
  const g = await pool.query(
    `SELECT 1 FROM proj_grants WHERE org_id=$1 AND addr=$2 AND active=true LIMIT 1`,
    [org, addr]);
  return g.rowCount > 0;
}

export interface Challenge {
  challengeId: string;
  signdoc: string;
  expiresAt: string;
}

/**
 * Issue a one-use sign-in challenge. Refused outright when the address
 * holds no active grant in the claimed org — an unbound public key gets no
 * challenge to sign.
 */
export async function createChallenge(
  pool: Pool, opts: { addr: string; org: string; deviceId: string; network: string; realm: string },
): Promise<Challenge | null> {
  if (!(await hasActiveGrant(pool, opts.org, opts.addr))) return null;
  const challengeId = `chl-${randomBytes(12).toString("hex")}`;
  const nonce = randomBytes(16).toString("hex");
  const signdoc = challengeSigndoc({
    chainId: opts.network, realm: opts.realm, addr: opts.addr, nonce,
  });
  await pool.query(
    `INSERT INTO auth_challenges (challenge_id, addr, org_id, device_id,
       network, realm, signdoc, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval)`,
    [challengeId, opts.addr, opts.org, opts.deviceId, opts.network, opts.realm,
     signdoc, CHALLENGE_TTL_SEC]);
  return { challengeId, signdoc, expiresAt: `${CHALLENGE_TTL_SEC}s` };
}

export class AuthError extends Error {
  readonly code: "grant" | "challenge" | "signature" | "binding";
  constructor(m: string, c: AuthError["code"]) { super(m); this.code = c; }
}

/**
 * Redeem a signed challenge for a session. Verifies: challenge exists and
 * is unused+unexpired, the signature over the exact signdoc, the pubkey's
 * derived address equals the challenge-bound address, and the grant is
 * still active at redemption time.
 */
export async function redeemChallenge(
  pool: Pool, challengeId: string, pubkeyB64: string, signatureB64: string, ttlSec: number,
): Promise<Session> {
  const ch = await pool.query(
    `SELECT * FROM auth_challenges WHERE challenge_id=$1`, [challengeId]);
  const row = ch.rows[0] as any;
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    throw new AuthError("challenge invalid, used or expired", "challenge");
  }
  const pubkey = Buffer.from(pubkeyB64, "base64");
  const sig = Buffer.from(signatureB64, "base64");
  if (pubkey.length !== 32 || sig.length !== 64) {
    throw new AuthError("malformed key or signature", "signature");
  }
  if (addrFromPubkey(pubkey) !== row.addr) {
    throw new AuthError("pubkey does not derive the claimed address", "binding");
  }
  if (!verifySignature(row.signdoc, sig, pubkey)) {
    throw new AuthError("signature verification failed", "signature");
  }
  if (!(await hasActiveGrant(pool, row.org_id, row.addr))) {
    throw new AuthError("grant no longer active", "grant");
  }
  await pool.query(
    `UPDATE auth_challenges SET used_at=now() WHERE challenge_id=$1`, [challengeId]);
  const token = randomBytes(24).toString("hex");
  await pool.query(
    `INSERT INTO sessions (token, addr, org_id, device_id, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
    [token, row.addr, row.org_id, row.device_id, ttlSec]);
  return { token, addr: row.addr, org_id: row.org_id, device_id: row.device_id };
}

/**
 * Operator-issued session: a real, locally minted out-of-band staff
 * credential (console/ops tooling). Still refuses without an active grant —
 * it bypasses the challenge dance, never the grant check.
 */
export async function issueSession(
  pool: Pool, addr: string, org: string, deviceId: string, ttlSec: number,
): Promise<Session | null> {
  if (!(await hasActiveGrant(pool, org, addr))) return null;
  const token = randomBytes(24).toString("hex");
  await pool.query(
    `INSERT INTO sessions (token, addr, org_id, device_id, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
    [token, addr, org, deviceId, ttlSec]);
  return { token, addr, org_id: org, device_id: deviceId };
}

/** Re-check validity AND live grant on every request. */
export async function getSession(pool: Pool, token: string): Promise<Session | null> {
  const r = await pool.query(
    `SELECT token, addr, org_id, device_id FROM sessions
     WHERE token=$1 AND revoked_at IS NULL AND expires_at > now()`,
    [token]);
  const s = r.rows[0] as Session | undefined;
  if (!s) return null;
  if (!(await hasActiveGrant(pool, s.org_id, s.addr))) return null;
  return s;
}

export async function revokeSession(pool: Pool, token: string): Promise<void> {
  await pool.query(`UPDATE sessions SET revoked_at=now() WHERE token=$1`, [token]);
}
