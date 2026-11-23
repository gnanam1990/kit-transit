package custody

// M01 — Institutions and signing authority.
//
// The consortium registrar admits orgs; each org admin manages its own staff
// keys. Grant history keeps effective heights. An address may hold active
// grants in at most one org (staff keys belong to one institution).

func Registrar() address { return effectiveRegistrar() }

// effectiveRegistrar resolves the registrar: the deployer-bound value, or
// the dev-mode fallback on isolated chains only.
func effectiveRegistrar() address {
	if registrar.String() != "" {
		return registrar
	}
	if isDevChain() {
		return address(localDevRegistrarBech)
	}
	panic("kittransit: registrar is not initialized")
}

// mustRegistrar asserts the caller is the current registrar.
func mustRegistrar(cur realm) string {
	c := signerAddr(cur)
	if address(c) != effectiveRegistrar() {
		panic("kittransit: registrar only")
	}
	return c
}

// SetRegistrar rotates the consortium registrar. Current registrar only.
func SetRegistrar(cur realm, opID, newAddr string) string {
	c := mustRegistrar(cur)
	body := "new=" + newAddr
	if prev := opReplay(cur, "_registrar", opID, "SetRegistrar", body); prev != nil {
		return replayResult(prev)
	}
	mustBech32(newAddr)
	if !isDevChain() && newAddr == localDevRegistrarBech {
		panic("kittransit: dev registrar refused on this chain")
	}
	registrar = address(newAddr)
	rev := bumpRev()
	emitEvent("registrar-rotate", "", "", "", "_registrar", "new="+newAddr)
	op := opCommit(cur, "_registrar", opID, "SetRegistrar", body, c, `{"registrar":`+jqs(newAddr)+`}`)
	op.Rev = rev
	return op.Result
}

// EnrollOrg admits an institution and binds its first admin key. Registrar
// only; registrar credentials alone can never acknowledge goods.
func EnrollOrg(cur realm, opID, orgID, adminAddr string) string {
	c := mustRegistrar(cur)
	validID(orgID)
	mustBech32(adminAddr)
	body := "org=" + orgID + ";admin=" + adminAddr
	if prev := opReplay(cur, orgID, opID, "EnrollOrg", body); prev != nil {
		return replayResult(prev)
	}
	if orgs[orgID] != nil {
		panic("kittransit: org already enrolled " + orgID)
	}
	if org := orgOfAddr(adminAddr); org != "" {
		panic("kittransit: key already bound to " + org)
	}
	h := chainHeight()
	orgs[orgID] = &Org{ID: orgID, Active: true, Height: h}
	grants[grantKey(orgID, adminAddr, RoleAdmin)] = &Grant{
		OrgID: orgID, Addr: adminAddr, Role: RoleAdmin, Active: true, Granted: h,
	}
	rev := bumpRev()
	emitEvent("org-enroll", "", "", "", orgID, "admin="+adminAddr)
	op := opCommit(cur, orgID, opID, "EnrollOrg", body, c, `{"org":`+jqs(orgID)+`,"height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

// GrantRole binds a staff key to a scoped role. Org admin only.
func GrantRole(cur realm, opID, orgID, addr, role string) string {
	c := mustOrgRole(cur, orgID, RoleAdmin)
	validID(role)
	mustBech32(addr)
	body := "org=" + orgID + ";addr=" + addr + ";role=" + role
	if prev := opReplay(cur, orgID, opID, "GrantRole", body); prev != nil {
		return replayResult(prev)
	}
	if role != RoleAdmin && role != RoleCustodian && role != RoleAssessor {
		panic("kittransit: unknown role")
	}
	if g := grants[grantKey(orgID, addr, role)]; g != nil && g.Active {
		panic("kittransit: key already bound under " + orgID)
	}
	if org := orgOfAddr(addr); org != "" && org != orgID {
		panic("kittransit: key already bound to " + org)
	}
	h := chainHeight()
	key := grantKey(orgID, addr, role)
	if g := grants[key]; g != nil {
		g.Active, g.Granted, g.Revoked = true, h, 0
	} else {
		grants[key] = &Grant{OrgID: orgID, Addr: addr, Role: role, Active: true, Granted: h}
	}
	rev := bumpRev()
	emitEvent("role-grant", "", "", "", orgID, "addr="+addr+";role="+role)
	op := opCommit(cur, orgID, opID, "GrantRole", body, c, `{"granted":`+jqs(role)+`,"height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

// RevokeRole detaches a staff key. The last active org admin cannot be revoked
// (recoverable admin policy).
func RevokeRole(cur realm, opID, orgID, addr, role string) string {
	c := mustOrgRole(cur, orgID, RoleAdmin)
	validID(role)
	body := "org=" + orgID + ";addr=" + addr + ";role=" + role
	if prev := opReplay(cur, orgID, opID, "RevokeRole", body); prev != nil {
		return replayResult(prev)
	}
	g := grants[grantKey(orgID, addr, role)]
	if g == nil || !g.Active {
		panic("kittransit: no active grant")
	}
	if role == RoleAdmin && activeAdmins(orgID) <= 1 {
		panic("kittransit: cannot revoke last admin")
	}
	h := chainHeight()
	g.Active, g.Revoked = false, h
	rev := bumpRev()
	emitEvent("role-revoke", "", "", "", orgID, "addr="+addr+";role="+role)
	op := opCommit(cur, orgID, opID, "RevokeRole", body, c, `{"revoked":`+jqs(role)+`,"height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

func activeAdmins(orgID string) int {
	n := 0
	for _, g := range grants {
		if g.OrgID == orgID && g.Role == RoleAdmin && g.Active {
			n++
		}
	}
	return n
}

// orgOfAddr resolves the single org an address is actively bound to.
func orgOfAddr(addr string) string {
	found := ""
	for _, g := range grants {
		if g.Addr == addr && g.Active {
			if found != "" && found != g.OrgID {
				return found // defensive; binding invariant prevents this
			}
			found = g.OrgID
		}
	}
	return found
}
