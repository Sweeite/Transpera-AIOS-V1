# Migrations

One Postgres (Supabase, pgvector built in) **per client**. These `*.sql` files are the **source of truth** for
the schema — applied in **lexical order** to every tenant database. Drizzle (`packages/core/src/db/schema.ts`)
**mirrors** this DDL for types + query building; it does **not** generate it (we never run `drizzle-kit`). The
`tests/core/schema-drift.test.ts` fails if the two diverge.

## Expand/contract (tech-stack §5.4) — the discipline every migration follows

The shared core image must tolerate schema **N and N-1 side by side** (a migration is deployed *before* the code
that needs it; old workers keep running during the rollout). So every migration is **additive / expand-only**:

- `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- New `NOT NULL` columns carry a `DEFAULT` (so pre-existing rows backfill and old writers don't fail).
- **Never** `DROP`/rename/retype an existing column in the same step as the code that stops using it. A removal
  is a **separate, later contract** migration, run only after every deployed image has stopped referencing it.
- The few `ADD CONSTRAINT` statements are **not** `IF NOT EXISTS`-idempotent — they rely on each file being
  applied **exactly once** to a fresh database (the apply primitive is forward-only; see below).

A one-way door (not expand/contract): **the embedding dimension** — `vector(1024)` + HNSW. Changing the pinned
model/dimension (#1) is a **full re-embed of every row**, not a migration. Keep `vector(N)` in lockstep with
`EMBEDDING_DIM` in `packages/core/src/harness/gateway.ts`.

## The two test lanes

| Lane | What | When |
| --- | --- | --- |
| **pglite** (default) | `tests/core/helpers/pglite.ts` applies every `*.sql` to in-process pgvector. Hermetic, no Docker. The default `pnpm test:core` runs it. | every change, in CI |
| **real Supabase** | `tests/core/supabase-migration.real.test.ts` applies the same files to a real local Supabase Postgres and asserts `vector(1024)`, the HNSW indexes, the `#3` partial-UNIQUE guard, and every table. Catches pglite-vs-Supabase divergence (the **#2** HNSW/extension-version trap). | **local only** (CI has no Docker — automating it is #51's job) |

Run the real lane locally:

```bash
supabase start
SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" pnpm test:core
# (or: SUPABASE_DB_URL="$(supabase status -o env | grep '^DB_URL=' | cut -d= -f2- | tr -d '"')")
```

Without `SUPABASE_DB_URL` the real lane self-skips, so the default run stays hermetic.

## The apply primitive

`control-plane/src/apply-migrations.ts` → `applyMigrations(connectionString)` applies the files in lexical order
to **one** database. It is intentionally just that — **no ledger**. It is shared by the real-Supabase test lane,
provisioning (#39), and migrate-all (#40, which fans it across all tenants with per-project status + halt-on-fail).
Apply to a **fresh** database (a new tenant, a test scratch DB).

## The files

| File | Issue | Adds |
| --- | --- | --- |
| `0001_init_memories_chunks.sql` | #2 | `memories`, `chunks` (thin slice), `vector(1024)` + HNSW + partial zone indexes |
| `0002_memory_type_provenance.sql` | #3 | `memories.type`, `memories.provenance` |
| `0003_retrieval_misses.sql` | #4 | `retrieval_misses` (abstention learning signal) |
| `0004_memories_lifecycle.sql` | #7 | `memories` lifecycle (`status`, `valid_from/to`, slot, `utility_score`, `retrieval_count`, `last_retrieved_at`); `chunks.provenance`; **#3 partial UNIQUE dedup guard** `(namespace, content_hash) WHERE status='active'` |
| `0005_memory_links.sql` | #7 | `memory_links` (typed edges, replaces flat `source_refs`) |
| `0006_connectors_identity.sql` | #7 | `connector_schemas`, `connections` (+`trust_level`), `identity_map`, `ingestion_log` |
| `0007_agents_hitl.sql` | #7 | `task_state`, `standing_approvals`, `inbox_items` |
| `0008_conversation.sql` | #7 | `threads`, `messages` (the `recentThread` source) |
| `0009_permissions.sql` | #7 | `user_clearance`, `roles` |
| `0010_config_observability.sql` | #7 | `system_config`, `feedback`, `suggestions`, `review_queue`, `monitors`, `metrics_rollup`, `traces`, `audit_log` |
