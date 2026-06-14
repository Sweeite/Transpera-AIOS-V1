-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0010 · system_config · feedback · suggestions · review_queue · monitors · metrics_rollup ·          ║
-- ║        traces · audit_log — config / quality / observability · Issue #7 · Brief §4.8, §6, §11        ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- EXPAND/CONTRACT: additive (new tables). TYPE NOTE: feedback/suggestions = @aios/shared `Feedback`/`Suggestion`;
-- traces = `TraceSpan`. system_config/review_queue/monitors/metrics_rollup/audit_log are DB-only for now —
-- their consuming issues add the type: system_config → #8, review_queue → #25/#33, monitors → #45,
-- metrics_rollup → #50, audit_log → #11. The drift test gains the type↔Drizzle leg as each lands.

-- ── system_config ── every threshold/weight/floor is a row here (§4.8): gated/scoped/bounded/audited.
-- Scope resolution is client override → org default. namespace NULL ⇒ the org default; set ⇒ a client override.
-- One org default per key + one override per (key, namespace), enforced by the two partial unique indexes.
CREATE TABLE IF NOT EXISTS system_config (
  key        text        NOT NULL,
  namespace  text,                                     -- NULL ⇒ org default; set ⇒ client/project override
  value      jsonb       NOT NULL,                     -- number | string (bounds/quality live in KNOWN_KEYS, code)
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text                                      -- principal ref of the last writer (audited, §4.8)
);
CREATE UNIQUE INDEX IF NOT EXISTS system_config_key_org ON system_config (key)            WHERE namespace IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS system_config_key_ns  ON system_config (key, namespace) WHERE namespace IS NOT NULL;

-- ── feedback ── 👍/👎/"this is wrong". Feeds decay's feedback_score (#31) AND the wrong→invalidate split (§4.6).
CREATE TABLE IF NOT EXISTS feedback (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id  text        NOT NULL,                     -- answer id or memory id
  user_id    text        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('up', 'down_not_useful', 'down_wrong')),  -- down_wrong → invalidate
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_target ON feedback (target_id);

-- ── suggestions ── self-improvement proposals (#33) with a TYPED evidence payload so approval isn't a rubber-stamp.
CREATE TABLE IF NOT EXISTS suggestions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_config_key text,                              -- nullable: not every suggestion is a config change
  current           jsonb,                             -- number | string (current value)
  proposed          jsonb,                             -- number | string (proposed value)
  evidence          jsonb       NOT NULL,              -- {fixtureScoreBefore, fixtureScoreAfter, supportingSample[], costDeltaUsd?}
  status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── review_queue ── memory-proposal + consolidation-review + sensitivity-broaden items (dashboard 3 drain rate).
CREATE TABLE IF NOT EXISTS review_queue (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text        NOT NULL CHECK (kind IN ('memory_proposal', 'consolidation_review', 'sensitivity_broaden')),
  payload     jsonb       NOT NULL,                    -- refs + proposed change (no raw content, §11.10)
  status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS review_queue_pending ON review_queue (kind) WHERE status = 'pending';

-- ── monitors ── heartbeat + expected cadence per monitor/cron. Powers the EXTERNAL dead-man's switch (#45):
-- a control-plane watchdog (NOT an in-tenant job that dies with the worker) alerts on overdue heartbeats.
CREATE TABLE IF NOT EXISTS monitors (
  id                text        PRIMARY KEY,           -- monitor/cron name
  expected_cadence  text        NOT NULL,              -- cron expr or interval the watchdog measures against
  last_heartbeat_at timestamptz,                       -- NULL until the first beat
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── metrics_rollup ── time-series aggregates (abstention rate, miss rate, cost) for the Quality/Cost dashboards.
CREATE TABLE IF NOT EXISTS metrics_rollup (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  metric     text        NOT NULL,                     -- 'abstention_rate' | 'miss_rate' | 'cost_usd' | …
  namespace  text,                                     -- NULL ⇒ org-wide; set ⇒ per client/project
  bucket     timestamptz NOT NULL,                     -- the time bucket this aggregate covers
  value      double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One value per (metric, scope, bucket). namespace NULL folded via COALESCE so the org-wide series is unique too.
CREATE UNIQUE INDEX IF NOT EXISTS metrics_rollup_unique ON metrics_rollup (metric, (COALESCE(namespace, '')), bucket);

-- ── traces ── short-TTL, permission-scoped, auto-pruned (content allowed for debug, §6.9). = @aios/shared TraceSpan.
CREATE TABLE IF NOT EXISTS traces (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid        NOT NULL,
  agent       text,                                    -- nullable (not every span is an agent span)
  principal   jsonb       NOT NULL,
  trigger     text        NOT NULL CHECK (trigger IN
                ('chat', 'individual-cron', 'system-cron', 'webhook', 'system-event')),
  kind        text        NOT NULL CHECK (kind IN ('model', 'tool', 'retrieval')),
  model       text,                                    -- provider/model actually used (multi-model routing, §6.1)
  tokens_in   integer,
  tokens_out  integer,
  cost_usd    double precision,
  duration_ms integer     NOT NULL,
  rating      double precision,
  created_at  timestamptz NOT NULL DEFAULT now()       -- the TTL clock (auto-prune cron, §6.9)
);
CREATE INDEX IF NOT EXISTS traces_task ON traces (task_id);
CREATE INDEX IF NOT EXISTS traces_created ON traces (created_at);  -- TTL prune scans by age

-- ── audit_log ── append-only, references-not-content (§11.10); +prev_hash hash-chain for tamper-evidence (#11).
CREATE TABLE IF NOT EXISTS audit_log (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq        bigserial   NOT NULL,                     -- monotonic ordering for the hash chain
  actor      text,                                     -- principal ref (nullable for system events)
  action     text        NOT NULL,
  target_ref text,                                     -- a reference, NEVER content (§11.10)
  metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb, -- refs only
  prev_hash  text,                                     -- previous row's hash (NULL for the genesis row)
  hash       text        NOT NULL,                     -- hash(this row ‖ prev_hash) — tamper-evident (#11)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_seq ON audit_log (seq);
