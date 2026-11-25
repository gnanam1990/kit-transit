package custody

// Kit Transit custody realm.
//
// Trust model: every mutating entry point takes `cur realm` and authorizes the
// actual chain-verified signer via cur.Previous(). Address parameters are never
// trusted for identity. Roles are scoped per organization. All quantities are
// bounded nonnegative integers; every originally issued unit lives in exactly
// one bucket: held by one org, in-transit on one open leg, unlocated,
// quarantined, or permanently retired.

const (
	RoleAdmin     = "admin"
	RoleCustodian = "custodian"
	RoleAssessor  = "assessor"

	LegOutbound = "outbound"
	LegReturn   = "return"

	LegOpen      = "open"
	LegClosed    = "closed"
	LegCancelled = "cancelled"

	ExcMissing     = "missing"
	ExcDamaged     = "damaged"
	ExcDisputed    = "disputed"
	ExcDiscrepancy = "discrepancy"

	ExcOpen   = "open"
	ExcClosed = "closed"

	AssessNone        = "none"
	AssessPending     = "pending"
	AssessServiceable = "serviceable"
	AssessDamaged     = "damaged"

	ClaimOpen        = "open"
	ClaimConfirmed   = "confirmed"
	ClaimRejected    = "rejected"
	ClaimQuarantined = "quarantined"
	ClaimDiscrepancy = "discrepancy"

	// Bound payload limits (NFR-03). Chosen well inside measured local gas.
	MaxLinesPerManifest = 64
	MaxQtyPerLine       = 1000
	MaxIDLen            = 96
	MaxReasonLen        = 64
	maxGetEvents        = 200
)

type Org struct {
	ID     string
	Active bool
	Height int64
}

type Grant struct {
	OrgID   string
	Addr    string // bech32 signer address
	Role    string
	Active  bool
	Granted int64
	Revoked int64
}

// LineSpec is one required component line of a manifest revision.
// Label is a nonpersonal public display label only; private barcodes never
// enter this realm (INV-08).
type LineSpec struct {
	ID         string
	Label      string
	Qty        int64
	Serialized bool
	Unit       string
}

// Manifest is one immutable version. Dispatch binds exactly one revision.
type Manifest struct {
	Rev    int64
	Parent string // parent digest, "" for rev 1
	Digest string
	Policy string
	Lines  []LineSpec // sorted by ID
	Height int64
	By     string // owner org
}

type Kit struct {
	ID              string
	Owner           string
	Manifests       []*Manifest
	ActiveLeg       string
	Available       bool
	Hold            bool // availability hold
	NeedsAssessment bool
}

// LineBal tracks the conserved buckets for one (kit, line) pair.
// Invariant: Issued == held-total + transit-total + Unlocated + Quarantine + Retired.
type LineBal struct {
	Issued       int64
	Held         map[string]int64 // orgID -> qty
	Transit      map[string]int64 // legID -> qty
	Unlocated    int64
	Quarantine   int64
	Retired      int64 // terminal physical retirement
	ReqRetired   bool  // manifest requirement retired by a later revision
	Assessment   string
	AssessHeight int64
}

type Leg struct {
	ID               string
	Kit              string
	Kind             string
	Sender           string
	Dest             string
	ManifestRev      int64
	Prev             string // predecessor leg id, "" if none
	Qty              map[string]int64 // dispatched per line
	Accepted         map[string]int64
	ClosedUnreceived map[string]int64
	ReportedMissing  map[string]int64 // reported once; never compounds
	Observed         bool             // any destination observation recorded
	OwnerDisposed    bool             // any owner disposition recorded
	Status           string
	OpenH            int64
	CloseH           int64
}

type Exc struct {
	ID     string
	Kit    string
	Leg    string
	Line   string
	Kind   string
	Qty    int64
	Status string
	Reason string
	By     string
	OpenH  int64
	CloseH int64
}

type Claim struct {
	ID        string
	Kit       string
	Line      string
	Finder    string
	Qty       int64
	SourceLeg string
	Status    string
	Height    int64
	ConfirmH  int64
	Confirmer string
	Reporter  string
}

type Op struct {
	Org    string
	ID     string
	Kind   string
	Digest string
	Height int64
	Rev    int64
	Result string
	Signer string
}

// Event is the deterministic append-only feed the indexer replays.
type Event struct {
	Seq    int64
	Height int64
	Kind   string
	Kit    string
	Leg    string
	Line   string
	Org    string
	Data   string // canonical "k=v;..." extra fields
}
