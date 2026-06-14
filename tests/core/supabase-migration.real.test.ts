/**
 * Issue #7 — the SECOND TEST LANE. M0 ran hermetically on pglite; this applies the SAME migrations to a REAL
 * local Supabase Postgres. It is where pglite-vs-Supabase divergence finally surfaces (the #2 trap: pglite's
 * pgvector ≠ Supabase's; HNSW/extension-version differences). LOCAL-ONLY: CI has no Docker, so it self-skips
 * unless SUPABASE_DB_URL is set. Automating real-Postgres-in-CI (a service container) is #51's job.
 *
 * Run it locally:
 *   supabase start
 *   SUPABASE_DB_URL="$(supabase status -o env | grep '^DB_URL=' | cut -d= -f2- | tr -d '\"')" pnpm test:core
 * (or export SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres)
 *
 * Isolation: applies to a FRESH scratch database it creates and drops, so it never collides with Supabase's
 * own objects and is repeatable (the migrations' few ADD CONSTRAINTs are not idempotent — fresh DB required).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { applyMigrations, migrationFiles } from '../../control-plane/src/apply-migrations.ts';
import { EMBEDDING_DIM } from '../../packages/core/src/harness/gateway.ts';
import { schema } from '../../packages/core/src/db/schema.ts';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

const ADMIN_URL = process.env.SUPABASE_DB_URL;
const SCRATCH_DB = 'aios_migration_lane';

function urlForDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('real Supabase migration lane (#7 — the #2 divergence catcher)', () => {
  let scratchUrl: string;

  beforeAll(async () => {
    // Recreate a fresh scratch DB on every run for a clean, repeatable apply.
    const admin = postgres(ADMIN_URL!, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    scratchUrl = urlForDb(ADMIN_URL!, SCRATCH_DB);
  }, 60_000);

  afterAll(async () => {
    if (!ADMIN_URL) return;
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }, 60_000);

  it('applies EVERY migration clean on real Supabase Postgres', async () => {
    const applied = await applyMigrations(scratchUrl);
    expect(applied).toEqual(migrationFiles()); // all of them, in order, no throw
  }, 60_000);

  it('pins memories.embedding to vector(EMBEDDING_DIM) on real pgvector (the #1/#2 one-way door)', async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const rows = await sql`
        SELECT a.atttypmod AS dim
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relname = 'memories' AND a.attname = 'embedding'`;
      // pgvector stores the declared dimension directly in atttypmod (no -4 VARHDR adjustment).
      expect(rows[0].dim).toBe(EMBEDDING_DIM);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it('builds the HNSW vector index on real Supabase (NOT guaranteed equal to pglite — the #2 trap)', async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const idx = await sql`
        SELECT indexname FROM pg_indexes
         WHERE tablename IN ('memories', 'chunks') AND indexdef ILIKE '%USING hnsw%'`;
      const names = idx.map((r) => r.indexname).sort();
      expect(names).toContain('memories_embedding_hnsw');
      expect(names).toContain('chunks_embedding_hnsw');
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it('creates the #3 partial UNIQUE dedup guard (namespace, content_hash) WHERE status=active', async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const rows = await sql`
        SELECT indexdef FROM pg_indexes
         WHERE tablename = 'memories' AND indexname = 'memories_active_namespace_content_hash'`;
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/UNIQUE/i);
      expect(rows[0].indexdef).toMatch(/status = 'active'/i);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it('every table defined in schema.ts exists on real Supabase (full schema, not just the M0 slice)', async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const rows = await sql`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      const dbTables = new Set(rows.map((r) => r.table_name));
      for (const t of Object.values(schema)) {
        expect(dbTables, `table ${getTableConfig(t as PgTable).name} present`).toContain(
          getTableConfig(t as PgTable).name,
        );
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);
});
