-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0009 · user_clearance · roles — the authz substrate · Issue #7 · Brief §9.1                         ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- The engine owns AUTHORIZATION (Supabase Auth only authenticates, §8.1a). Clearance lives HERE, never in
-- auth.users. EXPAND/CONTRACT: additive. user_clearance = @aios/shared `Clearance` (+ principal_id).
-- getClearance() logic is #9 — OUT OF SCOPE here; this is only the table it reads.
--
-- FAIL-CLOSED distinction (#37/#47): a MISSING row ⇒ deny (sees nothing) — handled by #9's resolver. An
-- EXISTING row with empty allowed_zones ⇒ also sees nothing, but is an explicit, audited state. Both are
-- fail-closed; the schema must represent the empty array distinctly from the absent row (hence no DEFAULT
-- that would mask an unprovisioned user — a row exists only when deliberately written).

-- ── user_clearance ── { principal_id (= Supabase auth.users.id), allowed_zones[], max_sensitivity } (§9.1).
CREATE TABLE IF NOT EXISTS user_clearance (
  principal_id    text        PRIMARY KEY,             -- = Supabase auth.users.id (the authenticated subject)
  allowed_zones   text[]      NOT NULL,                -- empty {} ⇒ sees nothing (fail-closed); NO default — see header
  max_sensitivity smallint    NOT NULL CHECK (max_sensitivity BETWEEN 1 AND 5),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── roles ── role → default clearance + allowed agents. DB-only for now; #9 adds the @aios/shared type and
-- the resolver that materialises a user_clearance row from a role.
CREATE TABLE IF NOT EXISTS roles (
  id                      text        PRIMARY KEY,     -- role name (e.g. 'analyst', 'finance_admin')
  default_allowed_zones   text[]      NOT NULL DEFAULT '{}',
  default_max_sensitivity smallint    NOT NULL CHECK (default_max_sensitivity BETWEEN 1 AND 5),
  allowed_agents          text[]      NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now()
);
