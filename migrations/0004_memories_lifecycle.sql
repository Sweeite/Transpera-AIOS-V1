-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0004 · memories full lifecycle + chunks.provenance + DB-level dedup guard · Issue #7 · Brief §4     ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- M0 (#2/#3) shipped a THIN memories table (store + vector-search, +type/+provenance). #7 adds the REMAINING
-- lifecycle columns so a row is the full @aios/shared `Memory` shape, and closes the #3 dedup deferral.
--
-- EXPAND/CONTRACT (tech-stack §5.4): purely additive (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- / one ADD CONSTRAINT), so the running image tolerates schema N-1 (M0) and N side by side. Existing rows
-- backfill from the defaults; the app supplies every column explicitly going forward.
--
-- ⚠ DO NOT re-add `type` or `provenance` on memories — they live in 0002. Re-adding = a non-additive collision.
--
-- #3 DEDUP GUARD — CLOSED HERE. M0's dedup was app-level check-then-insert (a TOCTOU race, fine for one
--   writer, unsafe once the worker tier ingests concurrently, #17). The DB-level guard could only land once
--   `status` existed: an invalidated row and a new active row legitimately share a content_hash
--   (#12 invalidate-don't-overwrite), so a plain UNIQUE would wrongly collide. The PARTIAL unique below
--   (… WHERE status='active') guards exactly the live set; writeMemory() now inserts ON CONFLICT.
--   PRECONDITION: no two ACTIVE rows already share (namespace, content_hash). True on a fresh/test schema
--   (M0 dedups before insert); on a legacy DB with active dupes this index build would fail — dedup first.

-- ── memories: the remaining lifecycle columns (full @aios/shared `Memory`) ──────────────────────────────
ALTER TABLE memories
  -- §4.4 invalidate-don't-overwrite: status flips active→invalidated; the row is never deleted or mutated.
  ADD COLUMN IF NOT EXISTS status            text        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invalidated')),
  -- bitemporal validity. valid_to NULL ⇒ still active (§4.4); set = now() at invalidation time.
  ADD COLUMN IF NOT EXISTS valid_from        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to          timestamptz,
  -- optional structured slot for deterministic supersession/dedup (§4.5). Free-text facts leave it NULL.
  ADD COLUMN IF NOT EXISTS entity_ref        text,                       -- canonical entity id (§4.10 Identity Map)
  ADD COLUMN IF NOT EXISTS attribute         text,
  ADD COLUMN IF NOT EXISTS slot_value        text,                       -- `value` is a SQL keyword-ish; store as slot_value
  -- computed by the decay cron, NOT on write (§4.6) — nullable until decay first runs.
  ADD COLUMN IF NOT EXISTS utility_score     double precision,
  ADD COLUMN IF NOT EXISTS retrieval_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retrieved_at timestamptz;

-- Slot is all-or-nothing: a half-populated slot (entity but no attribute) is a silent-corruption bug, not a
-- valid partial fact. Fail-closed at the DB. (No IF NOT EXISTS for constraints — the migration runner's
-- forward-only ledger applies each file exactly once; re-application is a runner concern, not this file's.)
ALTER TABLE memories
  ADD CONSTRAINT memories_slot_all_or_none CHECK (
    (entity_ref IS NULL AND attribute IS NULL AND slot_value IS NULL)
    OR (entity_ref IS NOT NULL AND attribute IS NOT NULL AND slot_value IS NOT NULL)
  );

-- #3 DB-level dedup guard: at most ONE active row per (namespace, content_hash). Invalidated rows are exempt
-- (they legitimately share the hash with their successor). writeMemory() pairs this with ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS memories_active_namespace_content_hash
  ON memories (namespace, content_hash) WHERE status = 'active';

-- Hot path for the decay/lifecycle queries (§4.6): scope to the live set.
CREATE INDEX IF NOT EXISTS memories_status_active ON memories (status) WHERE status = 'active';

-- ── chunks: align 1:1 with @aios/shared `Chunk` (it carries provenance; the M0 table omitted it) ────────
ALTER TABLE chunks
  -- provenance carries REFS, never content (§11.10). jsonb mirrors @aios/shared `Provenance`.
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
