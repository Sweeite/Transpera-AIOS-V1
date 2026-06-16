-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0014 · namespace authorization + keyword (FTS) leg · Issue #13 · Brief §9.1, §4.7                   ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- #13 closes the retrieval leak ATOMICALLY (zone + sensitivity + namespace) and adds the keyword leg of the
-- hybrid (dense + keyword, RRF-fused) search. This migration is the schema substrate for both.
--
-- EXPAND/CONTRACT (tech-stack §5.4): purely additive — ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- The shared image tolerates schema N-1 (old code ignores the new columns) and N side by side.
--
-- ── (1) NAMESPACE AUTHORIZATION — the third fail-closed axis (#13 absorbs this; nothing else owned it) ──────
-- Symmetric with allowed_zones (0009): which namespaces the principal MAY see. NO DEFAULT — force-explicit,
-- mirroring allowed_zones' posture: provisioning must set it deliberately. Existing rows (provisioned before
-- #13) get NULL ⇒ getClearance maps NULL→[] ⇒ denyAll (FAIL-CLOSED: a pre-#13 user sees nothing on the
-- namespace axis until reprovisioned). This is the conscious choice over DEFAULT '{}' — an absent value must
-- read as "unprovisioned ⇒ deny", never as a silent empty grant. (NB authorization, not RESOLUTION: the
-- Identity Map #16/M3 later narrows a query to specific namespaces; #13 searches the full authorized set.)
ALTER TABLE user_clearance
  ADD COLUMN IF NOT EXISTS allowed_namespaces text[];                  -- NULL/'{}' ⇒ denyAll (fail-closed; no default)

-- Provisioning symmetry: a role's default authorized namespaces (materialised into user_clearance at setup, #9).
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS default_allowed_namespaces text[] NOT NULL DEFAULT '{}';

-- ── (2) KEYWORD LEG — a generated tsvector + GIN, on BOTH stores (the identical filter still gates it) ───────
-- GENERATED ALWAYS … STORED: the tsvector is derived from `statement`/`text` on every write, so it can NEVER
-- drift from the source (a trigger could be forgotten on a new write path — writeMemory/supersede need NO
-- change). to_tsvector(regconfig, text) with an EXPLICIT 'english' config is IMMUTABLE (required for a
-- generated column; the 1-arg form is only STABLE and would be rejected).
--
-- ⚠ FIRST-CLIENT TRIPWIRE (record in the pin ledger like the embedding pin): 'english' is pinned in DDL here.
--   A non-English corpus needs a CONSCIOUS re-index (drop+recreate the generated column with another config or
--   a language column), NOT a flag — exactly like changing the embedding model is a full re-embed (§4.7, #1).
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS ts tsvector GENERATED ALWAYS AS (to_tsvector('english', statement)) STORED;
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS ts tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX IF NOT EXISTS memories_ts_gin ON memories USING gin (ts);
CREATE INDEX IF NOT EXISTS chunks_ts_gin   ON chunks   USING gin (ts);
