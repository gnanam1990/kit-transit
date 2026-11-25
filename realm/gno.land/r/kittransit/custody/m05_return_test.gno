package custody

import "testing"

// T-013: send six, receive five; close the missing lens into unlocated,
// return the five held units, claim and co-confirm the found lens exactly
// once, reject a duplicate recovery, and hold until the owner has six
// assessed units — the recovered lens comes back on a supplementary return
// leg anchored to the originating outbound line.
func TestT013_FullRecoveryCycle(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t013")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t013", "kit-t013")
	outLeg := lastLegID("kit-t013")
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	ReceiveDelta(cross(cur), "op-rcv-t013", outLeg,
		"body:1;strap:1;cable:1;card:1;cap:1", "", "lens:1", "lens-not-in-parcel")
	// Cannot return while the outbound leg is open.
	mustAbort(t, "active leg", func() {
		StartReturn(cross(cur), "op-ret-t013x", "kit-t013", "body:1")
	})
	// Owner disposes the unreceived lens into unlocated.
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	exc := onlyExc(t, "kit-t013")
	ResolveException(cross(cur), "op-exc-t013", exc.ID, "close-unreceived", "declared-lost")
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	CloseLeg(cross(cur), "op-cls-t013", outLeg)
	// B returns the five units it holds; returning the unlocated lens aborts.
	mustAbort(t, "insufficient", func() {
		StartReturn(cross(cur), "op-ret-t013y", "kit-t013", "body:1;lens:1")
	})
	StartReturn(cross(cur), "op-ret-t013", "kit-t013", "body:1;strap:1;cable:1;card:1;cap:1")
	ret1 := legs[lastLegID("kit-t013")]
	if ret1.Kind != LegReturn || ret1.Prev != outLeg || ret1.Dest != "A" {
		fail(t, "return leg not anchored to originating outbound")
	}
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ReceiveDelta(cross(cur), "op-rcv-t013r", ret1.ID,
		"body:1;strap:1;cable:1;card:1;cap:1", "", "", "")
	CloseLeg(cross(cur), "op-cls-t013r", ret1.ID)
	// B finds the lens and reports it; A co-confirms exactly once.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	claimID := claimIDFromResult(t, ReportFound(cross(cur), "op-found-t013", "kit-t013", "lens", 1, outLeg))
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ConfirmRecovery(cross(cur), "op-conf-t013", claimID)
	if claims[claimID].Status != ClaimConfirmed {
		fail(t, "claim not confirmed")
	}
	b := bals[balKey("kit-t013", "lens")]
	if b.Unlocated != 0 || b.Held["B"] != 1 {
		fail(t, "recovery did not move lens to finder")
	}
	// Co-confirming again and rejecting the resolved claim both abort.
	mustAbort(t, "already resolved", func() {
		ConfirmRecovery(cross(cur), "op-conf-t013b", claimID)
	})
	mustAbort(t, "claim not open", func() {
		RejectRecovery(cross(cur), "op-rej-t013", claimID, "double-check")
	})
	// A second found-report for the same lens has no unlocated cover:
	// discrepancy only.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	dup := claimIDFromResult(t, ReportFound(cross(cur), "op-found2-t013", "kit-t013", "lens", 1, outLeg))
	if claims[dup].Status != ClaimDiscrepancy {
		fail(t, "duplicate recovery not flagged discrepancy")
	}
	// Supplementary return brings the recovered lens home (anchored to the
	// originating outbound line even though the previous leg is a return).
	StartReturn(cross(cur), "op-ret2-t013", "kit-t013", "lens:1")
	ret2 := legs[lastLegID("kit-t013")]
	if ret2.Prev != outLeg || ret2.Dest != "A" {
		fail(t, "supplementary return not anchored to originating outbound")
	}
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ReceiveDelta(cross(cur), "op-rcv-t013r2", ret2.ID, "lens:1", "", "", "")
	CloseLeg(cross(cur), "op-cls-t013r2", ret2.ID)
	// Hold until the owner has all six assessed units.
	mustAbort(t, "assessed serviceable", func() {
		ReleaseKit(cross(cur), "op-rel-t013x", "kit-t013")
	})
	AssessReturn(cross(cur), "op-asm-t013", "kit-t013",
		"body:ok;lens:ok;strap:ok;cable:ok;card:ok;cap:ok")
	ReleaseKit(cross(cur), "op-rel-t013", "kit-t013")
	if !kits["kit-t013"].Available {
		fail(t, "kit not circulating after six assessed units")
	}
}

