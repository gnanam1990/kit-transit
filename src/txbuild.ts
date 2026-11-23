// Build a real unsigned Gno transaction for a case's reviewed payload, so
// staff can sign it with gnokey (offline flags, no server-held keys) and
// broadcast it themselves or through a configured relayer. The msg is the
// same /vm.m_call the realm expects; the signdoc is amino-sorted and
// byte-identical to what `gnokey sign` produces.

// Positional argument order for each realm function (after `cur realm`).
const FN_ARGS: Record<string, string[]> = {
  EnrollOrg: ["opID", "orgID", "adminAddr"],
  GrantRole: ["opID", "orgID", "addr", "role"],
  RevokeRole: ["opID", "orgID", "addr", "role"],
  SetRegistrar: ["opID", "newAddr"],
  DefineManifest: ["opID", "kitID", "lines", "policy"],
  AmendManifest: ["opID", "kitID", "lines", "policy"],
  IssueReplacement: ["opID", "kitID", "lineID", "qty", "linkRef"],
  Dispatch: ["opID", "kitID", "destOrg", "expectedRev", "prevLeg", "qtys"],
  CancelLeg: ["opID", "legID"],
  ReceiveDelta: ["opID", "legID", "accepted", "conds", "missing", "reason"],
  CloseLeg: ["opID", "legID"],
  StartReturn: ["opID", "kitID", "qtys"],
  ResolveException: ["opID", "excID", "disposition", "reason"],
  ReportFound: ["opID", "kitID", "lineID", "qty", "sourceLeg"],
  ConfirmRecovery: ["opID", "claimID"],
  RejectRecovery: ["opID", "claimID", "reason"],
  WriteOffUnit: ["opID", "kitID", "lineID", "qty", "reason"],
  AssessReturn: ["opID", "kitID", "assessments"],
  ReleaseKit: ["opID", "kitID"],
};

/** Ordered args for a case payload (values stringified as gnokey expects). */
export function msgArgs(payload: Record<string, unknown>): string[] {
  const order = FN_ARGS[String(payload.func)];
  if (!order) throw new Error(`no arg order for ${String(payload.func)}`);
  return order.map((k) => String(payload[k] ?? ""));
}

/** Unsigned tx JSON (gnokey sign input) for a case payload. */
export function caseTx(opts: {
  realm: string;
  caller: string;
  payload: Record<string, unknown>;
  memo?: string;
}): object {
  return {
    msg: [{
      "@type": "/vm.m_call",
      caller: opts.caller,
      send: "",
      max_deposit: "",
      pkg_path: opts.realm,
      func: String(opts.payload.func),
      args: msgArgs(opts.payload),
    }],
    fee: { gas_wanted: "50000000", gas_fee: "1000000ugnot" },
    signatures: null,
    memo: opts.memo ?? "",
  };
}

/** Amino-sorted sign doc for a tx — byte-identical to gnokey's encoding. */
export function caseSigndoc(opts: {
  chainId: string;
  realm: string;
  caller: string;
  payload: Record<string, unknown>;
  memo?: string;
  accountNumber?: number;
  sequence?: number;
}): string {
  const args = msgArgs(opts.payload)
    .map((a) => JSON.stringify(a)).join(",");
  const msg = `{"@type":"/vm.m_call","args":[${args}],` +
    `"caller":${JSON.stringify(opts.caller)},"func":${JSON.stringify(opts.payload.func)},` +
    `"max_deposit":"","pkg_path":${JSON.stringify(opts.realm)},"send":""}`;
  return `{"account_number":"${opts.accountNumber ?? 0}",` +
    `"chain_id":${JSON.stringify(opts.chainId)},` +
    `"fee":{"amount":[{"amount":"1000000","denom":"ugnot"}],"gas":"50000000"},` +
    `"memo":${JSON.stringify(opts.memo ?? "")},"msgs":[${msg}],` +
    `"sequence":"${opts.sequence ?? 0}"}`;
}
