package custody

import (
	"chain/runtime"
	"sort"
	"strconv"
	"strings"
)

// Public read surface. Everything here is already public on-chain data:
// opaque ids, bounded quantities, public org identities, enumerated codes and
// commitments. No patron ids, staff names, private barcodes or media URLs ever
// enter this realm (INV-08). Reads include network identity and observed
// height so callers can reason about freshness.

func netJSON() string {
	return `"chainId":` + jqs(runtime.ChainID()) + `,"realm":` + jqs(RealmPath()) + `,"height":` + itoa(chainHeight()) + `,"rev":` + itoa(stateRev)
}

// RealmPath identifies this realm's package path for cross-checks.
func RealmPath() string { return "gno.land/r/kittransit/custody" }

func GetKit(kitID string) string {
	k := kits[kitID]
	if k == nil {
		return `{"error":"unknown kit"}`
	}
	m := k.curManifest()
	var lines []string
	for _, ln := range m.Lines {
		b := bals[balKey(kitID, ln.ID)]
		var heldParts []string
		for org, q := range b.Held {
			heldParts = append(heldParts, jqs(org)+":"+itoa(q))
		}
		sort.Strings(heldParts)
		var transit int64
		for _, q := range b.Transit {
			transit += q
		}
		lines = append(lines, `{"id":`+jqs(ln.ID)+`,"label":`+jqs(ln.Label)+
			`,"required":`+itoa(ln.Qty)+`,"issued":`+itoa(b.Issued)+
			`,"held":{`+strings.Join(heldParts, ",")+
			`},"inTransit":`+itoa(transit)+`,"unlocated":`+itoa(b.Unlocated)+
			`,"quarantine":`+itoa(b.Quarantine)+`,"retired":`+itoa(b.Retired)+
			`,"assessment":`+jqs(b.Assessment)+`}`)
	}
	sort.Strings(lines)
	var openExc []string
	for _, e := range excs {
		if e.Kit == kitID && e.Status == ExcOpen {
			openExc = append(openExc, jqs(e.ID+":"+e.Kind+":"+e.Line))
		}
	}
	sort.Strings(openExc)
	return `{` + netJSON() +
		`,"kit":` + jqs(kitID) +
		`,"owner":` + jqs(k.Owner) +
		`,"manifestRev":` + itoa(m.Rev) +
		`,"manifestDigest":` + jqs(m.Digest) +
		`,"activeLeg":` + jqs(k.ActiveLeg) +
		`,"available":` + boolS(k.Available) +
		`,"hold":` + boolS(k.Hold) +
		`,"needsAssessment":` + boolS(k.NeedsAssessment) +
		`,"lines":[` + strings.Join(lines, ",") + `]` +
		`,"openExceptions":[` + strings.Join(openExc, ",") + `]}`
}

// GetManifest returns a specific immutable revision — the binding a leg
// actually carried, independent of later catalogue edits.
func GetManifest(kitID string, rev int64) string {
	k := kits[kitID]
	if k == nil {
		return `{"error":"unknown kit"}`
	}
	m := k.manifestAt(rev)
	var lines []string
	for _, ln := range m.Lines {
		ser := "0"
		if ln.Serialized {
			ser = "1"
		}
		lines = append(lines, `{"id":`+jqs(ln.ID)+`,"label":`+jqs(ln.Label)+
			`,"qty":`+itoa(ln.Qty)+`,"serialized":`+ser+`,"unit":`+jqs(ln.Unit)+`}`)
	}
	return `{` + netJSON() + `,"kit":` + jqs(kitID) + `,"rev":` + itoa(m.Rev) +
		`,"digest":` + jqs(m.Digest) + `,"parent":` + jqs(m.Parent) +
		`,"policy":` + jqs(m.Policy) + `,"height":` + itoa(m.Height) +
		`,"by":` + jqs(m.By) + `,"lines":[` + strings.Join(lines, ",") + `]}`
}

func GetLeg(legID string) string {
	l := legs[legID]
	if l == nil {
		return `{"error":"unknown leg"}`
	}
	out := map[string]int64{}
	for id := range l.Qty {
		out[id] = l.outstanding(id)
	}
	return `{` + netJSON() +
		`,"leg":` + jqs(legID) +
		`,"kit":` + jqs(l.Kit) +
		`,"kind":` + jqs(l.Kind) +
		`,"sender":` + jqs(l.Sender) +
		`,"dest":` + jqs(l.Dest) +
		`,"manifestRev":` + itoa(l.ManifestRev) +
		`,"prev":` + jqs(l.Prev) +
		`,"status":` + jqs(l.Status) +
		`,"dispatched":` + jmap(l.Qty) +
		`,"accepted":` + jmap(l.Accepted) +
		`,"closedUnreceived":` + jmap(l.ClosedUnreceived) +
		`,"reportedMissing":` + jmap(l.ReportedMissing) +
		`,"outstanding":` + jmap(out) +
		`,"observed":` + boolS(l.Observed) +
		`,"openHeight":` + itoa(l.OpenH) +
		`,"closeHeight":` + itoa(l.CloseH) + `}`
}

// GetOp resolves an operation by (org, opID) — the retry-recovery path for a
// dropped broadcast response.
func GetOp(orgID, opID string) string {
	op := ops[orgID+"/"+opID]
	if op == nil {
		return `{` + netJSON() + `,"status":"unknown"}`
	}
	return `{` + netJSON() + `,"status":"confirmed","op":` + jqs(op.ID) +
		`,"org":` + jqs(op.Org) + `,"kind":` + jqs(op.Kind) +
		`,"digest":` + jqs(op.Digest) + `,"opHeight":` + itoa(op.Height) +
		`,"signer":` + jqs(op.Signer) + `,"result":` + op.Result + `}`
}

