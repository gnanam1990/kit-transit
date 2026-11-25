package custody

import (
	"chain"
	"chain/runtime"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
)

func chainHeight() int64 { return runtime.ChainHeight() }

func emit(typ string, attrs ...string) { chain.Emit(typ, attrs...) }

func itoa(i int64) string { return strconv.Itoa(int(i)) }

func atoi(s string) int64 {
	n, err := strconv.Atoi(s)
	if err != nil {
		panic("kittransit: bad integer " + s)
	}
	return int64(n)
}

// validID restricts all public identifiers to a JSON/CSV-safe charset so
// outputs need no escaping and malicious barcode text can never render.
func validID(s string) {
	if len(s) == 0 || len(s) > MaxIDLen {
		panic("kittransit: bad id length")
	}
	for _, c := range s {
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.'
		if !ok {
			panic("kittransit: bad id charset")
		}
	}
}

func validLabel(s string) {
	if len(s) == 0 || len(s) > 120 {
		panic("kittransit: bad label")
	}
	for _, c := range s {
		if c == '\n' || c == '\r' || c == ';' || c == ',' || c == ':' || c == '=' {
			panic("kittransit: bad label charset")
		}
	}
}

func validReason(s string) {
	if len(s) == 0 || len(s) > MaxReasonLen {
		panic("kittransit: bad reason")
	}
	for _, c := range s {
		if c == '\n' || c == '\r' || c == ';' {
			panic("kittransit: bad reason charset")
		}
	}
}

// sha256hex returns the lowercase hex SHA-256 of s.
func sha256hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// opDigest computes the canonical, domain-separated digest of an accepted
// intent: versioned encoding, chain, realm, kind, org, op and body fields.
func opDigest(cur realm, kind, org, opID, body string) string {
	return sha256hex("kittransit/op.v1\n" +
		"chain=" + runtime.ChainID() + "\n" +
		"realm=" + cur.PkgPath() + "\n" +
		"kind=" + kind + "\n" +
		"org=" + org + "\n" +
		"op=" + opID + "\n" +
		"body=" + body)
}

// parseQtyMap parses "line:qty;line:qty" into a map. Line ids are validated,
// qty is a bounded nonnegative integer, duplicate lines are rejected, and the
// result is always iterated in sorted order downstream.
func parseQtyMap(s string, allowZero bool) map[string]int64 {
	out := map[string]int64{}
	if strings.TrimSpace(s) == "" {
		return out
	}
	for _, pair := range strings.Split(s, ";") {
		parts := strings.Split(pair, ":")
		if len(parts) != 2 {
			panic("kittransit: bad qty entry " + pair)
		}
		id := strings.TrimSpace(parts[0])
		validID(id)
		if _, dup := out[id]; dup {
			panic("kittransit: duplicate line " + id)
		}
		q := atoi(parts[1])
		if q < 0 || (!allowZero && q == 0) || q > MaxQtyPerLine {
			panic("kittransit: qty out of bounds")
		}
		out[id] = q
	}
	return out
}

// canonQty serializes a qty map in sorted-key order.
func canonQty(m map[string]int64) string {
	keys := sortedKeys(m)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+":"+itoa(m[k]))
	}
	return strings.Join(parts, ";")
}

func sortedKeys(m map[string]int64) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// parseLines parses manifest lines:
// "id:qty:serialized(0|1):unit:label" entries joined by ";".
// Returned slice is sorted by line id; duplicates rejected.
func parseLines(s string) []LineSpec {
	lines := []LineSpec{}
	if strings.TrimSpace(s) == "" {
		panic("kittransit: manifest needs at least one line")
	}
	seen := map[string]bool{}
	for _, entry := range strings.Split(s, ";") {
		parts := strings.SplitN(entry, ":", 5)
		if len(parts) != 5 {
			panic("kittransit: bad manifest line " + entry)
		}
		ln := LineSpec{
			ID:         parts[0],
			Qty:        atoi(parts[1]),
			Serialized: parts[2] == "1",
			Unit:       parts[3],
			Label:      parts[4],
		}
		if parts[2] != "0" && parts[2] != "1" {
			panic("kittransit: serialized flag must be 0 or 1")
		}
		validID(ln.ID)
		validLabel(ln.Label)
		if ln.Unit == "" || strings.ContainsAny(ln.Unit, ";:,\n") {
			panic("kittransit: declared unit required")
		}
		if ln.Qty <= 0 || ln.Qty > MaxQtyPerLine {
			panic("kittransit: line qty out of bounds")
		}
		if ln.Serialized && ln.Qty != 1 {
			panic("kittransit: serialized lines have quantity one")
		}
		if seen[ln.ID] {
			panic("kittransit: duplicate line " + ln.ID)
		}
		seen[ln.ID] = true
		lines = append(lines, ln)
	}
	if len(lines) > MaxLinesPerManifest {
		panic("kittransit: manifest line cap exceeded")
	}
	sortLineSpecs(lines)
	return lines
}

// sortLineSpecs insertion-sorts manifest lines by ID (gno has no sort.Slice).
func sortLineSpecs(lines []LineSpec) {
	for i := 1; i < len(lines); i++ {
		for j := i; j > 0 && lines[j].ID < lines[j-1].ID; j-- {
			lines[j], lines[j-1] = lines[j-1], lines[j]
		}
	}
}

// canonLines is the canonical line encoding used in manifest digests.
func canonLines(lines []LineSpec) string {
	parts := make([]string, 0, len(lines))
	for _, l := range lines {
		ser := "0"
		if l.Serialized {
			ser = "1"
		}
		parts = append(parts, l.ID+":"+itoa(l.Qty)+":"+ser+":"+l.Unit+":"+l.Label)
	}
	return strings.Join(parts, ";")
}

func manifestDigest(kitID string, rev int64, parent, policy, linesCanon string) string {
	return sha256hex("kittransit/manifest.v1\n" +
		"kit=" + kitID + "\n" +
		"rev=" + itoa(rev) + "\n" +
		"parent=" + parent + "\n" +
		"policy=" + policy + "\n" +
		"lines=" + linesCanon)
}

// jqs quotes a string for JSON. Identifiers are charset-validated; labels and
// policies get a minimal escape anyway for defense in depth.
func jqs(s string) string {
	r := strings.NewReplacer(
		"\\", "\\\\",
		"\"", "\\\"",
		"\n", "\\n",
		"\r", "\\r",
		"\t", "\\t",
	)
	return "\"" + r.Replace(s) + "\""
}

func jmap(m map[string]int64) string {
	parts := []string{}
	for _, k := range sortedKeys(m) {
		parts = append(parts, jqs(k)+":"+itoa(m[k]))
	}
	return "{" + strings.Join(parts, ",") + "}"
}
