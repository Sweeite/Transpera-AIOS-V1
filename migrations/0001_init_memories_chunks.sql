-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0001 · memories + chunks (M0 tracer slice) · Issue #2 · Brief §4.2, §4.7, §9.1                      ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- A THIN slice of the full schema (#7) — just enough to store and vector-search for the M0 demo.
-- Lifecycle columns (utility_score, valid_to, status, type, ...) and the other 13 tables are #7.
--
-- EXPAND/CONTRACT (tech-stack §5.4): this is an EXPAND step — purely additive (CREATE only, no DROP/ALTER
-- of existing objects), so the running image tolerates schema N-1 (nothing) and N side by side. The shared
-- core image must never assume a column exists before its expand migration has run.
--
-- ⚠ ONE-WAY DOOR (#1 → #2): `vector(1024)` and the HNSW index are fixed at DDL time. 1024 is the PROVISIONAL
--   dimension pinned in packages/core/src/harness/gateway.ts (EMBEDDING_DIM). Changing the model OR the
--   dimension later is a FULL RE-EMBED of every row + a re-derived abstention floor — NOT an expand/contract
--   migration. While the pin is "0-provisional" and no client corpus exists, that cost is ~zero (see
--   docs/adr/0001-embedding-model-pin.md). Keep this number in lockstep with EMBEDDING_DIM.
--
-- LEAK SURFACE (§9.1): `zone` + `sensitivity_level` are NOT NULL on BOTH tables. chunks are RAG-in-place but
--   are permission-filtered EXACTLY like memories — "no lifecycle" ≠ "no permissions". A row that cannot
--   declare its access label must not exist (fail-closed); the retrieval predicate (rbac.retrievalWhereSql)
--   filters both tables with the identical clause.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── memories ─────────────────────────────────────────────────────────────────────────────────────────
-- Typed organisational knowledge ("I know this"). Minimal columns only — full lifecycle is #7.
CREATE TABLE IF NOT EXISTS memories (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace         text        NOT NULL,                              -- 'org' | 'client:..' | 'project:..' (§4.3)
  zone              text        NOT NULL,                              -- access label; filtered before ranking (§9.1)
  sensitivity_level smallint    NOT NULL CHECK (sensitivity_level BETWEEN 1 AND 5),
  statement         text        NOT NULL,
  content_hash      text        NOT NULL,                              -- tier-1 exact-dup guard (§5)
  embedding_model   text        NOT NULL,                              -- pinned; mixing vector spaces is forbidden (§4.7)
  embedding_version text        NOT NULL,                              -- stamped from row one (#2 Watch)
  embedding         vector(1024) NOT NULL,                             -- = EMBEDDING_DIM (#1). One-way door (see header).
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── chunks ───────────────────────────────────────────────────────────────────────────────────────────
-- RAG-in-place. SAME permission columns as memories — chunks ARE permission-filtered (§4.2).
CREATE TABLE IF NOT EXISTS chunks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace         text        NOT NULL,
  zone              text        NOT NULL,
  sensitivity_level smallint    NOT NULL CHECK (sensitivity_level BETWEEN 1 AND 5),
  text              text        NOT NULL,
  content_hash      text        NOT NULL,
  embedding_model   text        NOT NULL,
  embedding_version text        NOT NULL,
  embedding         vector(1024) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '90 days'  -- chunk_ttl_days default (§4.2)
);

-- ── indexes ──────────────────────────────────────────────────────────────────────────────────────────
-- HNSW (cosine) is the ANN index for the dense-cosine retrieval leg (§4.7). vector_cosine_ops pairs with `<=>`.
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw   ON chunks   USING hnsw (embedding vector_cosine_ops);

-- Partial index on the hot path: most retrieval is the 'general' zone, so index it specifically.
CREATE INDEX IF NOT EXISTS memories_zone_general ON memories (zone) WHERE zone = 'general';
CREATE INDEX IF NOT EXISTS chunks_zone_general   ON chunks   (zone) WHERE zone = 'general';
