-- ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ 0008 · threads · messages — conversation state (the `recentThread` source) · Issue #7 · Brief §7.1  ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- Was specified NOWHERE in the Brief yet is load-bearing: `messages` is the source of `recentThread` fed into
-- context assembly + intent routing (so "do it" can resolve "do WHAT"). EXPAND/CONTRACT: additive.
-- threads = @aios/shared `Thread`; messages = `Message`.

-- ── threads ── a conversation, owned by a user, RBAC-shareable (§7.1). Scopes the chat front door.
CREATE TABLE IF NOT EXISTS threads (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   text        NOT NULL,                     -- RBAC-scoped; shareable per §7.1
  title      text,                                     -- nullable (untitled until summarised)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── messages ── turns within a thread. answer_ref links a 'brain' turn to its provenance-labelled answer.
-- principal is stamped per turn (a thread may carry turns from different principals once shared).
CREATE TABLE IF NOT EXISTS messages (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('user', 'brain')),
  content    text        NOT NULL,
  answer_ref text,                                     -- provenance-labelled answer id, for 'brain' turns
  principal  jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- recentThread reads the latest turns of a thread in order.
CREATE INDEX IF NOT EXISTS messages_thread_created ON messages (thread_id, created_at);
