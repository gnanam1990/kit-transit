package custody

import (
	"chain/runtime"
	"crypto/bech32"
	"strings"
)

// Realm state. Package-level variables are the chain state.
//
// Registrar bootstrap: init() binds the registrar to the authenticated
// package deployer (the AddPkg creator identity init() runs as). Only when
// the deploy context carries no origin caller — isolated local development
// and testing — does the well-known gnodev "test1" address apply, and only
// on dev-mode chains. The dev address is refused outright on any other
// chain, so a public deployment can never silently inherit a public key.
// Registrar credentials can never acknowledge goods or act inside an org
// (NFR-01); rotation is via SetRegistrar by the current registrar only.
const localDevRegistrarBech = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5"

var (
	registrar address

	orgs   = map[string]*Org{}
	grants = map[string]*Grant{}  // orgID + "/" + addr + "/" + role
	kits   = map[string]*Kit{}
	bals   = map[string]*LineBal{} // kitID + "/" + lineID
	legs   = map[string]*Leg{}
	excs   = map[string]*Exc{}
	claims = map[string]*Claim{}
	ops    = map[string]*Op{}      // orgID + "/" + opID

	events   []*Event
	nextSeq  int64
	stateRev int64 // global state revision; every mutation bumps it
)

func init(cur realm) {
	deployer := cur.Previous().Address()
	if deployer.String() == "" {
		// No deploy origin (isolated test/dev contexts only).
		if isDevChain() {
			registrar = address(localDevRegistrarBech)
		}
		return
	}
	registrar = deployer
}

// isDevChain reports whether the connected chain is an isolated development
// chain. Anything else — staging, testnet, mainnet — refuses the dev
// registrar.
func isDevChain() bool {
	id := runtime.ChainID()
	return id == "" || id == "dev" || id == "test" ||
		strings.HasPrefix(id, "dev-") || strings.HasPrefix(id, "test-")
}

// mustBech32 validates a newly assigned address with the official parser.
func mustBech32(s string) {
	if _, _, err := bech32.DecodeToBase256(s); err != nil {
		panic("kittransit: invalid bech32 address")
	}
	if !strings.HasPrefix(s, "g1") {
		panic("kittransit: address must use the g1 prefix")
	}
}

func bumpRev() int64 {
	stateRev++
	return stateRev
}

func nextID(prefix string) string {
	nextSeq++
	return prefix + "-" + itoa(nextSeq)
}

func emitEvent(kind, kit, leg, line, org, data string) {
	ev := &Event{
		Seq:    int64(len(events)) + 1,
		Height: chainHeight(),
		Kind:   kind,
		Kit:    kit,
		Leg:    leg,
		Line:   line,
		Org:    org,
		Data:   data,
	}
	events = append(events, ev)
	emit(kind, "kit", kit, "leg", leg, "line", line, "org", org, "seq", itoa(ev.Seq))
}

// balKey indexes per-line balance buckets.
func balKey(kit, line string) string { return kit + "/" + line }

func mustBal(kit, line string) *LineBal {
	b := bals[balKey(kit, line)]
	if b == nil {
		panic("kittransit: unknown line " + kit + "/" + line)
	}
	return b
}

func mustKit(kitID string) *Kit {
	k := kits[kitID]
	if k == nil {
		panic("kittransit: unknown kit " + kitID)
	}
	return k
}

func mustLeg(legID string) *Leg {
	l := legs[legID]
	if l == nil {
		panic("kittransit: unknown leg " + legID)
	}
	return l
}

// outstanding returns dispatched - accepted - closedUnreceived for a line.
func (l *Leg) outstanding(line string) int64 {
	return l.Qty[line] - l.Accepted[line] - l.ClosedUnreceived[line]
}

func (l *Leg) anyOutstanding() bool {
	for id, q := range l.Qty {
		if q-l.Accepted[id]-l.ClosedUnreceived[id] > 0 {
			return true
		}
	}
	return false
}

// manifestAt returns the bound manifest revision for a leg.
func (k *Kit) manifestAt(rev int64) *Manifest {
	if rev < 1 || rev > int64(len(k.Manifests)) {
		panic("kittransit: manifest revision out of range")
	}
	return k.Manifests[rev-1]
}

func (k *Kit) curManifest() *Manifest {
	return k.Manifests[len(k.Manifests)-1]
}

// requiredLines returns the current manifest's required line ids.
func (k *Kit) requiredLines() []string {
	m := k.curManifest()
	out := make([]string, 0, len(m.Lines))
	for _, l := range m.Lines {
		if l.Qty > 0 {
			out = append(out, l.ID)
		}
	}
	return out
}
