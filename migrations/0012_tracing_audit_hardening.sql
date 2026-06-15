-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0012 · traces clearance tag · audit_log hash_input — Issue #11 · Brief §6.9, §11.10                  ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- EXPAND/CONTRACT: additive only (ADD COLUMN IF NOT EXISTS, all new NOT NULL columns carry a DEFAULT so
-- pre-existing rows backfill and an old (pre-#11) writer mid-rollout never fails).
--
-- ── traces: the CLEARANCE TAG (the Watch — a trace must never be a backdoor to content you can't see) ──
-- Same column NAMES as memories/chunks (zone, sensitivity_level, namespace) ON PURPOSE: a future trace READ
-- (#37/#32) reuses rbac.retrievalWhereSql VERBATIM — `zone = ANY($z) AND sensitivity_level <= $s AND
-- namespace = ANY($n)`. Tagged at WRITE time with the clearance of the CONTENT the span carries (NOT the
-- principal's), so a later reader is filtered by what the content IS.
--
-- FAIL-CLOSED DEFAULTS: zone/namespace default to the sentinel '_untagged' — no clearance's allowed list ever
-- contains it, so an untagged / legacy / rollout-window span is invisible to EVERYONE until properly tagged.
-- sensitivity_level defaults to 5 (the max ceiling). A forgotten tag fails closed (invisible), never open.
ALTER TABLE traces
  ADD COLUMN IF NOT EXISTS zone              text     NOT NULL DEFAULT '_untagged',
  ADD COLUMN IF NOT EXISTS sensitivity_level smallint NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS namespace         text     NOT NULL DEFAULT '_untagged';

-- ── audit_log: hash_input — the EXACT canonical bytes hashed at write (refs/scalars only, like metadata) ──
-- The chain hash is recomputed from this TEXT (hash = sha256(hash_input ‖ prev_hash)), so verifyChain never
-- re-canonicalises a jsonb-roundtripped row — killing the float-normalisation false-tamper (0.608/0.92 written
-- as a JS number, read back via jsonb, would otherwise re-stringify differently across pglite vs Supabase).
-- NULLABLE for expand/contract: an old (pre-#11) writer mid-rollout inserts without it; verifyChain falls back
-- to column-reconstruction for those (rollout-window only). Every #11 writer always populates it.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS hash_input text;
