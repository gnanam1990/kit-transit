package custody

import (
	"strings"
	"testing"
)

// T-004 (realm side): each asset is issued once; replaying issuance returns
// the prior receipt and never increases holdings. Amending the catalogue
// label after dispatch leaves the in-flight revision's label untouched.
func TestT004_IssueOnceReplayAmendLabel(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-t004")
	m := kits["kit-t004"].curManifest()
	if m.Rev != 1 || m.Digest == "" || len(m.Lines) != 6 {
		fail(t, "rev-1 manifest malformed")
	}
	d1 := m.Digest
	// Replay the exact issuance: prior result, holdings unchanged.
	r := DefineManifest(cross(cur), "op-dm-kit-t004", "kit-t004", sixLines(), "inspect-each-return")
	if !strings.Contains(r, `"replayed":true`) || !strings.Contains(r, d1) {
		fail(t, "issuance replay did not return prior result")
	}
	if bals[balKey("kit-t004", "lens")].Issued != 1 {
		fail(t, "replay increased holdings")
	}
	// Dispatch under rev 1, then amend the label.
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	dispatchAll(cur, t, "op-dsp-t004", "kit-t004")
	legID := lastLegID("kit-t004")
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	AmendManifest(cross(cur), "op-am-t004", "kit-t004",
		strings.Replace(sixLines(), "Prime lens", "Renamed lens", 1), "inspect-each-return")
	m2 := kits["kit-t004"].curManifest()
	if m2.Rev != 2 || m2.Parent != d1 || m2.Digest == d1 {
		fail(t, "amend did not chain digests")
	}
	// The in-flight leg is bound to rev 1, whose label is immutable.
	m1 := manifestsOf(kits["kit-t004"])[0]
	lensLabel := ""
	for _, ln := range m1.Lines {
		if ln.ID == "lens" {
			lensLabel = ln.Label
		}
	}
	if lensLabel != "Prime lens" || m1.Digest != d1 {
		fail(t, "in-flight revision label mutated")
	}
	if legs[legID].ManifestRev != 1 {
		fail(t, "in-flight leg lost revision binding")
	}
}

// T-005 (realm side): a serialized line is exactly one unit — a second scan
// cannot raise it; interchangeable parts need declared units and bounded
// counts.
func TestT005_SerializedAndBoundedLines(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	mustAbort(t, "serialized", func() {
		DefineManifest(cross(cur), "op-dm-t005a", "kit-t005a", "cam:2:1:unit:Camera", "p")
	})
	mustAbort(t, "duplicate", func() {
		DefineManifest(cross(cur), "op-dm-t005b", "kit-t005b", "cam:1:0:unit:X;cam:1:0:unit:Y", "p")
	})
	mustAbort(t, "unit", func() {
		DefineManifest(cross(cur), "op-dm-t005c", "kit-t005c", "cam:1:0::Camera", "p")
	})
	mustAbort(t, "qty out of bounds", func() {
		DefineManifest(cross(cur), "op-dm-t005e", "kit-t005e", "screw:10000:0:unit:M4 screw", "p")
	})
	// Same kit id with a different spec is rejected (no silent overwrite).
	defineKit(cur, t, "kit-t005")
	mustAbort(t, "kit exists", func() {
		DefineManifest(cross(cur), "op-dm-t005d", "kit-t005", "cam:1:0:unit:X", "p")
	})
}

// Dispatch pins the caller-declared revision; a stale expectation aborts
// before any custody moves (supplementary to T-004's binding guarantee).
func TestRevBindingStaleExpectation(cur realm, t *testing.T) {
	testing.SetOriginCaller(address(REG)); testing.SetRealm(testing.NewUserRealm(address(REG)))
	enrollAB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	grantDesksA(cur, t)
	testing.SetOriginCaller(address(B1)); testing.SetRealm(testing.NewUserRealm(address(B1)))
	grantDesksB(cur, t)
	testing.SetOriginCaller(address(A1)); testing.SetRealm(testing.NewUserRealm(address(A1)))
	defineKit(cur, t, "kit-revb")
	AmendManifest(cross(cur), "op-am-revb", "kit-revb",
		sixLines()+";pouch:1:0:unit:Carry pouch", "inspect-each-return")
	testing.SetOriginCaller(address(A2)); testing.SetRealm(testing.NewUserRealm(address(A2)))
	mustAbort(t, "stale manifest revision", func() {
		Dispatch(cross(cur), "op-dsp-revb", "kit-revb", "B", 1, "", "body:1")
	})
	if kits["kit-revb"].ActiveLeg != "" {
		fail(t, "stale-rev dispatch moved custody")
	}
	Dispatch(cross(cur), "op-dsp-revb2", "kit-revb", "B", 2, "", "body:1")
	if legs[lastLegID("kit-revb")].ManifestRev != 2 {
		fail(t, "leg not bound to revision 2")
	}
}

func manifestsOf(k *Kit) []*Manifest { return k.Manifests }
