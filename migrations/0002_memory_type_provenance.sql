-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0002 · memories.type + memories.provenance (M0 write half) · Issue #3 · Brief §4.2, §5              ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- #2 shipped a deliberately THIN memories table (store + vector-search only). #3's acceptance — "one
-- `procedural` memory with … provenance refs" — needs two columns #2 omitted. This adds JUST those two.
--
-- EXPAND/CONTRACT (tech-stack §5.4): purely additive (ADD COLUMN IF NOT EXISTS only), so the running image
-- tolerates schema N-1 (#2, no type/provenance) and N side by side. Defaults backfill any pre-existing row;
-- the app always supplies both columns explicitly (writeMemory()).
--
-- ⚠ #7 (full lifecycle) MUST ADD-ONLY the *remaining* columns (status, valid_from/valid_to, slot fields,
--   utility_score, retrieval_count, last_retrieved_at, memory_links, …). DO NOT re-add `type` or
--   `provenance` — they live here now. Re-adding them would be a non-additive collision.
--
-- DEDUP GUARD — DEFERRED: dedup is currently app-level (writeMemory does a namespace-scoped SELECT then
--   skips). That is a check-then-insert (TOCTOU) race — genuinely fine for M0's SINGLE writer, but it
--   becomes real once the worker tier ingests concurrently (#17). The DB-level guard can only land once the
--   `status` column exists (an invalidated row and a new active row legitimately share a content_hash —
--   #12 invalidate-don't-overwrite — so a plain UNIQUE would wrongly collide). #7 therefore adds:
--     add partial UNIQUE (namespace, content_hash) WHERE status='active' + ON CONFLICT in writeMemory once status exists.
--   Until then the btree index below just makes the app-level lookup fast.

ALTER TABLE memories
  -- 'working' memory NEVER persists (§4.1) — it is intentionally excluded from the CHECK (fail-closed:
  -- a working-memory row must not be representable in this table).
  ADD COLUMN IF NOT EXISTS type       text  NOT NULL DEFAULT 'semantic'
    CHECK (type IN ('episodic', 'semantic', 'procedural')),
  -- provenance carries REFS, never content (§11.10). jsonb mirrors @aios/shared `Provenance`.
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Speeds the namespace-scoped dedup lookup. NOT unique on purpose (see DEDUP GUARD above).
CREATE INDEX IF NOT EXISTS memories_namespace_content_hash ON memories (namespace, content_hash);
