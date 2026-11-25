package custody

import "testing"

// The complete product journey, identical to the sequence verified with 13
// signed local transactions on gnodev (verification/kit-local-receipt.json):
// enroll two orgs, define the six-component kit, dispatch A->B, B attests a
// partial receipt leaving a missing-lens exception, the lens arrives as a
// supplemental receipt on the same leg, the leg closes, B returns the held
// material on a linked return leg, A assesses and releases for re-checkout.
func TestJourney_SixComponentHandoff(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)

	// Owner A defines the six-component manifest.
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-journey")
	if !kits["kit-journey"].Hold {
		fail(t, "new kit should start held")
	}

	// A signs dispatch of all six to B.
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-jrny", "kit-journey")
	outLeg := lastLegID("kit-journey")

	// B independently attests five components; lens reported missing.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	ReceiveDelta(cross(cur), "op-rcv-jrny", outLeg,
		"body:1;strap:1;cable:1;card:1;cap:1", "", "lens:1", "lens-not-in-parcel")
	exc := onlyExc(t, "kit-journey")
	if exc.Kind != ExcMissing {
		fail(t, "missing exception absent")
	}

	// The lens arrives later — supplemental receipt on the same leg.
	ReceiveDelta(cross(cur), "op-rcv-jrny2", outLeg, "lens:1", "", "", "")
	CloseLeg(cross(cur), "op-cls-jrny", outLeg)

	// A reconciles the earlier missing report.
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ResolveException(cross(cur), "op-exc-jrny", exc.ID, "resolved", "received-supplemental")

	// B creates the reverse handoff for the material it holds.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	StartReturn(cross(cur), "op-ret-jrny", "kit-journey",
		"body:1;lens:1;strap:1;cable:1;card:1;cap:1")
	retLeg := lastLegID("kit-journey")

	// A receives the return and assesses every line serviceable.
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	ReceiveDelta(cross(cur), "op-rcv-jrnyr", retLeg,
		"body:1;lens:1;strap:1;cable:1;card:1;cap:1", "", "", "")
	CloseLeg(cross(cur), "op-cls-jrnyr", retLeg)
	AssessReturn(cross(cur), "op-asm-jrny", "kit-journey",
		"body:ok;lens:ok;strap:ok;cable:ok;card:ok;cap:ok")
	ReleaseKit(cross(cur), "op-rel-jrny", "kit-journey")

	kit := kits["kit-journey"]
	if !kit.Available || kit.Hold || kit.NeedsAssessment || kit.ActiveLeg != "" {
		fail(t, "kit not back in circulation")
	}
	// Conservation: all six issued units held by the owner.
	for _, line := range []string{"body", "lens", "strap", "cable", "card", "cap"} {
		b := bals[balKey("kit-journey", line)]
		if b.Held["A"] != 1 || b.Unlocated != 0 || b.Retired != 0 || len(b.Transit) != 0 {
			fail(t, "conservation violated for " + line)
		}
	}
	// Every operation is independently queryable with its digest and height.
	if GetOp("A", "op-dsp-jrny") == "" || GetOp("B", "op-rcv-jrny") == "" {
		fail(t, "operation receipts not queryable")
	}
}
