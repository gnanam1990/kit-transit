package custody

import (
	"strings"
	"testing"
)

// T-010: send six pieces, receive five at B — the public read model shows
// five accepted and one open lens exception.
func TestT010_SixSentFiveReceived(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t010")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t010", "kit-t010")
	legID := lastLegID("kit-t010")
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	ReceiveDelta(cross(cur), "op-rcv-t010", legID,
		"body:1;strap:1;cable:1;card:1;cap:1", "", "lens:1", "lens-not-in-parcel")
	leg := legs[legID]
	if leg.Accepted["body"] != 1 || leg.outstanding("lens") != 1 {
		fail(t, "partial receipt wrong")
	}
	if !leg.Observed {
		fail(t, "observation not recorded")
	}
	exc := onlyExc(t, "kit-t010")
	if exc.Kind != ExcMissing || exc.Status != ExcOpen || exc.Qty != 1 {
		fail(t, "missing exception not opened")
	}
	if bals[balKey("kit-t010", "body")].Held["B"] != 1 {
		fail(t, "accepted unit not credited to B")
	}
	if kits["kit-t010"].Available {
		fail(t, "incomplete kit became available")
	}
	// Independent public read: five accepted, one open missing exception.
	pub := GetKit("kit-t010")
	if !strings.Contains(pub, `"openExceptions":["`+exc.ID+":missing:lens\"]") {
		fail(t, "public read missing open exception")
	}
	if !strings.Contains(GetLeg(legID), `"accepted"`) ||
		!strings.Contains(GetExceptions("kit-t010"), "lens-not-in-parcel") {
		fail(t, "public leg/exception read incomplete")
	}
}

// T-011: acknowledging as origin A, as a different destination C, or via a
// forwarded untrusted call — every attempt leaves custody state unchanged.
func TestT011_OriginOtherDestForwardedDenied(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	enrollC(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(C1)); testing.SetRealm(testing.NewUserRealm(address(C1)))
	grantDesksC(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t011")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t011", "kit-t011")
	legID := lastLegID("kit-t011")
	// Origin custodian cannot ack for B.
	mustAbort(t, "role", func() {
		ReceiveDelta(cross(cur), "op-rcv-t011x", legID, "body:1", "", "", "")
	})
	// A different destination's custodian cannot ack either.
	testing.SetOriginCaller(address(C1)); testing.SetRealm(testing.NewUserRealm(address(C1)))
	mustAbort(t, "role", func() {
		ReceiveDelta(cross(cur), "op-rcv-t011y", legID, "body:1", "", "", "")
	})
	// Unaffiliated signer denied outright.
	testing.SetOriginCaller(address(D1)); testing.SetRealm(testing.NewUserRealm(address(D1)))
	mustAbort(t, "lacks role", func() {
		ReceiveDelta(cross(cur), "op-rcv-t011z", legID, "body:1", "", "", "")
	})
	// INV-01: a forwarded code-realm call on a signer's behalf is rejected.
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/evil/forwarder"))
	mustAbort(t, "forwarded", func() {
		ReceiveDelta(cross(cur), "op-fwd", legID, "body:1", "", "", "")
	})
	// Custody untouched by all four attempts.
	if legs[legID].Observed || bals[balKey("kit-t011", "body")].Transit[legID] != 1 {
		fail(t, "unauthorized ack mutated custody")
	}
	// The real destination still can.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	ReceiveDelta(cross(cur), "op-rcv-t011", legID, "body:1", "", "", "")
	// Accepted quantity can never exceed dispatched quantity.
	mustAbort(t, "exceeds outstanding", func() {
		ReceiveDelta(cross(cur), "op-rcv-t011b", legID, "body:2", "", "", "")
	})
}

// T-012: the missing lens arrives days later under the same leg — a single
// additional accepted item; the original receipt is unchanged.
func TestT012_SupplementalSameLeg(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t012")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t012", "kit-t012")
	legID := lastLegID("kit-t012")
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	ReceiveDelta(cross(cur), "op-rcv-t012", legID,
		"body:1;strap:1;cable:1;card:1;cap:1", "", "lens:1", "lens-not-in-parcel")
	orig := ops["B/op-rcv-t012"].Digest
	// Supplemental receipt of the lens on the same leg.
	ReceiveDelta(cross(cur), "op-rcv-t012b", legID, "lens:1", "", "", "")
	leg := legs[legID]
	if leg.outstanding("lens") != 0 || leg.Accepted["lens"] != 1 {
		fail(t, "supplemental receipt not applied")
	}
	if bals[balKey("kit-t012", "lens")].Held["B"] != 1 {
		fail(t, "lens not credited to B")
	}
	// The original receipt op record is untouched.
	if ops["B/op-rcv-t012"].Digest != orig ||
		!strings.Contains(GetOp("B", "op-rcv-t012"), orig) {
		fail(t, "original receipt mutated")
	}
	CloseLeg(cross(cur), "op-cls-t012", legID)
	if legs[legID].Status != LegClosed {
		fail(t, "leg did not close")
	}
	// Owner reconciles the earlier missing report as resolved.
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	exc := onlyExc(t, "kit-t012")
	ResolveException(cross(cur), "op-exc-t012", exc.ID, "resolved", "lens-received-supplemental")
	if excs[exc.ID].Status != ExcClosed {
		fail(t, "exception not closed")
	}
}

func onlyExc(t *testing.T, kitID string) *Exc {
	t.Helper()
	var found *Exc
	for _, e := range excs {
		if e.Kit == kitID {
			if found != nil {
				fail(t, "expected exactly one exception")
			}
			found = e
		}
	}
	if found == nil {
		fail(t, "no exception for kit")
	}
	return found
}

// openExcOfKind returns the kit's open exception of the given kind.
func openExcOfKind(t *testing.T, kitID, kind string) *Exc {
	t.Helper()
	for _, e := range excs {
		if e.Kit == kitID && e.Kind == kind && e.Status == ExcOpen {
			return e
		}
	}
	fail(t, "no open "+kind+" exception for kit")
	return nil
}
