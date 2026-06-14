-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0006 · connector_schemas · connections(+trust_level) · identity_map · ingestion_log · Issue #7      ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- The ingestion/identity substrate (§5, §4.10). EXPAND/CONTRACT: additive (new tables).
--
-- TYPE NOTE: `ingestion_log` aligns 1:1 with @aios/shared `IngestionDecision`. The other three are DB-only
-- for now — their consuming issues add the @aios/shared type as they build, so the drift test gains a
-- type↔Drizzle leg then: connector_schemas/connections → #20 (connectors), identity_map → #16 (resolution).

-- ── connector_schemas ── Gate-2 registry: the deterministic "is there a live field for this?" lookup (§5).
-- Fed/refreshed by the schema-drift cron (#21). Versioned so a drift is an ADD, not an overwrite.
CREATE TABLE IF NOT EXISTS connector_schemas (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type text        NOT NULL,                 -- 'gmail' | 'hubspot' | 'gdrive' | … (NOT a client name)
  version        text        NOT NULL,                 -- schema version/fingerprint; drift bumps this
  schema         jsonb       NOT NULL,                 -- the fetched field map (refs/shape, not row content)
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_type, version)
);

-- ── connections ── org- or user-scoped. trust_level is LOAD-BEARING: stamped onto Provenance.trustLevel at
-- routing time (#17), which gates promotion to semantic memory (anti-poisoning, §5/§10.1).
CREATE TABLE IF NOT EXISTS connections (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type text        NOT NULL,
  scope          text        NOT NULL DEFAULT 'org' CHECK (scope IN ('org', 'user')),
  owner_id       text,                                 -- NULL for org connections; the user id for user-scoped
  trust_level    text        NOT NULL CHECK (trust_level IN ('high', 'low')),  -- → Provenance.trustLevel (§10.1)
  structured     boolean     NOT NULL,                 -- structured (SoR/API) vs unstructured (docs/email)
  live           boolean     NOT NULL,                 -- live-fetchable (Gate 2) vs interpretive-only
  config         jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- refs/settings ONLY — secrets live in the vault, never here
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- A user-scoped connection must declare its owner; an org one must not. Fail-closed on a mis-scoped row
-- (a user connection with no owner would leak across users; an org one with an owner is ambiguous).
ALTER TABLE connections
  ADD CONSTRAINT connections_owner_matches_scope CHECK (
    (scope = 'user' AND owner_id IS NOT NULL) OR (scope = 'org' AND owner_id IS NULL)
  );

-- ── identity_map ── canonical entity ⇄ per-SoR external ids (§4.10). One row per (SoR, external id); rows
-- sharing canonical_id are the same real-world entity. confidence is stamped on resolution writes (#16).
CREATE TABLE IF NOT EXISTS identity_map (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id   uuid        NOT NULL,                 -- groups all external ids for one entity
  connector_type text        NOT NULL,                 -- the SoR this external id lives in
  external_id    text        NOT NULL,                 -- the id within that SoR
  entity_type    text,                                 -- 'person' | 'org' | 'deal' | … (nullable until classified)
  confidence     double precision,                     -- resolution confidence (§4.10; below floor → abstain, #16)
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_type, external_id)
);
CREATE INDEX IF NOT EXISTS identity_map_canonical ON identity_map (canonical_id);

-- ── ingestion_log ── every gate decision: refs + confidence, NEVER content (§5, §11.10). = IngestionDecision.
CREATE TABLE IF NOT EXISTS ingestion_log (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_ref            text        NOT NULL,          -- a reference to the source, not the source body
  content_hash          text        NOT NULL,
  connector_type        text        NOT NULL,
  decision              text        NOT NULL CHECK (decision IN
                          ('drop', 'fetch-live', 'review', 'index-in-place', 'write-memory', 'write-both')),
  classifier_confidence double precision,              -- for the sampled false-drop audit (§11.8); nullable
  decided_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingestion_log_content_hash ON ingestion_log (content_hash);
