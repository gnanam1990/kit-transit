package custody

// M05 — Return, assessment and exceptions.
//
// Owner-only dispositions close missing units into unlocated; found-unit
// recovery is claim + co-confirm; assessment and release decide availability.
// An open exception can survive the end of physical movement. Writing off a
// lens does not clear the kit (INV-05).

// ResolveException applies an owner disposition to an open exception.
// disposition: "close-unreceived" | "resolved" | "disputed".
// close-unreceived moves the line's remaining outstanding quantity on the
// source leg from in-transit to unlocated.
func ResolveException(cur realm, opID, excID, disposition, reason string) string {
	validID(excID)
	validReason(reason)
	e := excs[excID]
	if e == nil {
		panic("kittransit: unknown exception " + excID)
	}
	k := mustKit(e.Kit)
	mustAssessor(cur, k.Owner)
	body := "exc=" + excID + ";disp=" + disposition + ";why=" + reason
	if prev := opReplay(cur, k.Owner, opID, "ResolveException", body); prev != nil {
		return replayResult(prev)
	}
	if e.Status != ExcOpen {
		panic("kittransit: exception already closed")
	}
	switch disposition {
	case "close-unreceived":
		leg := mustLeg(e.Leg)
		out := leg.outstanding(e.Line)
		move := e.Qty
		if move > out {
			move = out
		}
		if move <= 0 {
			panic("kittransit: nothing outstanding to close")
		}
		b := mustBal(e.Kit, e.Line)
		b.Transit[leg.ID] -= move
		if b.Transit[leg.ID] == 0 {
			delete(b.Transit, leg.ID)
		}
		b.Unlocated += move
		leg.ClosedUnreceived[e.Line] += move
		leg.OwnerDisposed = true
	case "resolved":
		// Material reconciled through another path; no balance mutation.
	case "disputed":
		e.Kind = ExcDisputed
	default:
		panic("kittransit: unknown disposition " + disposition)
	}
	e.Status = ExcClosed
	e.CloseH = chainHeight()
	rev := bumpRev()
	emitEvent("exception-resolve", e.Kit, e.Leg, e.Line, k.Owner, "disp="+disposition)
	op := opCommit(cur, k.Owner, opID, "ResolveException", body, cur.Previous().Address().String(),
		`{"exception":`+jqs(excID)+`,"disposition":`+jqs(disposition)+`,"height":`+itoa(e.CloseH)+`}`)
	op.Rev = rev
	return op.Result
}

// ReportFound records a partner's found-unit claim linked to the unlocated
// source leg. No balance mutation yet. A sighting of permanently retired
// physical stock creates only a discrepancy report.
func ReportFound(cur realm, opID, kitID, lineID string, qty int64, sourceLeg string) string {
	validID(kitID)
	validID(lineID)
	validID(sourceLeg)
	mustKit(kitID)
	finder := signerOrg(cur)
	body := "kit=" + kitID + ";line=" + lineID + ";qty=" + itoa(qty) + ";src=" + sourceLeg
	if prev := opReplay(cur, finder, opID, "ReportFound", body); prev != nil {
		return replayResult(prev)
	}
	if qty <= 0 || qty > MaxQtyPerLine {
		panic("kittransit: qty out of bounds")
	}
	b := mustBal(kitID, lineID)
	status := ClaimOpen
	// The unlocated balance must cover the claim unless the sighting refers
	// to permanently retired stock, which is report-only.
	if b.Unlocated < qty {
		status = ClaimDiscrepancy
	}
	id := nextID("claim")
	claims[id] = &Claim{
		ID: id, Kit: kitID, Line: lineID, Finder: finder, Qty: qty,
		SourceLeg: sourceLeg, Status: status, Height: chainHeight(),
		Reporter: cur.Previous().Address().String(),
	}
	rev := bumpRev()
	emitEvent("found-report", kitID, sourceLeg, lineID, finder, "qty="+itoa(qty)+";status="+status)
	op := opCommit(cur, finder, opID, "ReportFound", body, cur.Previous().Address().String(),
		`{"claim":`+jqs(id)+`,"status":`+jqs(status)+`}`)
	op.Rev = rev
	return op.Result
}

