-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0003 · retrieval_misses (M0 read half) · Issue #4 · Brief §4.7, §6                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- The read half abstains when nothing clears the relevance floor — and abstention is the PRODUCT, not an
-- error. Every abstention is logged here as a MISS: the single best learning signal for what to capture
-- next (§6 — "if someone knows the answer, capture it"). There is no metrics/analytics table yet (#32/#50);
-- this is the minimal queryable record that makes "logs a miss" real and testable, not a bare console.log.
--
-- EXPAND/CONTRACT (tech-stack §5.4): purely additive (CREATE only), so the running image tolerates schema
-- N-1 (no misses table) and N side by side.
--
-- ⚠ CARRY-FORWARD (#32/#50) — ADD-ONLY extend this table; do NOT re-create it:
--   • This is NOT the audit log, so §11.10's no-content rule does not bind it. Misses are the LEARNING
--     SIGNAL and that use genuinely NEEDS the query content to be actionable — you cannot act on "people
--     keep asking <hash>". #4 records hash-only because it has no permission/namespace context yet, NOT
--     because misses are forever opaque. #32/#50 ADD a permission-scoped `query_text` (scoped like a trace
--     span, §6.9 — short-TTL + clearance-filtered), plus aggregation/counters. Don't inherit "hash-only".
--   • #13 populates `namespace` (it is nullable here precisely because #4 has no clearance/namespace yet).

CREATE TABLE IF NOT EXISTS retrieval_misses (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace   text,                                  -- nullable: #4 has no clearance/namespace yet (#13 fills it)
  query_hash  text        NOT NULL,                  -- sha256 of the NORMALISED query — a refs-only fingerprint for #4
  top_score   float8,                                -- best below-floor cosine seen; NULL ⇒ empty candidate set
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Group repeated misses of the same question (the "people keep asking X" signal §6 acts on).
CREATE INDEX IF NOT EXISTS retrieval_misses_query_hash ON retrieval_misses (query_hash);
