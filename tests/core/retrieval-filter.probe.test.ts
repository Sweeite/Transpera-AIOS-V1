/**
 * Issue #2 — PROBE (QA Playbook: try to make it leak / lie / fail silently). These assert properties beyond
 * the headline acceptance: the predicate composed WITH a `<=>` ranking query (the real retrieval shape),
 * defense-in-depth of the empty-array floor, and fail-closed writes. Anything found here is a permanent
 * regression test.
 */
import { describe, it, expect } from 'vitest';
import type { Clearance } from '../../packages/shared/src/types.ts';
import { buildRetrievalPredicate, retrievalWhereSql } from '../../packages/core/src/rbac/permissions.ts';
import { freshDb, synthVector, vec } from './helpers/pglite.ts';
import { seedDemoRows } from './helpers/seed.ts';

describe('retrieval predicate composed with ranking (#2 probe)', () => {
  it('filter + <=> ranking in ONE query: clearance holds while ordering by distance (param offset works)', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);

    // Real shape: $1 is the query vector, clearance params start at $2.
    const pred = buildRetrievalPredicate({ allowedZones: ['general', 'finance'], maxSensitivity: 3 }, ['org']);
    const { sql, params } = retrievalWhereSql(pred, 2);
    expect(sql).toBe('zone = ANY($2) AND sensitivity_level <= $3 AND namespace = ANY($4)');

    const q = vec(synthVector('fin-1')); // nearest to the finance/s3 row
    const res = await query(
      `SELECT content_hash, (embedding <=> $1::vector)::float8 AS distance
         FROM chunks
        WHERE ${sql}
        ORDER BY embedding <=> $1::vector
        LIMIT 10`,
      [q, ...params],
    );
    const keys = res.rows.map((r) => r.content_hash.replace('sha256:', ''));

    // Visible set obeys clearance: general(s1,s2) + finance(s3) — never fin-2(s4) or hr-1(s5).
    expect(new Set(keys)).toEqual(new Set(['gen-1', 'gen-2', 'fin-1']));
    expect(keys).not.toContain('fin-2');
    expect(keys).not.toContain('hr-1');
    // Ranking survived the filter: fin-1 is nearest, distances ascending.
    expect(keys[0]).toBe('fin-1');
    const d = res.rows.map((r) => r.distance);
    expect(d).toEqual([...d].sort((a, b) => a - b));
  });

  it('defense in depth: an empty zone list NEVER widens to everything, even if denyAll were wrong', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);

    // Hand-craft a corrupt predicate: denyAll falsely false, zones empty. `= ANY('{}')` must match nothing.
    const corrupt = { zones: [], maxSensitivity: 5, namespaces: ['org'], denyAll: false } as ReturnType<
      typeof buildRetrievalPredicate
    >;
    const { sql, params } = retrievalWhereSql(corrupt);
    const res = await query(`SELECT content_hash FROM chunks WHERE ${sql}`, params);
    expect(res.rows.length).toBe(0); // NOT all 5 — the empty IN/ANY trap is closed at the SQL level too
  });

  it('a row that cannot declare its access label is rejected (fail-closed write)', async () => {
    const { query } = await freshDb();
    // NULL zone must not insert — there is no "unlabelled" row that could dodge the filter.
    await expect(
      query(
        `INSERT INTO memories (namespace, zone, sensitivity_level, statement, content_hash, embedding_model, embedding_version, embedding)
         VALUES ('org', NULL, 1, 's', 'h', 'm', 'v', $1::vector)`,
        [vec(synthVector('n'))],
      ),
    ).rejects.toThrow();
    // NULL embedding likewise (an unsearchable row is a silent black hole).
    await expect(
      query(
        `INSERT INTO memories (namespace, zone, sensitivity_level, statement, content_hash, embedding_model, embedding_version, embedding)
         VALUES ('org', 'general', 1, 's', 'h', 'm', 'v', NULL)`,
      ),
    ).rejects.toThrow();
  });

  it('a zone the user is not cleared for is invisible even when it is the nearest vector', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);

    // Query is literally the hr-1 vector, but the user has no hr clearance ⇒ hr-1 must not surface at all.
    const clearance: Clearance = { allowedZones: ['general'], maxSensitivity: 5 };
    const pred = buildRetrievalPredicate(clearance, ['org']);
    const { sql, params } = retrievalWhereSql(pred, 2);
    const q = vec(synthVector('hr-1'));
    const res = await query(
      `SELECT content_hash FROM chunks WHERE ${sql} ORDER BY embedding <=> $1::vector LIMIT 10`,
      [q, ...params],
    );
    const keys = res.rows.map((r) => r.content_hash.replace('sha256:', ''));
    expect(keys).not.toContain('hr-1'); // nearest-but-forbidden is still hidden
    expect(keys.every((k) => k.startsWith('gen-'))).toBe(true);
  });
});
