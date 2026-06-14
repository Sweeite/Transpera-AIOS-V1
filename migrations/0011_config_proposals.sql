-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0011 · config_proposals — the gated approval queue for quality-affecting config changes · Issue #8   ║
-- ║        Brief §4.8, PRD §6.11                                                                          ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- EXPAND/CONTRACT: additive (new table). Applied values stay in `system_config` (0010); a PENDING change to a
-- qualityAffecting key parks HERE until approved — so `getConfig`, which only ever reads `system_config`, cannot
-- see an unapproved value (the "pending changes don't take effect" audit fix, structurally). Cosmetic keys skip
-- this table and apply straight to `system_config`. Bounds/quality live in KNOWN_KEYS (code), never here.

CREATE TABLE IF NOT EXISTS config_proposals (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text        NOT NULL,
  namespace      text,                                  -- NULL ⇒ org-scope proposal; set ⇒ client/project override
  current_value  jsonb,                                 -- value snapshot at propose time (number | string; for the diff)
  proposed_value jsonb       NOT NULL,                  -- number | string (validated vs KNOWN_KEYS at propose AND apply)
  evidence       text        NOT NULL,                  -- free-text rationale; #33 supplies a typed evidence payload
  status         text        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text,                                  -- principal ref of the proposer (audited, §4.8)
  resolved_at    timestamptz,                           -- set when approved/rejected/superseded
  resolved_by    text                                   -- principal ref of the approver/rejecter
);
-- ONE open proposal per (key, namespace) — the audit-fix invariant. namespace NULL folded via COALESCE so the
-- org-scope proposal is unique too. A second open proposal on the same scope is the app-layer reject; this index
-- is the race backstop (a concurrent insert fails here, never two pending).
CREATE UNIQUE INDEX IF NOT EXISTS config_proposals_one_open
  ON config_proposals (key, (COALESCE(namespace, ''))) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS config_proposals_pending ON config_proposals (key) WHERE status = 'pending';