// ConfirmRecovery co-signs a found claim. Owner validates identity; for a
// finder that is the owner itself a second authorized desk must confirm
// (enforced by requiring a different signer than the claim reporter).
// Atomically debits the unlocated balance and credits the attested holder —
// or quarantines a recovered unit whose manifest requirement was retired.
// Retired-physical sightings only produce a discrepancy report.
func ConfirmRecovery(cur realm, opID, claimID string) string {
	validID(claimID)
	cl := claims[claimID]
	if cl == nil {
		panic("kittransit: unknown claim " + claimID)
	}
	k := mustKit(cl.Kit)
	confirmer := mustOrgRole(cur, k.Owner, RoleAssessor)
	body := "claim=" + claimID
	if prev := opReplay(cur, k.Owner, opID, "ConfirmRecovery", body); prev != nil {
		return replayResult(prev)
	}
	switch cl.Status {
	case ClaimDiscrepancy:
		panic("kittransit: permanently retired stock is report-only")
	case ClaimOpen:
	default:
		panic("kittransit: claim already resolved")
	}
	if cl.Finder == k.Owner && confirmer == cl.Reporter {
		panic("kittransit: owner-found items need a second desk")
	}
	b := mustBal(cl.Kit, cl.Line)
	h := chainHeight()
	if !lineRequired(k, cl.Line) {
		// Requirement retired: recovered unit goes to quarantine.
		b.Unlocated -= cl.Qty
		b.Quarantine += cl.Qty
		cl.Status = ClaimQuarantined
	} else {
		if b.Unlocated < cl.Qty {
			panic("kittransit: unlocated balance does not cover claim")
		}
		b.Unlocated -= cl.Qty
		b.Held[cl.Finder] += cl.Qty
		cl.Status = ClaimConfirmed
	}
	cl.ConfirmH = h
	cl.Confirmer = confirmer
	k.Hold = true
	rev := bumpRev()
	emitEvent("recover-confirm", cl.Kit, cl.SourceLeg, cl.Line, k.Owner, "claim="+claimID+";status="+cl.Status)
	op := opCommit(cur, k.Owner, opID, "ConfirmRecovery", body, confirmer,
		`{"claim":`+jqs(claimID)+`,"status":`+jqs(cl.Status)+`,"height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

// RejectRecovery documents a competing or conflicting claim. It never
// mutates balances; the claim stays visible for review.
func RejectRecovery(cur realm, opID, claimID, reason string) string {
	validID(claimID)
	validReason(reason)
	cl := claims[claimID]
	if cl == nil {
		panic("kittransit: unknown claim " + claimID)
	}
	k := mustKit(cl.Kit)
	mustAssessor(cur, k.Owner)
	body := "claim=" + claimID + ";why=" + reason
	if prev := opReplay(cur, k.Owner, opID, "RejectRecovery", body); prev != nil {
		return replayResult(prev)
	}
	if cl.Status != ClaimOpen {
		panic("kittransit: claim not open")
	}
	cl.Status = ClaimRejected
	rev := bumpRev()
	emitEvent("recover-reject", cl.Kit, cl.SourceLeg, cl.Line, k.Owner, "claim="+claimID)
	op := opCommit(cur, k.Owner, opID, "RejectRecovery", body, cur.Previous().Address().String(),
		`{"claim":`+jqs(claimID)+`,"status":"rejected"}`)
	op.Rev = rev
	return op.Result
}

// WriteOffUnit permanently retires physical stock out of owner holdings
// (terminal). The kit stays unavailable; a later sighting of this stock is
// report-only.
func WriteOffUnit(cur realm, opID, kitID, lineID string, qty int64, reason string) string {
	validID(kitID)
	validID(lineID)
	validReason(reason)
	k := mustKit(kitID)
	mustAssessor(cur, k.Owner)
	body := "kit=" + kitID + ";line=" + lineID + ";qty=" + itoa(qty) + ";why=" + reason
	if prev := opReplay(cur, k.Owner, opID, "WriteOffUnit", body); prev != nil {
		return replayResult(prev)
	}
	if qty <= 0 {
		panic("kittransit: qty out of bounds")
	}
	b := mustBal(kitID, lineID)
	if b.Held[k.Owner] < qty {
		panic("kittransit: owner does not hold that many units")
	}
	b.Held[k.Owner] -= qty
	b.Retired += qty
	k.Available = false
	k.Hold = true
	rev := bumpRev()
	emitEvent("writeoff", kitID, "", lineID, k.Owner, "qty="+itoa(qty)+";why="+reason)
	op := opCommit(cur, k.Owner, opID, "WriteOffUnit", body, cur.Previous().Address().String(),
		`{"kit":`+jqs(kitID)+`,"line":`+jqs(lineID)+`,"retired":`+itoa(b.Retired)+`}`)
	op.Rev = rev
	return op.Result
}

// AssessReturn records the owner's inspection outcome per line:
// "line:code" where code is serviceable|damaged|pending.
func AssessReturn(cur realm, opID, kitID, assessments string) string {
	validID(kitID)
	k := mustKit(kitID)
	mustAssessor(cur, k.Owner)
	body := "kit=" + kitID + ";asm=" + assessments
	if prev := opReplay(cur, k.Owner, opID, "AssessReturn", body); prev != nil {
		return replayResult(prev)
	}
	m := parseCondMap(assessments)
	h := chainHeight()
	for line, code := range m {
		b := mustBal(kitID, line)
		switch code {
		case "ok":
			b.Assessment = AssessServiceable
		case "damaged":
			b.Assessment = AssessDamaged
			openExcDirect(kitID, "", line, ExcDamaged, "post-return damage", k.Owner)
		case "disputed":
			b.Assessment = AssessPending
			openExcDirect(kitID, "", line, ExcDisputed, "assessment disputed", k.Owner)
		default:
			panic("kittransit: bad assessment code")
		}
		b.AssessHeight = h
	}
	stillPending := false
	for _, line := range k.requiredLines() {
		if mustBal(kitID, line).Assessment != AssessServiceable {
			stillPending = true
		}
	}
	k.NeedsAssessment = stillPending
	rev := bumpRev()
	emitEvent("assess", kitID, "", "", k.Owner, "asm="+assessments)
	op := opCommit(cur, k.Owner, opID, "AssessReturn", body, cur.Previous().Address().String(),
		`{"kit":`+jqs(kitID)+`,"height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

// ReleaseKit clears the availability hold. Requires owner holds every
// required count for the active manifest, all required lines assessed
// serviceable, no active leg and no open exceptions.
func ReleaseKit(cur realm, opID, kitID string) string {
	validID(kitID)
	k := mustKit(kitID)
	mustAssessor(cur, k.Owner)
	body := "kit=" + kitID
	if prev := opReplay(cur, k.Owner, opID, "ReleaseKit", body); prev != nil {
		return replayResult(prev)
	}
	if k.ActiveLeg != "" {
		panic("kittransit: active leg blocks release")
	}
	m := k.curManifest()
	for _, ln := range m.Lines {
		b := mustBal(kitID, ln.ID)
		if b.Held[k.Owner] < ln.Qty {
			panic("kittransit: owner does not hold required count for " + ln.ID)
		}
		if b.Assessment != AssessServiceable {
			panic("kittransit: line not assessed serviceable: " + ln.ID)
		}
	}
	for _, e := range excs {
		if e.Kit == kitID && e.Status == ExcOpen {
			panic("kittransit: open exception " + e.ID + " blocks release")
		}
	}
	k.Available = true
	k.Hold = false
	k.NeedsAssessment = false
	h := chainHeight()
	rev := bumpRev()
	emitEvent("release", kitID, "", "", k.Owner, "")
	op := opCommit(cur, k.Owner, opID, "ReleaseKit", body, cur.Previous().Address().String(),
		`{"kit":`+jqs(kitID)+`,"available":true,"height":`+itoa(h)+`}`)
	op.Rev = rev
	return op.Result
}

func lineRequired(k *Kit, lineID string) bool {
	for _, ln := range k.curManifest().Lines {
		if ln.ID == lineID && ln.Qty > 0 {
			return true
		}
	}
	return false
}

func openExcDirect(kitID, legID, line, kind, reason, by string) *Exc {
	for _, e := range excs {
		if e.Kit == kitID && e.Leg == legID && e.Line == line && e.Kind == kind && e.Status == ExcOpen {
			return e
		}
	}
	id := nextID("exc")
	e := &Exc{
		ID: id, Kit: kitID, Leg: legID, Line: line, Kind: kind,
		Qty: 1, Status: ExcOpen, Reason: reason, By: by, OpenH: chainHeight(),
	}
	excs[id] = e
	kits[kitID].Hold = true
	emitEvent("exception", kitID, legID, line, by, "kind="+kind)
	return e
}
