-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0007 · task_state · standing_approvals · inbox_items — agents + human-in-the-loop · Issue #7         ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- Durable agent execution + the ONE human-in-the-loop interrupt primitive (clarification #27 / confirmation
-- #26 / trust-constrained #29 all pause → surface to the Inbox → resume idempotently). EXPAND/CONTRACT: additive.
-- task_state = @aios/shared `TaskState`; standing_approvals = `StandingApproval`; inbox_items = `InboxItem`.

-- ── task_state ── survives a worker restart (§4.1). principal is IMMUTABLE down the delegation tree and
-- resume ALWAYS preserves it (never the answerer's authority, #28). version = optimistic lock; lease_until =
-- single-consumer resume so a paused run never double-side-effects (#27). pause = the typed PausePayload.
CREATE TABLE IF NOT EXISTS task_state (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text        NOT NULL CHECK (status IN
                ('running', 'paused_awaiting_input', 'paused_awaiting_confirmation', 'completed', 'failed')),
  principal   jsonb       NOT NULL,                    -- @aios/shared Principal (kind + id)
  trigger     text        NOT NULL CHECK (trigger IN
                ('chat', 'individual-cron', 'system-cron', 'webhook', 'system-event')),
  context     jsonb       NOT NULL DEFAULT '{}'::jsonb,-- accumulated agent context
  pause       jsonb,                                   -- set when paused: {kind:'clarification'|'confirmation', …}
  version     integer     NOT NULL DEFAULT 0,          -- optimistic lock (resume is single-consumer + idempotent)
  lease_until timestamptz,                             -- a worker leases the row to resume; watchdog re-queues after lapse
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- The resume worker scans for leasable paused/running rows.
CREATE INDEX IF NOT EXISTS task_state_status ON task_state (status);

-- ── standing_approvals ── "unless a standing approval exists" — per-user, per-action-type grant for the
-- confirmation gate (#26). Revocable; audited. scope optionally narrows (e.g. one client); expiry optional.
CREATE TABLE IF NOT EXISTS standing_approvals (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  action_type text        NOT NULL,                    -- e.g. 'send_email'
  scope       text,                                    -- optional narrowing (nullable ⇒ all)
  expires_at  timestamptz,                             -- optional expiry (nullable ⇒ no expiry)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS standing_approvals_user_action ON standing_approvals (user_id, action_type);

-- ── inbox_items ── the single push destination (§7.5), permission-scoped to the recipient. body is a
-- provenance-labelled Claim[] like any answer. task_id set for clarification_request (answering resumes it).
CREATE TABLE IF NOT EXISTS inbox_items (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text        NOT NULL,                     -- only what this user is cleared to see
  type       text        NOT NULL CHECK (type IN
               ('brief', 'report', 'clarification_request', 'alert', 'suggestion')),
  title      text        NOT NULL,
  body       jsonb       NOT NULL,                      -- Claim[] (provenance-labelled)
  task_id    uuid        REFERENCES task_state(id) ON DELETE SET NULL,  -- set for clarification_request
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbox_items_user ON inbox_items (user_id);
