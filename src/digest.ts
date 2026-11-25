// Canonical operation digest — must produce byte-identical input to the
// realm's opDigest (util.gno): the same serialization the chain commits to
// when it records an operation. Case confirmation compares the realm's
// reported digest against this recomputation, so a client can only reach
// `confirmed` by a receipt that matches the reviewed payload exactly.

import { createHash } from "node:crypto";

const s = (v: unknown) => String(v ?? "");

/** Realm opReplay body string per function name (see *.gno body := lines). */
export function opBody(payload: Record<string, unknown>): string {
  switch (s(payload.func)) {
    case "Dispatch":
      return `kit=${s(payload.kitID)};dest=${s(payload.destOrg)};rev=${s(payload.expectedRev)};prev=${s(payload.prevLeg)};qty=${s(payload.qtys)}`;
    case "CancelLeg":
      return `leg=${s(payload.legID)}`;
    case "ReceiveDelta":
      return `leg=${s(payload.legID)};acc=${s(payload.accepted)};cond=${s(payload.conds)};miss=${s(payload.missing)};why=${s(payload.reason)}`;
    case "CloseLeg":
      return `leg=${s(payload.legID)}`;
    case "StartReturn":
      return `kit=${s(payload.kitID)};qty=${s(payload.qtys)}`;
    case "ResolveException":
      return `exc=${s(payload.excID)};disp=${s(payload.disposition)};why=${s(payload.reason)}`;
    case "ReportFound":
      return `kit=${s(payload.kitID)};line=${s(payload.lineID)};qty=${s(payload.qty)};src=${s(payload.sourceLeg)}`;
    case "ConfirmRecovery":
      return `claim=${s(payload.claimID)}`;
    case "RejectRecovery":
      return `claim=${s(payload.claimID)};why=${s(payload.reason)}`;
    case "WriteOffUnit":
      return `kit=${s(payload.kitID)};line=${s(payload.lineID)};qty=${s(payload.qty)};why=${s(payload.reason)}`;
    case "AssessReturn":
      return `kit=${s(payload.kitID)};asm=${s(payload.assessments)}`;
    case "ReleaseKit":
      return `kit=${s(payload.kitID)}`;
    case "DefineManifest":
      return `kit=${s(payload.kitID)};lines=${s(payload.lines)};policy=${s(payload.policy)}`;
    case "AmendManifest":
      return `kit=${s(payload.kitID)};lines=${s(payload.lines)};policy=${s(payload.policy)}`;
    case "IssueReplacement":
      return `kit=${s(payload.kitID)};line=${s(payload.lineID)};qty=${s(payload.qty)};ref=${s(payload.linkRef)}`;
    case "EnrollOrg":
      return `org=${s(payload.orgID)};admin=${s(payload.adminAddr)}`;
    case "GrantRole":
    case "RevokeRole":
      return `org=${s(payload.orgID)};addr=${s(payload.addr)};role=${s(payload.role)}`;
    case "SetRegistrar":
      return `new=${s(payload.newAddr)}`;
    default:
      throw new Error(`no canonical body for func ${s(payload.func)}`);
  }
}

/** sha256 hex of the realm's domain-separated op digest preimage. */
export function opDigest(
  chainId: string, realm: string, kind: string, org: string, opId: string, body: string,
): string {
  return createHash("sha256").update(
    `kittransit/op.v1\nchain=${chainId}\nrealm=${realm}\nkind=${kind}\norg=${org}\nop=${opId}\nbody=${body}`,
    "utf8").digest("hex");
}

/** Digest the realm would record for this case's reviewed payload. */
export function caseDigest(
  kase: { payload: unknown; org_id: string; op_id: string },
  chainId: string, realm: string,
): string {
  const payload = typeof kase.payload === "string"
    ? JSON.parse(kase.payload) : kase.payload as Record<string, unknown>;
  return opDigest(chainId, realm, String(payload.func), kase.org_id, kase.op_id,
    opBody(payload));
}
