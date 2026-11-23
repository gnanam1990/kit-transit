-- Kit Transit durable SQL projection (PostgreSQL).
-- The indexer commits projection rows, the checkpoint and catalogue outbox
-- entries in ONE transaction per event page (INV-07, T-019/T-021).

CREATE TABLE IF NOT EXISTS checkpoint (
    id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    network       TEXT NOT NULL,            -- node_info.network
    chain_id      TEXT NOT NULL,            -- runtime chain id from realm events feed
    realm         TEXT NOT NULL,            -- gno.land/r/kittransit/custody
    epoch         TEXT NOT NULL,            -- chain_id + genesis identity observed at first connect
    height        BIGINT NOT NULL DEFAULT 0,
    last_seq      BIGINT NOT NULL DEFAULT 0,
    feed_hash     TEXT NOT NULL DEFAULT '', -- sha256 over applied feed rows
    suspended     BOOLEAN NOT NULL DEFAULT FALSE,
    suspend_reason TEXT NOT NULL DEFAULT '',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS epoch_evidence (
    id          BIGSERIAL PRIMARY KEY,
    epoch       TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason      TEXT NOT NULL,
    snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS realm_events (
    seq     BIGINT PRIMARY KEY,
    height  BIGINT NOT NULL,
    kind    TEXT NOT NULL,
    kit     TEXT NOT NULL,
    leg     TEXT NOT NULL,
    line    TEXT NOT NULL,
    org     TEXT NOT NULL,
    data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS realm_events_kit ON realm_events (kit);
CREATE INDEX IF NOT EXISTS realm_events_height ON realm_events (height);

CREATE TABLE IF NOT EXISTS proj_orgs (
    org_id  TEXT PRIMARY KEY,
    active  BOOLEAN NOT NULL,
    height  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS proj_grants (
    org_id  TEXT NOT NULL,
    addr    TEXT NOT NULL,
    role    TEXT NOT NULL,
    active  BOOLEAN NOT NULL,
    granted BIGINT NOT NULL,
    revoked BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, addr, role)
);

CREATE TABLE IF NOT EXISTS proj_kits (
    kit_id          TEXT PRIMARY KEY,
    owner           TEXT NOT NULL,
    manifest_rev    BIGINT NOT NULL,
    manifest_digest TEXT NOT NULL,
    active_leg      TEXT NOT NULL DEFAULT '',
    available       BOOLEAN NOT NULL DEFAULT FALSE,
    hold            BOOLEAN NOT NULL DEFAULT TRUE,
    needs_assessment BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS proj_lines (
    kit_id      TEXT NOT NULL,
    line_id     TEXT NOT NULL,
    issued      BIGINT NOT NULL,
    held        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- org -> qty
    transit_total BIGINT NOT NULL DEFAULT 0,
    unlocated   BIGINT NOT NULL DEFAULT 0,
    quarantine  BIGINT NOT NULL DEFAULT 0,
    retired     BIGINT NOT NULL DEFAULT 0,
    assessment  TEXT NOT NULL DEFAULT 'none',
    PRIMARY KEY (kit_id, line_id)
);

CREATE TABLE IF NOT EXISTS proj_legs (
    leg_id      TEXT PRIMARY KEY,
    kit         TEXT NOT NULL,
    kind        TEXT NOT NULL,
    sender      TEXT NOT NULL,
    dest        TEXT NOT NULL,
    manifest_rev BIGINT NOT NULL,
    prev        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL,
    open_height BIGINT NOT NULL,
    close_height BIGINT NOT NULL DEFAULT 0,
    qty         JSONB NOT NULL DEFAULT '{}'::jsonb,
    accepted    JSONB NOT NULL DEFAULT '{}'::jsonb,
    missing     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS proj_exceptions (
    exc_id  TEXT PRIMARY KEY,
    kit     TEXT NOT NULL,
    leg     TEXT NOT NULL,
    line    TEXT NOT NULL,
    kind    TEXT NOT NULL,
    qty     BIGINT NOT NULL,
    reason  TEXT NOT NULL,
    status  TEXT NOT NULL,
    open_height  BIGINT NOT NULL,
    close_height BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proj_claims (
    claim_id TEXT PRIMARY KEY,
    kit      TEXT NOT NULL,
    line     TEXT NOT NULL,
    finder   TEXT NOT NULL,
    qty      BIGINT NOT NULL,
    source_leg TEXT NOT NULL,
    status   TEXT NOT NULL,
    height   BIGINT NOT NULL,
    confirm_height BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proj_ops (
    org_id  TEXT NOT NULL,
    op_id   TEXT NOT NULL,
    kind    TEXT NOT NULL,
    digest  TEXT NOT NULL,
    height  BIGINT NOT NULL,
    rev     BIGINT NOT NULL,
    signer  TEXT NOT NULL,
    result  JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (org_id, op_id)
);

-- Catalogue outbox: written in the SAME transaction as projection updates.
-- The catalogue bridge drains it; failures stay pending or manual_review
-- and never touch realm custody.
CREATE TABLE IF NOT EXISTS outbox (
    seq        BIGSERIAL PRIMARY KEY,
    kit_id     TEXT NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('HELD','AVAILABLE')),
    event_seq  BIGINT NOT NULL,
    height     BIGINT NOT NULL,
    version    BIGINT NOT NULL,          -- manifest rev at write time
    status     TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','conflict','manual_review')),
    attempts   INT NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedup ON outbox (kit_id, event_seq, state);

-- Signed-intent lifecycle for the staff desk (distinct draft / signature
-- request / broadcast / unknown / confirmed states).
CREATE TABLE IF NOT EXISTS cases (
    case_id    TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL,
    kind       TEXT NOT NULL,            -- dispatch | receive | resolve | ...
    kit_id     TEXT NOT NULL,
    op_id      TEXT NOT NULL,
    payload    JSONB NOT NULL,           -- allowlisted signing payload only
    nonce      TEXT NOT NULL,
    signer     TEXT NOT NULL,
    state      TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','signature-request','broadcast','unknown','confirmed','failed')),
    txhash     TEXT NOT NULL DEFAULT '',
    receipt    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    addr       TEXT NOT NULL,
    org_id     TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_addr ON sessions (addr);

-- Private evidence: objects on disk, ACL rows here. Every read re-checks
-- the session and the current grant — no reusable URLs ever.
CREATE TABLE IF NOT EXISTS evidence_objects (
    object_id  TEXT PRIMARY KEY,         -- sha256 of bytes
    case_id    TEXT NOT NULL,
    org_id     TEXT NOT NULL,            -- tenant scope
    mime       TEXT NOT NULL,
    bytes      BIGINT NOT NULL,
    sha256     TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_case ON evidence_objects (case_id, org_id);

-- Barcode collision quarantine (T-006): same-branch barcode bound to two
-- physical items parks the colliding import until explicit resolution.
CREATE TABLE IF NOT EXISTS barcode_quarantine (
    id         BIGSERIAL PRIMARY KEY,
    branch     TEXT NOT NULL,
    barcode    TEXT NOT NULL,
    item_ref   TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'quarantined'
                CHECK (status IN ('quarantined','resolved','rejected')),
    resolution TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS barcode_branch_bound
    ON barcode_quarantine (branch, barcode) WHERE status = 'quarantined';

CREATE TABLE IF NOT EXISTS catalogue_items (
    branch     TEXT NOT NULL,
    barcode    TEXT NOT NULL,
    item_ref   TEXT NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('HELD','AVAILABLE')),
    seq        BIGINT NOT NULL,          -- partner/import sequence
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (branch, barcode)
);
