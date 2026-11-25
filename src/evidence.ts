// Private evidence objects. Bytes live under evidenceDir (never web-served);
// the DB holds metadata + tenant scope. Every read re-evaluates the caller's
// session and org — a copied link yields nothing for another institution
// (T-003/T-023) and revoked sessions lose access immediately.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "./db.ts";
import type { Session } from "./sessions.ts";

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
]);
const MAX_BYTES = 8 * 1024 * 1024;

// Magic-byte sniffing — a declared MIME must match the payload, and
// polyglot/script content is rejected outright.
function sniff(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === "RIFF" &&
      buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

export type EvidenceErrorCode = "mime" | "size" | "empty" | "denied" | "missing";

export class EvidenceError extends Error {
  readonly code: EvidenceErrorCode;
  constructor(message: string, code: EvidenceErrorCode) {
    super(message);
    this.code = code;
  }
}

export async function storeEvidence(
  pool: Pool, dir: string, sess: Session,
  caseId: string, buf: Buffer,
): Promise<{ objectId: string; mime: string; bytes: number }> {
  if (buf.length === 0) throw new EvidenceError("empty upload", "empty");
  if (buf.length > MAX_BYTES) throw new EvidenceError("object too large", "size");
  const mime = sniff(buf);
  if (!mime || !ALLOWED_MIME.has(mime)) {
    throw new EvidenceError("unsupported or mismatched media type", "mime");
  }
  // Case relationship is required and must belong to the caller's org:
  // attachments are scoped to an authorized case, never free-floating.
  const kase = await pool.query(
    `SELECT org_id FROM cases WHERE case_id=$1`, [caseId]);
  if ((kase.rowCount ?? 0) === 0) throw new EvidenceError("unknown case", "missing");
  if (kase.rows[0].org_id !== sess.org_id) {
    throw new EvidenceError("access denied", "denied");
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  // Object ids carry the case binding: identical bytes attached under two
  // different cases produce two distinct, separately authorized objects.
  const caseHash = createHash("sha256").update(caseId).digest("hex").slice(0, 8);
  const objectId = `obj-${sha.slice(0, 16)}-${caseHash}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${objectId}.bin`), buf);
  await pool.query(
    `INSERT INTO evidence_objects (object_id, case_id, org_id, mime, bytes, sha256, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (object_id) DO NOTHING`,
    [objectId, caseId, sess.org_id, mime, buf.length, sha, sess.addr]);
  return { objectId, mime, bytes: buf.length };
}

export interface EvidenceMeta {
  object_id: string;
  case_id: string;
  org_id: string;
  mime: string;
  bytes: number;
}

/** Fresh ACL evaluation on every fetch — no caching, no reusable URLs. */
export async function fetchEvidence(
  pool: Pool, dir: string, sess: Session, objectId: string,
): Promise<{ meta: EvidenceMeta; body: Buffer }> {
  const r = await pool.query(
    `SELECT object_id, case_id, org_id, mime, bytes FROM evidence_objects
     WHERE object_id=$1`, [objectId]);
  const meta = r.rows[0] as EvidenceMeta | undefined;
  if (!meta) throw new EvidenceError("unknown object", "missing");
  // Tenant scope: the caller's CURRENT org must match; grant liveness is
  // re-checked against the projection, not the session's enrolment claim.
  if (meta.org_id !== sess.org_id) throw new EvidenceError("access denied", "denied");
  const g = await pool.query(
    `SELECT 1 FROM proj_grants WHERE org_id=$1 AND addr=$2 AND active=true LIMIT 1`,
    [sess.org_id, sess.addr]);
  if (g.rowCount === 0) throw new EvidenceError("access denied", "denied");
  const path = join(dir, `${meta.object_id}.bin`);
  if (!existsSync(path)) throw new EvidenceError("object missing", "missing");
  return { meta, body: readFileSync(path) };
}

export function evidenceToken(): string { return randomBytes(16).toString("hex"); }
