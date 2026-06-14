/**
 * Issue #7 closes #3's DEFERRED dedup guard (the TOCTOU race). #3 dedup was app-level check-then-insert:
 * a SELECT, then INSERT if absent — fine for one writer, unsafe once the worker tier ingests concurrently
 * (#17). 0004 added the partial UNIQUE (namespace, content_hash) WHERE status='active'; writeMemory() now
 * inserts ON CONFLICT DO NOTHING and re-reads the winner.
 *
 * These tests target the DB-LEVEL guard specifically — i.e. the protection that survives even when the
 * app-level pre-SELECT is defeated (exactly the race window #3 left open).
 */
import { describe, it, expect } from 'vitest';
import { freshDb, synthVector, vec, type Query } from './helpers/pglite.ts';
import { writeMemory, type WriteMemoryInput } from '../../packages/core/src/memory/store.ts';
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';

const embed = async (texts: string[]) => texts.map((t) => synthVector(t));

const baseInput = (over: Partial<WriteMemoryInput> = {}): WriteMemoryInput => ({
  type: 'semantic',
  namespace: 'org',
  zone: 'general',
  sensitivityLevel: 1,
  statement: 'the quarterly board meeting is the first Tuesday of each quarter',
  provenance: { sourceRefs: ['ref:1'], capturedAt: '2026-06-14T00:00:00Z', trustLevel: 'high' },
  ...over,
});

/** Count ACTIVE rows for a (namespace, content_hash) — the set the partial unique index constrains. */
async function activeCount(query: Query, namespace: string): Promise<number> {
  const r = await query(`SELECT count(*)::int AS n FROM memories WHERE namespace = $1 AND status = 'active'`, [
    namespace,
  ]);
  return r.rows[0].n;
}

describe('#3 dedup guard closed at the DB level (#7)', () => {
  it('the partial UNIQUE rejects a SECOND active row with the same (namespace, content_hash) — the race backstop', async () => {
    const { query } = await freshDb();
    // First legitimate write.
    const first = await writeMemory(query, baseInput(), { embed });
    expect(first.deduped).toBe(false);

    // Simulate the lost race: a raw INSERT that BYPASSES writeMemory's pre-SELECT (as a concurrent worker
    // would, having passed its own SELECT a microsecond earlier). The DB must reject it.
    const rawDuplicate = query(
      `INSERT INTO memories
         (namespace, zone, sensitivity_level, type, statement, content_hash, status,
          embedding_model, embedding_version, embedding)
       VALUES ($1,'general',1,'semantic',$2,$3,'active',$4,$5,$6::vector)`,
      [
        'org',
        baseInput().statement,
        first.memory.contentHash,
        EMBEDDING_MODEL,
        EMBEDDING_VERSION,
        vec(synthVector('dup')),
      ],
    );
    await expect(rawDuplicate).rejects.toThrow(/unique|duplicate/i);
    expect(await activeCount(query, 'org')).toBe(1); // still exactly one active row
  });

  it('writeMemory ON CONFLICT path: a duplicate that slips past the pre-SELECT re-reads the winner, no 2nd row', async () => {
    const { query } = await freshDb();
    const first = await writeMemory(query, baseInput(), { embed });
    expect(first.deduped).toBe(false);

    // Force the ON CONFLICT branch: wrap query so the pre-SELECT sees NOTHING (as if the row appeared after
    // our SELECT), but the INSERT hits the live unique index → DO NOTHING → re-read the winner.
    let blindedFirstSelect = true;
    const racingQuery: Query = async (sql, params) => {
      if (blindedFirstSelect && /SELECT .* FROM memories WHERE namespace/i.test(sql)) {
        blindedFirstSelect = false; // blind only the pre-SELECT; the post-conflict re-read must see the winner
        return { rows: [] };
      }
      return query(sql, params);
    };

    const second = await writeMemory(racingQuery, baseInput(), { embed });
    expect(second.deduped).toBe(true); // resolved via ON CONFLICT → re-read, not the fast path
    expect(second.memory.id).toBe(first.memory.id); // it really is the winner's row
    expect(await activeCount(query, 'org')).toBe(1); // the DB held the line
  });

  it('an INVALIDATED row does NOT block a new active row with the same hash (the index is partial, §4.4)', async () => {
    const { query } = await freshDb();
    const first = await writeMemory(query, baseInput(), { embed });

    // Invalidate it (what #12 will do): the partial index no longer covers this row.
    await query(`UPDATE memories SET status = 'invalidated', valid_to = now() WHERE id = $1`, [first.memory.id]);

    // A fresh write of identical content must now succeed (supersession is legal; only DOUBLE-ACTIVE is barred).
    const second = await writeMemory(query, baseInput(), { embed });
    expect(second.deduped).toBe(false);
    expect(second.memory.id).not.toBe(first.memory.id);
    expect(await activeCount(query, 'org')).toBe(1); // exactly one ACTIVE, plus one invalidated in history
  });
});
