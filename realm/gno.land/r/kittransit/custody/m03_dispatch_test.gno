package custody

import (
	"strings"
	"testing"
)

// T-007: two competing dispatches for the same kit from the same parent —
// precisely one creates an active leg. Over-dispatch beyond held balance
// aborts atomically.
func TestT007_CompetingDispatches(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	enrollC(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(C1)); testing.SetRealm(testing.NewUserRealm(address(C1)))
	grantDesksC(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t007")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t007", "kit-t007")
	legID := lastLegID("kit-t007")
	mustAbort(t, "active leg", func() {
		Dispatch(cross(cur), "op-dsp-t007b", "kit-t007", "C", 1, legID, "body:1")
	})
	if kits["kit-t007"].ActiveLeg != legID {
		fail(t, "exactly one active leg required")
	}
	// Cancel, then an over-dispatch beyond the restored balance aborts.
	CancelLeg(cross(cur), "op-cx-t007", legID)
	mustAbort(t, "insufficient", func() {
		Dispatch(cross(cur), "op-dsp-t007c", "kit-t007", "B", 1, legID, "body:2")
	})
	if bals[balKey("kit-t007", "body")].Held["A"] != 1 {
		fail(t, "aborted over-dispatch debited balance")
	}
}

// T-008: replaying an accepted operation with identical intent yields the
// prior result; replaying with altered destination conflicts.
func TestT008_ReplayIdenticalThenConflict(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	enrollC(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	defineKit(cur, t, "kit-t008")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	r1 := dispatchAll(cur, t, "op-dsp-t008", "kit-t008")
	legID := lastLegID("kit-t008")
	r2 := dispatchAll(cur, t, "op-dsp-t008", "kit-t008")
	// Identical retry returns the prior result wrapped in a replay marker.
	if !strings.Contains(r2, `"replayed":true`) || !strings.Contains(r2, r1) {
		fail(t, "identical retry did not replay prior result")
	}
	if lastLegID("kit-t008") != legID {
		fail(t, "replay created a second leg")
	}
	if bals[balKey("kit-t008", "body")].Held["A"] != 0 {
		fail(t, "replay double-debited")
	}
	// Same operation id, altered destination: conflict.
	mustAbort(t, "conflict", func() {
		Dispatch(cross(cur), "op-dsp-t008", "kit-t008", "C", 1, "", "body:1;lens:1;strap:1;cable:1;card:1;cap:1")
	})
	if kits["kit-t008"].ActiveLeg != legID {
		fail(t, "conflicting retry mutated state")
	}
}

// T-009: cancelling a retained parcel restores all reserved counts exactly
// once. After a zero-accepted all-missing destination report, cancellation
// must fail — the observation stands.
func TestT009_CancelRestoresOnceAndObservationBlocks(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t009")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t009", "kit-t009")
	legID := lastLegID("kit-t009")
	// Only the sender may cancel.
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	mustAbort(t, "role", func() {
		CancelLeg(cross(cur), "op-cx-t009b", legID)
	})
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	CancelLeg(cross(cur), "op-cx-t009", legID)
	if kits["kit-t009"].ActiveLeg != "" {
		fail(t, "cancel left active leg")
	}
	for _, line := range []string{"body", "lens", "strap", "cable", "card", "cap"} {
		if bals[balKey("kit-t009", line)].Held["A"] != 1 {
			fail(t, "cancel did not restore " + line)
		}
	}
	// Replaying the cancel returns the prior result, not a second restore.
	CancelLeg(cross(cur), "op-cx-t009", legID)
	if bals[balKey("kit-t009", "body")].Held["A"] != 1 {
		fail(t, "cancel replay double-restored")
	}
	// Fresh dispatch; B reports zero accepted, all missing — the
	// destination observation blocks any later cancellation.
	Dispatch(cross(cur), "op-dsp-t009b", "kit-t009", "B", 1, legID,
		"body:1;lens:1;strap:1;cable:1;card:1;cap:1")
	leg2 := lastLegID("kit-t009")
	testing.SetOriginCaller(address(B2)); testing.SetRealm(testing.NewUserRealm(address(B2)))
	ReceiveDelta(cross(cur), "op-rcv-t009", leg2, "", "",
		"body:1;lens:1;strap:1;cable:1;card:1;cap:1", "parcel-empty")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	mustAbort(t, "observed", func() {
		CancelLeg(cross(cur), "op-cx-t009d", leg2)
	})
	if legs[leg2].Status != LegOpen {
		fail(t, "leg state mutated after blocked cancel")
	}
}