// T-014: an unauthorized branch tries to mark the returned kit serviceable;
// refusal leaves the signed receipt and hold intact.
func TestT014_UnauthorizedServiceability(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t014")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t014", "kit-t014")
	outLeg := lastLegID("kit-t014")
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	ReceiveDelta(cross(cur), "op-rcv-t014", outLeg,
		"body:1;lens:1;strap:1;cable:1;card:1;cap:1", "", "", "")
	CloseLeg(cross(cur), "op-cls-t014", outLeg)
	StartReturn(cross(cur), "op-ret-t014", "kit-t014",
		"body:1;lens:1;strap:1;cable:1;card:1;cap:1")
	retLeg := lastLegID("kit-t014")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ReceiveDelta(cross(cur), "op-rcv-t014r", retLeg,
		"body:1;lens:1;strap:1;cable:1;card:1;cap:1", "", "", "")
	CloseLeg(cross(cur), "op-cls-t014r", retLeg)
	receipt := GetOp("A", "op-rcv-t014r")
	// An assessor in B — an unauthorized branch for this owner — cannot
	// mark A's kit serviceable.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	mustAbort(t, "assessor", func() {
		AssessReturn(cross(cur), "op-asm-t014x", "kit-t014",
			"body:ok;lens:ok;strap:ok;cable:ok;card:ok;cap:ok")
	})
	mustAbort(t, "assessor", func() {
		ReleaseKit(cross(cur), "op-rel-t014x", "kit-t014")
	})
	// Signed receipt and hold intact.
	if GetOp("A", "op-rcv-t014r") != receipt {
		fail(t, "signed receipt mutated")
	}
	if !kits["kit-t014"].Hold || kits["kit-t014"].Available {
		fail(t, "hold not intact after refused serviceability")
	}
}

// T-015: owner records damage/write-off — the original kit stays
// unavailable; after approved replacement mapping and a fresh assessment the
// revised kit circulates. A late find belonging to a superseded requirement
// moves unlocated -> quarantine; a sighting of permanently retired stock is
// a discrepancy report only. Total issued quantity is preserved throughout.
func TestT015_WriteOffReplacementQuarantine(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t015")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t015", "kit-t015")
	outLeg := lastLegID("kit-t015")
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	ReceiveDelta(cross(cur), "op-rcv-t015", outLeg,
		"body:1;strap:1;cable:1;card:1;cap:1", "", "lens:1", "lens-not-in-parcel")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ResolveException(cross(cur), "op-exc-t015", onlyExc(t, "kit-t015").ID, "close-unreceived", "declared-lost")
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	CloseLeg(cross(cur), "op-cls-t015", outLeg)
	StartReturn(cross(cur), "op-ret-t015", "kit-t015", "body:1;strap:1;cable:1;card:1;cap:1")
	ret1 := lastLegID("kit-t015")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ReceiveDelta(cross(cur), "op-rcv-t015r", ret1, "body:1;strap:1;cable:1;card:1;cap:1", "", "", "")
	CloseLeg(cross(cur), "op-cls-t015r", ret1)
	// Owner records the strap damaged on inspection, then writes it off.
	AssessReturn(cross(cur), "op-asm-t015", "kit-t015",
		"body:ok;strap:damaged;cable:ok;card:ok;cap:ok")
	dmg := openExcOfKind(t, "kit-t015", ExcDamaged)
	if dmg.Line != "strap" {
		fail(t, "damage exception not opened")
	}
	ResolveException(cross(cur), "op-exc2-t015", dmg.ID, "resolved", "damage-confirmed")
	WriteOffUnit(cross(cur), "op-wo-t015", "kit-t015", "strap", 1, "frayed-beyond-repair")
	if kits["kit-t015"].Available || !kits["kit-t015"].Hold {
		fail(t, "kit did not stay unavailable after write-off")
	}
	if bals[balKey("kit-t015", "strap")].Retired != 1 {
		fail(t, "strap not retired")
	}
	// Approved replacement mapping: rev 2 supersedes strap and lens.
	AmendManifest(cross(cur), "op-am-t015", "kit-t015",
		"body:1:1:unit:Camera body;lens2:1:1:unit:Prime lens v2;"+
			"strap2:1:0:unit:Neck strap v2;cable:1:1:unit:USB cable;"+
			"card:1:1:unit:SD card;cap:1:1:unit:Lens cap", "inspect-each-return")
	// Late find of the superseded lens requirement -> quarantine.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	cl := claimIDFromResult(t, ReportFound(cross(cur), "op-found-t015", "kit-t015", "lens", 1, outLeg))
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ConfirmRecovery(cross(cur), "op-conf-t015", cl)
	lensBal := bals[balKey("kit-t015", "lens")]
	if lensBal.Quarantine != 1 || lensBal.Unlocated != 0 || claims[cl].Status != ClaimQuarantined {
		fail(t, "superseded find not quarantined")
	}
	// Sighting of permanently retired stock (strap) is discrepancy only.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	dc := claimIDFromResult(t, ReportFound(cross(cur), "op-found2-t015", "kit-t015", "strap", 1, outLeg))
	if claims[dc].Status != ClaimDiscrepancy {
		fail(t, "retired-stock sighting not discrepancy")
	}
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	mustAbort(t, "report-only", func() {
		ConfirmRecovery(cross(cur), "op-conf2-t015", dc)
	})
	// Replacement issue + fresh assessment lets the revised kit circulate.
	IssueReplacement(cross(cur), "op-iss-t015", "kit-t015", "strap2", 1, "replaces-strap")
	IssueReplacement(cross(cur), "op-iss2-t015", "kit-t015", "lens2", 1, "replaces-lens")
	AssessReturn(cross(cur), "op-asm2-t015", "kit-t015",
		"body:ok;lens2:ok;strap2:ok;cable:ok;card:ok;cap:ok")
	ReleaseKit(cross(cur), "op-rel-t015", "kit-t015")
	if !kits["kit-t015"].Available {
		fail(t, "revised kit did not circulate")
	}
	// Conservation per line: issued == held + transit + unlocated +
	// quarantine + retired.
	assertConserved(t, "kit-t015")
}

