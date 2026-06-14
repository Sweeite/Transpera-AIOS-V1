-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0005 · memory_links — typed edges between memories · Issue #7 · Brief §4.5, §4.6                    ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- TYPED back-references (the invariant: memory_links edges, NOT a flat source_refs string[]). One row per edge.
-- This is what lets decay ask "does an ACTIVE SEMANTIC memory back-reference this episodic one?" cheaply
-- (#31 silent-data-loss guard) and records supersession (#12/#30).
--
-- EXPAND/CONTRACT: additive (new table). FK to memories(id); deleting a memory cascades its edges (edges
-- have no meaning without both endpoints — and memories are invalidated, not deleted, so this rarely fires).

CREATE TABLE IF NOT EXISTS memory_links (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id      uuid        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind       text        NOT NULL CHECK (kind IN ('derived_from', 'supersedes', 'consolidated_child', 'corroborates')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, kind)
);

-- Both directions are queried: "what does X derive from" (from_id) and "what back-references Y" (to_id, #31).
CREATE INDEX IF NOT EXISTS memory_links_from ON memory_links (from_id);
CREATE INDEX IF NOT EXISTS memory_links_to   ON memory_links (to_id);
