/**
 * Issue #51 — engine-boot smoke test (the POSITIVE path), real-Postgres lane.
 *
 * boot-fail-closed.test.ts (#7) already proves the NEGATIVE path: no TENANT_ID / no DATABASE_URL ⇒ the
 * worker, api, getDb and getWorkerDb boot paths refuse to start. We do NOT duplicate that here.
 *
 * This file adds the one thing that lane can't: with a tenant set AND a real Postgres reachable, the engine's
 * own connection path (getDb → postgres.js → drizzle) actually ASSEMBLES and round-trips a query. That closes
 * the gap the issue calls out — "otherwise first exercised in prod."
 *
 * SCOPE (minimal, per #51): connection assembly only. The FULL provisioned-tenant boot (plugin + clearance +
 * seed) is the path #39 produces and is gated on #39 — NOT exercised here.
 *
 * Like the migration lane, this self-skips unless SUPABASE_DB_URL is set, so it is hermetic-by-default
 * locally and runs in CI's real-Postgres job (a pgvector service container) — no provider keys, DB only.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

const ADMIN_URL = process.env.SUPABASE_DB_URL;
const ORIG = { ...process.env };

describe.skipIf(!ADMIN_URL)('engine-boot positive path (#51 — connection assembles against real Postgres)', () => {
  afterEach(() => {
    process.env = { ...ORIG };
  });

  // The getDb() singleton is memoised per module; close it so vitest's worker exits cleanly.
  afterAll(async () => {
    const { closeDb } = await import('../../packages/core/src/db/client.ts');
    await closeDb();
  });

  it('with TENANT_ID + DATABASE_URL set, getDb() assembles a connection that round-trips a query', async () => {
    const { getDb } = await import('../../packages/core/src/db/client.ts');
    process.env.TENANT_ID = 'ci-smoke';
    process.env.DATABASE_URL = ADMIN_URL!; // the engine path (transaction-mode, prepare:false) against real PG

    const db = getDb();
    const rows = await db.execute(sql`select 1 as ok`);
    // postgres.js returns an array-like of rows; the single row's `ok` proves a real round-trip.
    expect(Array.from(rows as Iterable<{ ok: number }>)[0]?.ok).toBe(1);
  });
});
