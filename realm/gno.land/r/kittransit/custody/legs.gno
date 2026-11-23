package custody

import (
	"sort"
	"strings"
)

// M03/M04 — Transfer legs: dispatch, cancellation, receiving deltas, closure,
// and linked reverse (return) legs.
//
// At most one active movement leg per kit. Dispatched units are reserved
// in-transit so the sender cannot spend them twice. The origin can never
// acknowledge for the destination. Accepted quantity is bounded by
// outstanding; missing reports never compound.

// Dispatch reserves held units of the sender org into an outbound leg to one
// named partner. expectedRev must equal the kit's current manifest revision;
// prevLeg must equal the kit's most recent leg (or "" for the first).
func Dispatch(cur realm, opID, kitID, destOrg string, expectedRev int64, prevLeg, qtys string) string {
	validID(kitID)
	validID(destOrg)
	k := mustKit(kitID)
	sender := signerOrg(cur)
	body := "kit=" + kitID + ";dest=" + destOrg + ";rev=" + itoa(expectedRev) + ";prev=" + prevLeg + ";qty=" + qtys
	if prev := opReplay(cur, sender, opID, "Dispatch", body); prev != nil {
		return replayResult(prev)
	}
	if destOrg == sender {
		panic("kittransit: destination is the sender")
	}
	if orgs[destOrg] == nil || !orgs[destOrg].Active {
		panic("kittransit: unknown destination " + destOrg)
	}
	if k.ActiveLeg != "" {
		panic("kittransit: kit already has an active leg")
	}
	if expectedRev != k.curManifest().Rev {
		panic("kittransit: stale manifest revision")
	}
	if prevLeg != lastLegID(kitID) {
		panic("kittransit: stale predecessor leg")
	}
	qty := parseQtyMap(qtys, false)
	if len(qty) == 0 {
		panic("kittransit: empty dispatch")
	}
	h := chainHeight()
	legID := nextID("leg")
	leg := &Leg{
		ID: legID, Kit: kitID, Kind: LegOutbound, Sender: sender, Dest: destOrg,
		ManifestRev: expectedRev, Prev: prevLeg, Qty: map[string]int64{},
		Accepted: map[string]int64{}, ClosedUnreceived: map[string]int64{},
		ReportedMissing: map[string]int64{}, Status: LegOpen, OpenH: h,
	}
	// Validate every line before any custody mutation (atomicity).
	for line, q := range qty {
		b := mustBal(kitID, line)
		if q > b.Held[sender] {
			panic("kittransit: insufficient held units for " + line)
		}
	}
	for line, q := range qty {
		b := mustBal(kitID, line)
		b.Held[sender] -= q
		b.Transit[legID] += q
		leg.Qty[line] = q
	}
	legs[legID] = leg
	k.ActiveLeg = legID
	k.Available = false
	k.Hold = true
	rev := bumpRev()
	emitEvent("dispatch", kitID, legID, "", sender, "dest="+destOrg+";rev="+itoa(expectedRev)+";qty="+canonQty(leg.Qty))
	op := opCommit(cur, sender, opID, "Dispatch", body, cur.Previous().Address().String(),
		`{"leg":`+jqs(legID)+`,"status":"open","height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

// CancelLeg releases the reservation back to the origin exactly once. It
// requires no signed destination observation (including an all-missing
// report) and no owner disposition.
func CancelLeg(cur realm, opID, legID string) string {
	leg := mustLeg(legID)
	mustCustodian(cur, leg.Sender)
	body := "leg=" + legID
	if prev := opReplay(cur, leg.Sender, opID, "CancelLeg", body); prev != nil {
		return replayResult(prev)
	}
	if leg.Status != LegOpen {
		panic("kittransit: leg not open")
	}
	if leg.Observed {
		panic("kittransit: destination already observed; cannot cancel")
	}
	if leg.OwnerDisposed {
		panic("kittransit: owner disposition recorded; cannot cancel")
	}
	for line, q := range leg.Qty {
		b := mustBal(leg.Kit, line)
		b.Transit[legID] -= q
		if b.Transit[legID] == 0 {
			delete(b.Transit, legID)
		}
		b.Held[leg.Sender] += q
	}
	leg.Status = LegCancelled
	leg.CloseH = chainHeight()
	kits[leg.Kit].ActiveLeg = ""
	h := leg.CloseH
	rev := bumpRev()
	emitEvent("cancel", leg.Kit, legID, "", leg.Sender, "")
	op := opCommit(cur, leg.Sender, opID, "CancelLeg", body, cur.Previous().Address().String(),
		`{"leg":`+jqs(legID)+`,"status":"cancelled","height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

// ReceiveDelta records a destination attestation. accepted/conds/missing are
// "line:qty" / "line:code" / "line:qty" semicolon lists. Codes: ok, damaged,
// disputed. A zero-accepted all-missing report still counts as a destination
// observation and blocks cancellation.
func ReceiveDelta(cur realm, opID, legID, accepted, conds, missing, reason string) string {
	leg := mustLeg(legID)
	if reason != "" {
		validReason(reason)
	}
	dest := leg.Dest
	mustCustodian(cur, dest)
	body := "leg=" + legID + ";acc=" + accepted + ";cond=" + conds + ";miss=" + missing + ";why=" + reason
	if prev := opReplay(cur, dest, opID, "ReceiveDelta", body); prev != nil {
		return replayResult(prev)
	}
	if leg.Status != LegOpen {
		panic("kittransit: leg not open")
	}
	acc := parseQtyMap(accepted, true)
	miss := parseQtyMap(missing, true)
	cond := parseCondMap(conds)
	for line, q := range acc {
		if _, ok := leg.Qty[line]; !ok {
			panic("kittransit: accepted unknown line " + line)
		}
		if q > leg.outstanding(line) {
			panic("kittransit: accepted exceeds outstanding for " + line)
		}
	}
	for line := range miss {
		if _, ok := leg.Qty[line]; !ok {
			panic("kittransit: missing report for unknown line " + line)
		}
	}
	for line, code := range cond {
		if _, ok := leg.Qty[line]; !ok {
			panic("kittransit: condition for unknown line " + line)
		}
		_ = code
	}
	h := chainHeight()
	for line, q := range acc {
		if q == 0 {
			continue
		}
		leg.Accepted[line] += q
		b := mustBal(leg.Kit, line)
		b.Transit[legID] -= q
		if b.Transit[legID] == 0 {
			delete(b.Transit, legID)
		}
		b.Held[dest] += q
		kits[leg.Kit].NeedsAssessment = true
	}
	for line, code := range cond {
		if code == "damaged" || code == "disputed" {
			openExc(leg, line, code, leg.Accepted[line], reason, dest)
		}
	}
	for line, q := range miss {
		if q <= leg.ReportedMissing[line] {
			continue // same-line missing reports do not compound
		}
		leg.ReportedMissing[line] = q
		openExcQty(leg, line, ExcMissing, q, reason, dest)
	}
	leg.Observed = true
	rev := bumpRev()
	emitEvent("receive", leg.Kit, legID, "", dest,
		"acc="+canonQty(acc)+";miss="+canonQty(miss)+";cond="+canonCond(cond))
	op := opCommit(cur, dest, opID, "ReceiveDelta", body, cur.Previous().Address().String(),
		`{"leg":`+jqs(legID)+`,"accepted":`+jmap(acc)+`,"height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

// CloseLeg ends an open leg when every line's outstanding is zero.
func CloseLeg(cur realm, opID, legID string) string {
	leg := mustLeg(legID)
	org := signerOrg(cur)
	if org != leg.Sender && org != leg.Dest {
		panic("kittransit: only leg parties may close")
	}
	body := "leg=" + legID
	if prev := opReplay(cur, org, opID, "CloseLeg", body); prev != nil {
		return replayResult(prev)
	}
	if leg.Status != LegOpen {
		panic("kittransit: leg not open")
	}
	if leg.anyOutstanding() {
		panic("kittransit: outstanding quantities remain")
	}
	leg.Status = LegClosed
	leg.CloseH = chainHeight()
	kits[leg.Kit].ActiveLeg = ""
	h := leg.CloseH
	rev := bumpRev()
	emitEvent("close", leg.Kit, legID, "", org, "")
	op := opCommit(cur, org, opID, "CloseLeg", body, cur.Previous().Address().String(),
		`{"leg":`+jqs(legID)+`,"status":"closed","height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

// StartReturn raises a linked reverse leg for material the caller's org
// actually holds, back to the kit owner. The outbound leg must be closed.
func StartReturn(cur realm, opID, kitID, qtys string) string {
	validID(kitID)
	k := mustKit(kitID)
	sender := signerOrg(cur)
	if sender == k.Owner {
		panic("kittransit: owner does not return to itself")
	}
	body := "kit=" + kitID + ";qty=" + qtys
	if prev := opReplay(cur, sender, opID, "StartReturn", body); prev != nil {
		return replayResult(prev)
	}
	if k.ActiveLeg != "" {
		panic("kittransit: kit already has an active leg")
	}
	prevLeg := lastLegID(kitID)
	if prevLeg == "" || legs[prevLeg].Kind != LegOutbound || legs[prevLeg].Status != LegClosed {
		panic("kittransit: requires a closed outbound leg")
	}
	qty := parseQtyMap(qtys, false)
	if len(qty) == 0 {
		panic("kittransit: empty return")
	}
	h := chainHeight()
	legID := nextID("leg")
	leg := &Leg{
		ID: legID, Kit: kitID, Kind: LegReturn, Sender: sender, Dest: k.Owner,
		ManifestRev: k.curManifest().Rev, Prev: prevLeg, Qty: map[string]int64{},
		Accepted: map[string]int64{}, ClosedUnreceived: map[string]int64{},
		ReportedMissing: map[string]int64{}, Status: LegOpen, OpenH: h,
	}
	for line, q := range qty {
		b := mustBal(kitID, line)
		if q > b.Held[sender] {
			panic("kittransit: insufficient held units for " + line)
		}
	}
	for line, q := range qty {
		b := mustBal(kitID, line)
		b.Held[sender] -= q
		b.Transit[legID] += q
		leg.Qty[line] = q
	}
	legs[legID] = leg
	k.ActiveLeg = legID
	k.Hold = true
	rev := bumpRev()
	emitEvent("return-start", kitID, legID, "", sender, "qty="+canonQty(leg.Qty))
	op := opCommit(cur, sender, opID, "StartReturn", body, cur.Previous().Address().String(),
		`{"leg":`+jqs(legID)+`,"kind":"return","status":"open","height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

func lastLegID(kitID string) string {
	best := ""
	var bestSeq int64
	for _, l := range legs {
		if l.Kit == kitID {
			// leg ids are "leg-N"; use insertion order via seq encoded in id
			if seqOf(l.ID) > bestSeq {
				bestSeq = seqOf(l.ID)
				best = l.ID
			}
		}
	}
	return best
}

func seqOf(id string) int64 {
	for i := len(id) - 1; i >= 0; i-- {
		if id[i] == '-' {
			return atoi(id[i+1:])
		}
	}
	return 0
}

func openExc(leg *Leg, line, kind string, qty int64, reason, by string) *Exc {
	return openExcQty(leg, line, kind, qty, reason, by)
}

func openExcQty(leg *Leg, line, kind string, qty int64, reason, by string) *Exc {
	// One open exception per (leg, line, kind): a repeat report updates the
	// quantity ceiling instead of compounding.
	for _, e := range excs {
		if e.Leg == leg.ID && e.Line == line && e.Kind == kind && e.Status == ExcOpen {
			if qty > e.Qty {
				e.Qty = qty
			}
			return e
		}
	}
	id := nextID("exc")
	e := &Exc{
		ID: id, Kit: leg.Kit, Leg: leg.ID, Line: line, Kind: kind,
		Qty: qty, Status: ExcOpen, Reason: reason, By: by, OpenH: chainHeight(),
	}
	excs[id] = e
	kits[leg.Kit].Hold = true
	emitEvent("exception", leg.Kit, leg.ID, line, by, "kind="+kind+";qty="+itoa(qty))
	return e
}

func parseCondMap(s string) map[string]string {
	out := map[string]string{}
	if s == "" {
		return out
	}
	for _, pair := range splitSemi(s) {
		parts := split2(pair, ":")
		validID(parts[0])
		c := parts[1]
		if c != "ok" && c != "damaged" && c != "disputed" {
			panic("kittransit: unknown condition code " + c)
		}
		if _, dup := out[parts[0]]; dup {
			panic("kittransit: duplicate condition line")
		}
		out[parts[0]] = c
	}
	return out
}

func canonCond(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortStrings(keys)
	out := ""
	for i, k := range keys {
		if i > 0 {
			out += ";"
		}
		out += k + ":" + m[k]
	}
	return out
}

func splitSemi(s string) []string {
	return strings.Split(s, ";")
}

func split2(s, sep string) []string {
	p := strings.Split(s, sep)
	if len(p) != 2 {
		panic("kittransit: bad pair " + s)
	}
	return p
}

func sortStrings(x []string) { sort.Strings(x) }
