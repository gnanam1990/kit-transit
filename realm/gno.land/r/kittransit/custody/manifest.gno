package custody

import "strings"

// M02 — Component manifests.
//
// Versioned manifests with stable public component IDs, display labels,
// condition policy and expected quantities. Initial inventory issuance is
// owner-only and replay-resistant: it credits owner-held stock exactly once
// (DefineManifest's operation record). Amendments create a new revision;
// in-flight legs keep their bound revision (INV-02).

// DefineManifest creates a kit and issues its initial inventory to the
// calling owner org. lines: "id:qty:serialized:unit:label;...".
func DefineManifest(cur realm, opID, kitID, lines, policy string) string {
	validID(kitID)
	if len(policy) > 200 || strings.ContainsAny(policy, "\n\r;") {
		panic("kittransit: bad condition policy")
	}
	owner := signerOrg(cur)
	body := "kit=" + kitID + ";lines=" + lines + ";policy=" + policy
	if prev := opReplay(cur, owner, opID, "DefineManifest", body); prev != nil {
		return replayResult(prev)
	}
	if kits[kitID] != nil {
		panic("kittransit: kit exists " + kitID)
	}
	spec := parseLines(lines)
	digest := manifestDigest(kitID, 1, "", policy, canonLines(spec))
	h := chainHeight()
	k := &Kit{ID: kitID, Owner: owner, Hold: true}
	k.Manifests = append(k.Manifests, &Manifest{
		Rev: 1, Digest: digest, Policy: policy, Lines: spec, Height: h, By: owner,
	})
	kits[kitID] = k
	for _, ln := range spec {
		b := &LineBal{
			Issued:     ln.Qty,
			Held:       map[string]int64{owner: ln.Qty},
			Transit:    map[string]int64{},
			Assessment: AssessNone,
		}
		bals[balKey(kitID, ln.ID)] = b
	}
	rev := bumpRev()
	emitEvent("manifest-define", kitID, "", "", owner, "rev=1;digest="+digest)
	op := opCommit(cur, owner, opID, "DefineManifest", body, cur.Previous().Address().String(),
		`{"kit":`+jqs(kitID)+`,"rev":1,"digest":`+jqs(digest)+`}`)
	op.Rev = rev
	return op.Result
}

// AmendManifest adds a new immutable revision. In-flight legs keep the
// revision they were dispatched with. Lines absent from the new revision are
// retired requirements: outstanding physical units stay unlocated until
// resolved, and a later sighting goes to quarantine.
func AmendManifest(cur realm, opID, kitID, lines, policy string) string {
	validID(kitID)
	k := mustKit(kitID)
	mustOrgRole(cur, k.Owner, RoleCustodian)
	body := "kit=" + kitID + ";lines=" + lines + ";policy=" + policy
	if prev := opReplay(cur, k.Owner, opID, "AmendManifest", body); prev != nil {
		return replayResult(prev)
	}
	spec := parseLines(lines)
	prev := k.curManifest()
	rev := prev.Rev + 1
	digest := manifestDigest(kitID, rev, prev.Digest, policy, canonLines(spec))
	h := chainHeight()
	k.Manifests = append(k.Manifests, &Manifest{
		Rev: rev, Parent: prev.Digest, Digest: digest, Policy: policy, Lines: spec, Height: h, By: k.Owner,
	})
	// New required lines get zero-initialized balance buckets. Stock for them
	// can only arrive via IssueReplacement — an ordinary edit cannot create it.
	for _, ln := range spec {
		if bals[balKey(kitID, ln.ID)] == nil {
			bals[balKey(kitID, ln.ID)] = &LineBal{
				Held: map[string]int64{}, Transit: map[string]int64{},
			}
		}
	}
	r := bumpRev()
	emitEvent("manifest-amend", kitID, "", "", k.Owner, "rev="+itoa(rev)+";digest="+digest)
	op := opCommit(cur, k.Owner, opID, "AmendManifest", body, cur.Previous().Address().String(),
		`{"kit":`+jqs(kitID)+`,"rev":`+itoa(rev)+`,"digest":`+jqs(digest)+`}`)
	op.Rev = r
	return op.Result
}

// IssueReplacement adds explicitly issued replacement stock linked to a
// retired requirement (linkRef records the superseded line/leg). Owner only;
// replay-resistant via the operation record.
func IssueReplacement(cur realm, opID, kitID, lineID string, qty int64, linkRef string) string {
	validID(kitID)
	validID(lineID)
	validReason(linkRef)
	k := mustKit(kitID)
	mustOrgRole(cur, k.Owner, RoleCustodian)
	body := "kit=" + kitID + ";line=" + lineID + ";qty=" + itoa(qty) + ";ref=" + linkRef
	if prev := opReplay(cur, k.Owner, opID, "IssueReplacement", body); prev != nil {
		return replayResult(prev)
	}
	if qty <= 0 || qty > MaxQtyPerLine {
		panic("kittransit: qty out of bounds")
	}
	b := mustBal(kitID, lineID)
	b.Issued += qty
	b.Held[k.Owner] += qty
	r := bumpRev()
	emitEvent("issue-replacement", kitID, "", lineID, k.Owner, "qty="+itoa(qty)+";ref="+linkRef)
	op := opCommit(cur, k.Owner, opID, "IssueReplacement", body, cur.Previous().Address().String(),
		`{"kit":`+jqs(kitID)+`,"line":`+jqs(lineID)+`,"issued":`+itoa(b.Issued)+`}`)
	op.Rev = r
	return op.Result
}

// signerOrg resolves the org the current caller is bound to and asserts the
// custodian role inside it.
func signerOrg(cur realm) string {
	c := signerAddr(cur)
	org := orgOfAddr(c)
	if org == "" {
		panic("kittransit: signer is not bound to any org")
	}
	if !hasRole(org, c, RoleCustodian) {
		panic("kittransit: signer lacks custodian in " + org)
	}
	return org
}
