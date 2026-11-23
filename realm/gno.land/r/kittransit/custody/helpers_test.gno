package custody

import (
	"strings"
	"testing"
)

// Disposable local test identities (gnodev/test keybases only, never live).
const (
	REG = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5" // gnodev deployer / registrar
	A1  = "g1v5w3ldx5md6qz9nd4tfdnnajks9p56cxhq2erc" // org A admin
	A2  = "g1hxcfav0uw2xpyvsm4l56vmepy20vedqr6hr377" // org A second desk
	B1  = "g1jx34k3sl5j6s6p7hdj03sw2qqkua4p5vz2z97p" // org B admin
	B2  = "g17wmyg7zwp86ta0cl3u6z6d7nkh94uetfdkcv28" // org B second desk
	C1  = "g1hzqd67gwtkynhkj8fmz0mnpgl2srjglyk05xg2" // org C admin
	D1  = "g1gmjgjmr6v3yqctfctm2wwe39na626dkk2h2nwd" // unaffiliated
)

// IMPORTANT: test bodies must set the signer literally inline:
//   testing.SetOriginCaller(address(X)); testing.SetRealm(testing.NewUserRealm(address(X)))
// testing.SetRealm only mutates the current test frame's cur — calling it
// inside a helper does not affect later cross(cur) calls.

func fail(t *testing.T, msg string) {
	t.Helper()
	t.Fatalf("%s", msg)
}

// mustAbort asserts f aborts with a panic containing want. Cross-realm aborts
// bypass defer/recover; the `revive` builtin (testing mode) catches them.
// NOTE: revive does not roll back pre-abort mutations, so only use it on
// operations whose checks precede their mutations (all realm ops validate
// first).
func mustAbort(t *testing.T, want string, f func()) {
	t.Helper()
	r := revive(f)
	if r == nil {
		t.Fatalf("expected abort containing %q, got none", want)
	}
	s := abortString(r)
	if !strings.Contains(s, want) {
		t.Fatalf("expected abort containing %q, got %q", want, s)
	}
}

func abortString(r any) string {
	switch v := r.(type) {
	case string:
		return v
	case error:
		return v.Error()
	default:
		return "panic"
	}
}

// enrollAB registers orgs A and B (call with realm set to REG).
func enrollAB(cur realm, t *testing.T) {
	t.Helper()
	EnrollOrg(cross(cur), "op-eA", "A", A1)
	EnrollOrg(cross(cur), "op-eB", "B", B1)
}

func enrollC(cur realm, t *testing.T) {
	t.Helper()
	EnrollOrg(cross(cur), "op-eC", "C", C1)
}

// grantDesksA grants A2 custodian+assessor (call as A1).
func grantDesksA(cur realm, t *testing.T) {
	t.Helper()
	GrantRole(cross(cur), "op-gA2", "A", A2, RoleCustodian)
	GrantRole(cross(cur), "op-gA2a", "A", A2, RoleAssessor)
}

// grantDesksB grants B2 custodian+assessor (call as B1).
func grantDesksB(cur realm, t *testing.T) {
	t.Helper()
	GrantRole(cross(cur), "op-gB2", "B", B2, RoleCustodian)
	GrantRole(cross(cur), "op-gB2a", "B", B2, RoleAssessor)
}

func grantDesksC(cur realm, t *testing.T) {
	t.Helper()
	GrantRole(cross(cur), "op-gC1c", "C", C1, RoleCustodian)
}

// sixLines is the canonical six-piece training kit manifest.
func sixLines() string {
	return "body:1:1:unit:Camera body;" +
		"lens:1:1:unit:Prime lens;" +
		"strap:1:1:unit:Neck strap;" +
		"cable:1:1:unit:USB cable;" +
		"card:1:1:unit:SD card;" +
		"cap:1:1:unit:Lens cap"
}

// defineKit creates the training kit under org A (call as A1).
func defineKit(cur realm, t *testing.T, kitID string) {
	t.Helper()
	DefineManifest(cross(cur), "op-dm-"+kitID, kitID, sixLines(), "inspect-each-return")
}

// dispatchAll dispatches all six units A -> B (call as an A custodian).
func dispatchAll(cur realm, t *testing.T, opID, kitID string) string {
	t.Helper()
	return Dispatch(cross(cur), opID, kitID, "B", 1, "", "body:1;lens:1;strap:1;cable:1;card:1;cap:1")
}
