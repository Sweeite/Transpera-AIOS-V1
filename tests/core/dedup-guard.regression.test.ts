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
import { freshDb, synthVector, vec, pgliteTx, type Query } from './helpers/pglite.ts';
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

  // ── #12 LEAK FIXTURE (#36-class) — the #3 obligation: a MORE-restrictive re-upload must RAISE the stored
  //    label, not silently keep the permissive one. The fix is invalidate-old + write-new at max sensitivity
  //    (§5 max-of-sources + §4.4 invalidate-don't-overwrite), proven here end-to-end through the txn runner. ──
  it('LEAK FIX: a more-restrictive (same-zone, higher-sensitivity) re-upload RELABELS — invalidate-old + write-new at max', async () => {
    const { db, query } = await freshDb();

    // Stored permissively at s1.
    const first = await writeMemory(query, baseInput({ sensitivityLevel: 1 }), { embed });
    expect(first.deduped).toBe(false);
    expect(first.memory.sensitivityLevel).toBe(1);

    // Re-upload of identical content demanding s4 → the restriction MUST now be applied (not just flagged).
    const hotter = await writeMemory(query, baseInput({ sensitivityLevel: 4 }), { embed, transaction: pgliteTx(db) });
    expect(hotter.deduped).toBe(true);
    expect(hotter.relabeled).toBe(true);
    expect(hotter.labelConflict).toBe(false); // resolved, not merely surfaced
    expect(hotter.memory.id).not.toBe(first.memory.id); // a NEW active row, not an in-place overwrite
    expect(hotter.memory.sensitivityLevel).toBe(4); // the wall was RAISED — the over-share is closed

    // The old permissive row is invalidated (preserved as history), exactly one active row remains, at s4.
    const oldRow = (await query(`SELECT status, sensitivity_level FROM memories WHERE id=$1`, [first.memory.id])).rows[0];
    expect(oldRow.status).toBe('invalidated');
    expect(oldRow.sensitivity_level).toBe(1); // history is verbatim — the OLD label is never mutated
    expect(await activeCount(query, 'org')).toBe(1);
    const active = (await query(`SELECT sensitivity_level FROM memories WHERE namespace='org' AND status='active'`)).rows[0];
    expect(active.sensitivity_level).toBe(4);

    // The successor carries a supersedes edge back to the invalidated row.
    const edge = (await query(`SELECT from_id, to_id FROM memory_links WHERE kind='supersedes'`)).rows[0];
    expect(edge.from_id).toBe(hotter.memory.id);
    expect(edge.to_id).toBe(first.memory.id);
  });

  it('relabel NEVER downgrades trust: the successor keeps the STORED provenance, not the (identical-content) re-upload’s', async () => {
    const { db, query } = await freshDb();
    // Original is HIGH trust (gates semantic promotion). A LOW-trust re-upload of the same text must not be
    // allowed to pull the stored trust down under the guise of a relabel — incoming is corroboration, not a swap.
    const first = await writeMemory(
      query,
      baseInput({ sensitivityLevel: 1, provenance: { sourceRefs: ['ref:trusted'], capturedAt: '2026-06-14T00:00:00Z', trustLevel: 'high' } }),
      { embed },
    );
    const hotter = await writeMemory(
      query,
      baseInput({ sensitivityLevel: 4, provenance: { sourceRefs: ['ref:sketchy'], capturedAt: '2026-06-14T00:00:00Z', trustLevel: 'low' } }),
      { embed, transaction: pgliteTx(db) },
    );
    expect(hotter.relabeled).toBe(true);
    const prov = (await query(`SELECT provenance FROM memories WHERE id=$1`, [hotter.memory.id])).rows[0].provenance;
    const p = typeof prov === 'string' ? JSON.parse(prov) : prov;
    expect(p.trustLevel).toBe('high'); // trust preserved — never silently downgraded on relabel
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
