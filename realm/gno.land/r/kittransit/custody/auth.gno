package custody

// Authorization. Only a direct user call may assert an institution's role:
// a forwarded realm-to-realm call or a `maketx run` script is never trusted
// (INV-01, T-011 "forwarded untrusted call" case).

// signerAddr returns the bech32 string of the actual tx signer and panics for
// any non-user-call frame.
func signerAddr(cur realm) string {
	prev := cur.Previous()
	if !prev.IsUserCall() {
		panic("kittransit: forwarded or non-origin calls are not authorized")
	}
	return prev.Address().String()
}

func grantKey(org, addr, role string) string { return org + "/" + addr + "/" + role }

func hasRole(org, addr, role string) bool {
	if g := grants[grantKey(org, addr, RoleAdmin)]; g != nil && g.Active {
		return true // org admin satisfies org-scoped roles
	}
	g := grants[grantKey(org, addr, role)]
	return g != nil && g.Active
}

// mustOrgRole asserts the caller holds role (or admin) in org; returns the
// verified signer bech32.
func mustOrgRole(cur realm, org, role string) string {
	if o := orgs[org]; o == nil || !o.Active {
		panic("kittransit: unknown or inactive org " + org)
	}
	c := signerAddr(cur)
	if !hasRole(org, c, role) {
		panic("kittransit: signer lacks role " + role + " in " + org)
	}
	return c
}

// orgOfSigner resolves the caller's org implicitly through its grants —
// the org is never taken from a caller-supplied address.
func mustCustodian(cur realm, org string) string { return mustOrgRole(cur, org, RoleCustodian) }
func mustAssessor(cur realm, org string) string  { return mustOrgRole(cur, org, RoleAssessor) }

// opReplay implements the transaction protocol: an already-applied identical
// operation by the same org returns its recorded result before any fresh-state
// check; different content under the same (org, opID) is a conflict.
// Returns the prior Op for replay, or nil for a fresh operation.
func opReplay(cur realm, org, opID, kind, body string) *Op {
	validID(opID)
	key := org + "/" + opID
	if prev := ops[key]; prev != nil {
		d := opDigest(cur, kind, org, opID, body)
		if prev.Kind != kind || prev.Digest != d {
			panic("kittransit: operation id conflict for " + key)
		}
		return prev
	}
	return nil
}

// opCommit stores the receipt of a fresh operation.
func opCommit(cur realm, org, opID, kind, body, signer, result string) *Op {
	d := opDigest(cur, kind, org, opID, body)
	op := &Op{
		Org:    org,
		ID:     opID,
		Kind:   kind,
		Digest: d,
		Height: chainHeight(),
		Rev:    stateRev,
		Result: result,
		Signer: signer,
	}
	ops[org+"/"+opID] = op
	return op
}

// replayResult is the standard early-return payload for idempotent callers.
func replayResult(op *Op) string {
	return `{"replayed":true,"digest":` + jqs(op.Digest) + `,"height":` + itoa(op.Height) + `,"result":` + op.Result + `}`
}