// GetOrg returns an org and its grant history (public signer bindings).
func GetOrg(orgID string) string {
	o := orgs[orgID]
	if o == nil {
		return `{"error":"unknown org"}`
	}
	var gs []string
	for _, g := range grants {
		if g.OrgID == orgID {
			gs = append(gs, `{"addr":`+jqs(g.Addr)+`,"role":`+jqs(g.Role)+
				`,"active":`+boolS(g.Active)+`,"granted":`+itoa(g.Granted)+
				`,"revoked":`+itoa(g.Revoked)+`}`)
		}
	}
	sort.Strings(gs)
	return `{` + netJSON() + `,"org":` + jqs(orgID) + `,"active":` + boolS(o.Active) +
		`,"enrollHeight":` + itoa(o.Height) + `,"grants":[` + strings.Join(gs, ",") + `]}`
}

// GetExceptions lists exceptions; filter kitID may be "" for all.
func GetExceptions(kitID string) string {
	var out []string
	for _, e := range excs {
		if kitID != "" && e.Kit != kitID {
			continue
		}
		out = append(out, `{"id":`+jqs(e.ID)+`,"kit":`+jqs(e.Kit)+`,"leg":`+jqs(e.Leg)+
			`,"line":`+jqs(e.Line)+`,"kind":`+jqs(e.Kind)+`,"qty":`+itoa(e.Qty)+
			`,"status":`+jqs(e.Status)+`,"reason":`+jqs(e.Reason)+`,"by":`+jqs(e.By)+
			`,"openHeight":`+itoa(e.OpenH)+`,"closeHeight":`+itoa(e.CloseH)+`}`)
	}
	sort.Strings(out)
	return `{` + netJSON() + `,"exceptions":[` + strings.Join(out, ",") + `]}`
}

// GetClaims lists found-unit claims for a kit.
func GetClaims(kitID string) string {
	var out []string
	for _, c := range claims {
		if kitID != "" && c.Kit != kitID {
			continue
		}
		out = append(out, `{"id":`+jqs(c.ID)+`,"kit":`+jqs(c.Kit)+`,"line":`+jqs(c.Line)+
			`,"finder":`+jqs(c.Finder)+`,"qty":`+itoa(c.Qty)+`,"sourceLeg":`+jqs(c.SourceLeg)+
			`,"status":`+jqs(c.Status)+`,"height":`+itoa(c.Height)+`,"confirmHeight":`+itoa(c.ConfirmH)+`}`)
	}
	sort.Strings(out)
	return `{` + netJSON() + `,"claims":[` + strings.Join(out, ",") + `]}`
}

// GetEvents pages the deterministic append-only event feed. The indexer
// replays this into the SQL projection in seq order.
func GetEvents(afterSeq, limit int64) string {
	if limit <= 0 || limit > maxGetEvents {
		limit = maxGetEvents
	}
	var out []string
	for _, ev := range events {
		if ev.Seq <= afterSeq {
			continue
		}
		if int64(len(out)) >= limit {
			break
		}
		out = append(out, `{"seq":`+itoa(ev.Seq)+`,"height":`+itoa(ev.Height)+
			`,"kind":`+jqs(ev.Kind)+`,"kit":`+jqs(ev.Kit)+`,"leg":`+jqs(ev.Leg)+
			`,"line":`+jqs(ev.Line)+`,"org":`+jqs(ev.Org)+`,"data":`+jqs(ev.Data)+`}`)
	}
	var last int64
	if len(events) > 0 {
		last = events[len(events)-1].Seq
	}
	return `{` + netJSON() + `,"lastSeq":` + itoa(last) +
		`,"events":[` + strings.Join(out, ",") + `]}`
}

func boolS(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// Render is the gnoweb entry point.
func Render(path string) string {
	var b strings.Builder
	b.WriteString("# Kit Transit custody realm\n\n")
	b.WriteString("- chain: `" + runtime.ChainID() + "`\n")
	b.WriteString("- height: `" + strconv.Itoa(int(chainHeight())) + "`\n")
	b.WriteString("- state rev: `" + itoa(stateRev) + "`\n\n")
	if path != "" {
		if k := kits[path]; k != nil {
			b.WriteString("## kit " + path + "\n\n```json\n" + GetKit(path) + "\n```\n")
			return b.String()
		}
		if l := legs[path]; l != nil {
			b.WriteString("## leg " + path + "\n\n```json\n" + GetLeg(path) + "\n```\n")
			return b.String()
		}
		b.WriteString("unknown kit or leg `" + path + "`\n")
		return b.String()
	}
	var ks []string
	for id := range kits {
		ks = append(ks, id)
	}
	sort.Strings(ks)
	b.WriteString("## kits\n\n")
	for _, id := range ks {
		k := kits[id]
		status := "held"
		if k.Available {
			status = "available"
		}
		b.WriteString("- [" + id + "](/r/kittransit/custody:" + id + ") — owner `" + k.Owner +
			"`, rev `" + itoa(k.curManifest().Rev) + "`, " + status + "\n")
	}
	var os []string
	for id := range orgs {
		os = append(os, id)
	}
	sort.Strings(os)
	b.WriteString("\n## orgs\n\n")
	for _, id := range os {
		b.WriteString("- `" + id + "`\n")
	}
	return b.String()
}
