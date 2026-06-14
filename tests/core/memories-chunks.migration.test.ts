/**
 * Issue #2 — ACCEPTANCE: "A row with an embedding inserts; a `<=>` vector search returns it ordered by
 * distance." Plus the structural guarantees the issue asks for (vector(1024) pinned to #1, HNSW + partial
 * indexes, the embedding_model/version stamp present from row one).
 *
 * Runs against pglite's real pgvector — this is the same DDL that runs on a client's Supabase.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, synthVector, vec } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';

describe('memories + chunks schema (#2)', () => {
  it('inserts a row with an embedding, then a <=> search returns it ordered by distance', async () => {
    const { query } = await freshDb();

    // Three rows at known geometric positions; `anchor` is closest to the query.
    const rows = [
      { key: 'anchor', text: 'the nearest thing' },
      { key: 'mid', text: 'somewhat related' },
      { key: 'far', text: 'unrelated' },
    ];
    for (const r of rows) {
      await query(
        `INSERT INTO memories (namespace, zone, sensitivity_level, statement, content_hash, embedding_model, embedding_version, embedding)
         VALUES ('org','general',1,$1,$2,$3,$4,$5::vector)`,
        [r.text, `sha256:${r.key}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(synthVector(r.key))],
      );
    }

    // Query vector == the anchor's vector ⇒ the anchor must come back first, distance ascending.
    const q = vec(synthVector('anchor'));
    const res = await query(
      `SELECT statement, (embedding <=> $1::vector)::float8 AS distance
         FROM memories
        ORDER BY embedding <=> $1::vector
        LIMIT 10`,
      [q],
    );

    expect(res.rows).toHaveLength(3);
    expect(res.rows[0].statement).toBe('the nearest thing');
    expect(res.rows[0].distance).toBeCloseTo(0, 6);
    const distances = res.rows.map((r) => r.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b)); // monotonic non-decreasing
  });

  it('stamps embedding_model/version on every row from row one', async () => {
    const { query } = await freshDb();
    await query(
      `INSERT INTO chunks (namespace, zone, sensitivity_level, text, content_hash, embedding_model, embedding_version, embedding)
       VALUES ('org','general',1,'hi','sha256:x',$1,$2,$3::vector)`,
      [EMBEDDING_MODEL, EMBEDDING_VERSION, vec(synthVector('x'))],
    );
    const res = await query(`SELECT embedding_model, embedding_version FROM chunks`);
    expect(res.rows[0].embedding_model).toBe(EMBEDDING_MODEL);
    expect(res.rows[0].embedding_version).toBe(EMBEDDING_VERSION);
    expect(res.rows[0].embedding_version).toBe('0-provisional'); // the #1 provisional pin
  });

  it('pins the vector dimension to #1 (vector(1024)) — a wrong-dimension insert is rejected', async () => {
    const { query } = await freshDb();
    // Column dimension matches the gateway pin, on BOTH tables.
    for (const table of ['memories', 'chunks']) {
      const res = await query(
        `SELECT a.atttypmod AS typmod
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname = $1 AND a.attname = 'embedding'`,
        [table],
      );
      // pgvector stores N directly in atttypmod (no -4 VARHDRSZ offset).
      expect(res.rows[0].typmod).toBe(EMBEDDING_DIM);
    }
    expect(EMBEDDING_DIM).toBe(1024);

    // A 3-dim vector must not fit a vector(1024) column.
    await expect(
      query(
        `INSERT INTO memories (namespace, zone, sensitivity_level, statement, content_hash, embedding_model, embedding_version, embedding)
         VALUES ('org','general',1,'bad','sha256:bad','m','v','[1,2,3]'::vector)`,
      ),
    ).rejects.toThrow();
  });

  it('creates an HNSW index and a partial index on zone=general for both tables', async () => {
    const { query } = await freshDb();
    const res = await query(`SELECT indexdef FROM pg_indexes WHERE tablename IN ('memories','chunks')`);
    const defs = res.rows.map((r) => r.indexdef.toLowerCase());
    for (const table of ['memories', 'chunks']) {
      expect(defs.some((d) => d.includes(table) && d.includes('using hnsw'))).toBe(true);
      expect(defs.some((d) => d.includes(table) && d.includes("zone") && d.includes("'general'"))).toBe(true);
    }
  });

  it('enforces sensitivity_level in the 1..5 band (fail-closed on a bad label)', async () => {
    const { query } = await freshDb();
    await expect(
      query(
        `INSERT INTO memories (namespace, zone, sensitivity_level, statement, content_hash, embedding_model, embedding_version, embedding)
         VALUES ('org','general',6,'too hot','sha256:z','m','v',$1::vector)`,
        [vec(synthVector('z'))],
      ),
    ).rejects.toThrow();
  });
});