// TestSecondCycle is supplementary: after a release, a new borrowing cycle
// requires a fresh dispatch, receipt, return, assessment and release —
// nothing carries over.
func TestSecondCycle(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-c2")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	for cycle := 1; cycle <= 2; cycle++ {
		op := func(p string) string { return p + "-c2" + itoa(int64(cycle)) }
		Dispatch(cross(cur), op("op-dsp"), "kit-c2", "B", 1, lastLegID("kit-c2"),
			"body:1;lens:1;strap:1;cable:1;card:1;cap:1")
		outLeg := lastLegID("kit-c2")
		testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
		ReceiveDelta(cross(cur), op("op-rcv"), outLeg,
			"body:1;lens:1;strap:1;cable:1;card:1;cap:1", "", "", "")
		CloseLeg(cross(cur), op("op-cls"), outLeg)
		StartReturn(cross(cur), op("op-ret"), "kit-c2",
			"body:1;lens:1;strap:1;cable:1;card:1;cap:1")
		retLeg := lastLegID("kit-c2")
		if legs[retLeg].Prev != outLeg {
			fail(t, "return anchored to wrong origin")
		}
		testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
		ReceiveDelta(cross(cur), op("op-rcvr"), retLeg,
			"body:1;lens:1;strap:1;cable:1;card:1;cap:1", "", "", "")
		CloseLeg(cross(cur), op("op-clsr"), retLeg)
		mustAbort(t, "assessed serviceable", func() {
			ReleaseKit(cross(cur), op("op-relx"), "kit-c2")
		})
		AssessReturn(cross(cur), op("op-asm"), "kit-c2",
			"body:ok;lens:ok;strap:ok;cable:ok;card:ok;cap:ok")
		ReleaseKit(cross(cur), op("op-rel"), "kit-c2")
		if !kits["kit-c2"].Available {
			fail(t, "kit not released in cycle")
		}
	}
	assertConserved(t, "kit-c2")
}

func assertConserved(t *testing.T, kitID string) {
	t.Helper()
	k := mustKit(kitID)
	seen := map[string]bool{}
	for _, m := range k.Manifests {
		for _, ln := range m.Lines {
			seen[ln.ID] = true
		}
	}
	for line := range seen {
		b := bals[balKey(kitID, line)]
		var held, transit int64
		for _, q := range b.Held {
			held += q
		}
		for _, q := range b.Transit {
			transit += q
		}
		if b.Issued != held+transit+b.Unlocated+b.Quarantine+b.Retired {
			fail(t, "conservation violated for " + line)
		}
		if b.Issued < 0 || held < 0 || b.Unlocated < 0 || b.Quarantine < 0 || b.Retired < 0 {
			fail(t, "negative bucket for " + line)
		}
	}
}

func claimIDFromResult(t *testing.T, res string) string {
	t.Helper()
	const p = `"claim":"`
	i := indexOf(res, p)
	if i < 0 {
		fail(t, "no claim id in result "+res)
	}
	rest := res[i+len(p):]
	j := indexOf(rest, `"`)
	return rest[:j]
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
