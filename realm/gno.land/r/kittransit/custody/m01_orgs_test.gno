package custody

import "testing"

// T-001: enroll institutions A and B; attempt to register an already bound
// active key under B -> rejected.
func TestT001_EnrollAndRebind(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)

	if orgs["A"] == nil || orgs["B"] == nil {
		fail(t, "orgs A and B not enrolled")
	}
	if !hasRole("A", A1, RoleAdmin) || !hasRole("B", B1, RoleAdmin) {
		fail(t, "admin grants missing")
	}

	// Rebinding A's admin key under B must fail.
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	mustAbort(t, "already bound", func() {
		GrantRole(cross(cur), "op-x1", "B", A1, RoleCustodian)
	})

	// Enrolling an existing org again must fail.
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	mustAbort(t, "already enrolled", func() {
		EnrollOrg(cross(cur), "op-eA2", "A", A2)
	})

	// A non-registrar cannot enroll.
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	mustAbort(t, "registrar", func() {
		EnrollOrg(cross(cur), "op-eC", "C", C1)
	})
}

// T-002 (realm half): revoke a receiving key; its action is rejected while a
// replacement key signs a freshly reviewed intent.
func TestT002_RevokedKeyRejected(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t002")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t002", "kit-t002")

	legID := lastLegID("kit-t002")
	// Revoke B2's custodian grant (the would-be signer).
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	RevokeRole(cross(cur), "op-rv-b2", "B", B2, RoleCustodian)

	// The revoked key's receiving action is rejected.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	mustAbort(t, "lacks role", func() {
		ReceiveDelta(cross(cur), "op-rcv-t002", legID, "body:1", "", "", "")
	})

	// A replacement key can sign a freshly reviewed intent.
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	GrantRole(cross(cur), "op-gB1c", "B", B1, RoleCustodian)
	ReceiveDelta(cross(cur), "op-rcv-t002b", legID, "body:1", "", "", "")

	l := legs[legID]
	if l.Accepted["body"] != 1 {
		fail(t, "replacement receipt not recorded")
	}
}

// The last remaining admin cannot be revoked, keeping the org recoverable.
func TestT002b_LastAdminProtected(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	mustAbort(t, "last admin", func() {
		RevokeRole(cross(cur), "op-rv-last", "B", B1, RoleAdmin)
	})
}

// Registrar bootstrap: deployer-bound registrar rotates only through the
// current registrar; a third party cannot rotate.
func TestRegistrarRotation(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(D1)); testing.SetRealm(testing.NewUserRealm(address(D1)))
	mustAbort(t, "registrar", func() {
		SetRegistrar(cross(cur), "op-rot", A2)
	})
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	SetRegistrar(cross(cur), "op-rot", A2)
	if Registrar() != address(A2) {
		fail(t, "rotation not applied")
	}
	// The old registrar is now denied; the new one can enroll.
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	mustAbort(t, "registrar", func() {
		EnrollOrg(cross(cur), "op-eD", "D", D1)
	})
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	EnrollOrg(cross(cur), "op-eD", "D", D1)
	if orgs["D"] == nil {
		fail(t, "rotated registrar could not enroll")
	}
	// Rotate back to the dev registrar for subsequent tests.
	SetRegistrar(cross(cur), "op-rot-back", REG)
	if registrar != address(REG) {
		fail(t, "rotation-back failed")
	}
}

// INV-01: a forwarded (non-user) call is never authorized. A code realm
// calling ReceiveDelta on a signer's behalf has no custody effect.
func TestT011c_ForwardedCallRejected(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t011c")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t011c", "kit-t011c")

	legID := lastLegID("kit-t011c")
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/evil/forwarder"))
	mustAbort(t, "forwarded", func() {
		ReceiveDelta(cross(cur), "op-fwd", legID, "body:1", "", "", "")
	})
}
