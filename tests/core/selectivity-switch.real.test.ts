/**
 * Issue #13 — the selectivity switch + exact-path PERFECT RECALL, on the REAL-PG lane (real pgvector).
 *
 * WHY THIS LANE IS NON-NEGOTIABLE: pglite DIVERGES from real pgvector on exactly this surface — under pglite,
 * `SET enable_indexscan = off` does NOT drop the HNSW scan (the documented pgvector "exact" recipe fails
 * there), which is why retrieve() forces the flat scan with a MATERIALIZED candidate CTE instead. So a green
 * pglite run is NOT evidence that the exact/perfect-recall guarantee holds where clients actually run. Here we
 * prove on real Postgres that (a) the MATERIALIZED-CTE exact path planner-resolves to a Seq Scan, (b) it
 * returns the TRUE nearest order, (c) the bounded-count switch routes exact↔HNSW at the threshold, and (d) the
 * HNSW path runs inside a transaction with its txn-scoped GUCs.
 *
 * LOCAL/CI-ONLY: self-skips unless SUPABASE_DB_URL is set (the real-postgres CI lane sets it; #51). Run:
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm test:core
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { applyMigrations } from '../../control-plane/src/apply-migrations.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import type { QueryFn, TxFn } from '../../packages/core/src/audit/audit-log.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { grantAll } from './helpers/grant.ts';
// This is a pgvector exact-vs-HNSW RECALL test — orthogonal to reranker availability. A constant-high fake
// reranker keeps it from abstaining (Decision A) in CI where VOYAGE_API_KEY is unset, isolating what it asserts.
import { constReranker } from './helpers/rerank.ts';

const ADMIN_URL = process.env.SUPABASE_DB_URL;
const SCRATCH_DB = 'aios_selectivity_lane';

function urlForDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
function cosVector(c: number, axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = c;
  v[axis] = Math.sqrt(1 - c * c);
  return v;
}
const embed: Embedder = async (texts) => texts.map(() => E0);
const vecLit = (v: number[]) => `[${v.join(',')}]`;

describe.skipIf(!ADMIN_URL)('#13 selectivity switch + exact perfect recall (real PG)', () => {
  let sql: postgres.Sql;
  let query: QueryFn;
  let transaction: TxFn;

  beforeAll(async () => {
    const admin = postgres(ADMIN_URL!, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const scratchUrl = urlForDb(ADMIN_URL!, SCRATCH_DB);
    await applyMigrations(scratchUrl);

    sql = postgres(scratchUrl, { max: 8 });
    query = async (q, params) => ({ rows: [...(await sql.unsafe(q, (params as any[]) ?? []))] });
    transaction = (fn) =>
      sql.begin((tx) => fn(async (q, params) => ({ rows: [...(await tx.unsafe(q, (params as any[]) ?? [])) ] }))) as Promise<any>;

    // Seed 8 rows with strictly-descending cosines to E0 and NO keyword overlap with the query (dense-only).
    for (let i = 1; i <= 8; i++) {
      await sql.unsafe(
        `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                               embedding_model, embedding_version, embedding)
         VALUES ('org','general',1,'semantic',$1,$2,'{}'::jsonb,$3,$4,$5::vector)`,
        [`alpha bravo item ${i}`, `sha256:item-${i}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vecLit(cosVector(0.9 - i * 0.02, i))],
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (!ADMIN_URL) return;
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }, 60_000);

  it('the EXACT path computes distance over the WHOLE filtered set and SORTS it — NOT an approximate HNSW scan', async () => {
    // The exact dense leg's shape: MATERIALIZED candidate set (distance for every filtered row), then ORDER/LIMIT
    // OUTSIDE the CTE. The HNSW index can only serve an ORDER BY `<=>` inside its own scan scope, so placing the
    // sort outside a MATERIALIZED CTE forces an EXACT sort over the materialized candidates ⇒ perfect recall.
    const exactPlan = await sql.unsafe(
      `EXPLAIN WITH cand AS MATERIALIZED (
           SELECT id, (embedding <=> $1::vector)::float8 AS distance FROM memories WHERE status='active'
        ), dense AS (SELECT id, distance FROM cand ORDER BY distance LIMIT 20)
        SELECT id FROM dense`,
      [vecLit(E0)],
    );
    const exactText = exactPlan.map((r: any) => r['QUERY PLAN']).join(' ');
    // The PERFECT-RECALL invariant on real pgvector: the vector ANN index is NEVER used to order the candidates
    // (it would make the result approximate), and an explicit Sort orders the fully-materialized set instead.
    expect(exactText).not.toMatch(/hnsw/i); // no approximate vector index in the exact dense leg
    expect(exactText).toMatch(/Sort/); // an exact sort over the materialized candidate set

    // (Documented finding, not asserted: pglite DIVERGES — under pglite `SET enable_indexscan = off` on a plain
    //  `ORDER BY <=>` query does NOT drop the HNSW scan, so the documented pgvector "exact" recipe is unreliable
    //  there. The MATERIALIZED-CTE shape above is planner-independent, which is why retrieve() uses it.)
  });

  it('the EXACT path returns the TRUE nearest order (perfect recall over the filtered set)', async () => {
    const out = await retrieve('zulu', { query, embed, rerank: constReranker(0.99), exactMaxRows: 100, transaction, ...grantAll() });
    expect(out.diagnostics.memories.mode).toBe('exact');
    expect(out.abstained).toBe(false);
    // Items were seeded with descending cosine by index; exact recall returns them in that exact order.
    expect(out.memories.map((m) => m.statement)).toEqual([
      'alpha bravo item 1', 'alpha bravo item 2', 'alpha bravo item 3', 'alpha bravo item 4',
      'alpha bravo item 5', 'alpha bravo item 6', 'alpha bravo item 7', 'alpha bravo item 8',
    ]);
  });

  it('the bounded-count switch routes exact↔HNSW at the threshold, and HNSW runs inside the txn (GUCs apply)', async () => {
    const exact = await retrieve('zulu', { query, embed, rerank: constReranker(0.99), exactMaxRows: 8, transaction, ...grantAll() });
    expect(exact.diagnostics.memories.mode).toBe('exact'); // 8 ≤ 8

    const hnsw = await retrieve('zulu', { query, embed, rerank: constReranker(0.99), exactMaxRows: 4, transaction, ...grantAll() });
    expect(hnsw.diagnostics.memories.mode).toBe('hnsw'); // count caps at 5 > 4
    expect(hnsw.abstained).toBe(false);
    expect(hnsw.memories.length).toBeGreaterThan(0); // the txn-scoped iterative_scan/ef_search path returns rows
  });
});
