-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0013 · memories.invalidated_reason — the free-text WHY of an invalidation · Issue #12 · Brief §4.4  ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- #12 invalidate-don't-overwrite needs a home for the human-readable reason a fact was invalidated/superseded
-- ("when did it change and why"). The CHOICE (recorded on #12): this lives on the memories ROW, not on the
-- memory_links edge — because (a) a plain invalidate (👎 wrong, §4.6) has NO successor row and thus no edge to
-- hang a reason on, and (b) it belongs with valid_to as the bitemporal "why it stopped being true". The
-- audit_log separately records only the CLOSED-vocab `InvalidationCode` (refs-only, §11.10); this column holds
-- the free text, and because `memories` is permission-tagged it is filtered on read exactly like the statement.
--
-- EXPAND/CONTRACT (tech-stack §5.4): purely additive (ADD COLUMN IF NOT EXISTS + one ADD CONSTRAINT). The
-- running image tolerates schema N-1 (no column) and N side by side; existing rows backfill to NULL.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS invalidated_reason text;

-- An ACTIVE row carrying an invalidation reason is a silent-corruption bug (the reason is set only at the
-- active→invalidated flip, and history rows are never reactivated). Fail-closed at the DB. (No IF NOT EXISTS
-- for constraints — the forward-only runner applies each file exactly once.)
ALTER TABLE memories
  ADD CONSTRAINT memories_reason_only_when_invalidated CHECK (
    status = 'invalidated' OR invalidated_reason IS NULL
  );
