/**
 * M2 COLLECTIVE GATE — the named, scripted end-to-end seam (QA Playbook Level 3, the M2 checkpoint).
 *
 * "All issues closed ≠ milestone done." #12/#13/#14/#15 each pass in isolation; this proves they COMPOSE in
 * one real flow — the seam where integration bugs hide. The Playbook's M2 scenario, verbatim:
 *
 *   Write → invalidate → fail-closed hybrid retrieve:
 *     (1) a RESTRICTED user gets perfect-recall AND zero forbidden rows,
 *     (2) an invalidated fact never resurfaces,
 *     (3) empty-clearance returns NOTHING (not everything).
 *
 * Composition under test (no mocks but the hermetic embedder + the injected reranker, exactly as the suite runs):
 *   - #13 fail-closed predicate (zone ∧ sensitivity ∧ namespace) applied in SQL, identically on both legs, BEFORE
 *     ranking — a forbidden row is never even a candidate.
 *   - #13 hybrid dense+keyword RRF fusion + the selectivity switch (small N ⇒ exact path, perfect recall).
 *   - #14 reranker floor (faked high here — the floor is proven in reranker-floor.test.ts; here it must simply not
 *     swallow a permitted, relevant row).
 *   - #12 invalidate(): a base `status='active'` conjunct ANDed with the predicate — an invalidated fact drops out
 *     of the SAME composed pipeline, even while still permission-permitted.
 *
 * Hermetic: pglite (the client's migration SQL) + deterministic injected embedder + injected reranker.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, synthVector, pgliteTx, type Query } from './helpers/pglite.ts';
import { writeMemory, invalidate, type WriteMemoryInput } from '../../packages/core/src/memory/store.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { grantAll, grantNothing } from './helpers/grant.ts';
import { constReranker } from './helpers/rerank.ts';

const embed = async (texts: string[]) => texts.map((t) => synthVector(t));

// A RESTRICTED user: general zone only, sensitivity ≤ 2, org namespace only. Each forbidden seed below trips
// exactly ONE axis, so a leak on any single axis is caught distinctly.
const restricted = () => grantAll({ allowedZones: ['general'], maxSensitivity: 2, allowedNamespaces: ['org'] });

const seed = (over: Partial<WriteMemoryInput>): WriteMemoryInput => ({
  type: 'semantic',
  namespace: 'org',
  zone: 'general',
  sensitivityLevel: 1,
  statement: 'we use vendor Acme for payments',
  provenance: { sourceRefs: ['ref:1'], capturedAt: '2026-06-14T00:00:00Z', trustLevel: 'high' },
  ...over,
});

const QUERY = 'vendor Acme payments';
// The floor is faked high so this seam isolates COMPOSITION, not the floor (that's reranker-floor.test.ts).
const rerank = constReranker(0.99);

async function dbActiveIds(query: Query): Promise<string[]> {
  const r = await query(`SELECT id FROM memories WHERE status='active' ORDER BY id`);
  return r.rows.map((x: any) => x.id);
}

describe('M2 collective gate — Write → invalidate → fail-closed hybrid retrieve (QA Playbook Level 3)', () => {
  it('a restricted user gets PERFECT RECALL + ZERO forbidden rows; an invalidated fact never resurfaces; empty-clearance returns nothing', async () => {
    const { db, query } = await freshDb();

    // ── Write: one permitted fact + one forbidden fact per axis (all content-similar to the query, so only the
    //    PERMISSION predicate — not relevance — can be what excludes them) ──────────────────────────────────────
    const ok = await writeMemory(query, seed({ statement: 'we use vendor Acme for payments' }), { embed });
    const badZone = await writeMemory(
      query, seed({ zone: 'finance', statement: 'the finance vendor Acme handles payments' }), { embed },
    );
    const badSens = await writeMemory(
      query, seed({ sensitivityLevel: 5, statement: 'confidential vendor Acme payment terms' }), { embed },
    );
    const badNs = await writeMemory(
      query, seed({ namespace: 'client:acme', statement: 'client vendor Acme payments record' }), { embed },
    );
    const forbidden = new Set([badZone.memory.id, badSens.memory.id, badNs.memory.id]);

    // Sanity: all four are live in the DB — so what follows is the PREDICATE filtering, not absent data.
    expect(await dbActiveIds(query)).toEqual([ok, badZone, badSens, badNs].map((w) => w.memory.id).sort());

    // ── (1) PERFECT RECALL + ZERO FORBIDDEN ROWS: the permitted fact returns; not one forbidden row does ───────
    const r1 = await retrieve(QUERY, { query, embed, rerank, floor: 0.5, ...restricted() });
    expect(r1.abstained).toBe(false);
    expect(r1.memories.map((m) => m.id)).toEqual([ok.memory.id]); // perfect recall of the ONE permitted match
    for (const m of r1.memories) expect(forbidden.has(m.id)).toBe(false); // zero forbidden rows (all 3 axes)
    // Defense in depth: no forbidden STATEMENT leaked into the surfaced payload either (not just no ids).
    const surfaced = JSON.stringify(r1.memories);
    expect(surfaced).not.toContain('finance vendor');
    expect(surfaced).not.toContain('confidential');
    expect(surfaced).not.toContain('client vendor');

    // ── (2) AN INVALIDATED FACT NEVER RESURFACES: invalidate the ONE visible row → the same query goes empty ──
    await invalidate(query, ok.memory.id, { code: 'feedback_wrong', note: 'vendor changed' }, { transaction: pgliteTx(db) });
    const r2 = await retrieve(QUERY, { query, embed, rerank, floor: 0.5, ...restricted() });
    // It is still permission-permitted (general/s1/org) — only the status='active' conjunct removes it. Proves
    // #12 composes with the #13 predicate rather than being a swappable part of it. Abstains: no candidate clears.
    expect(r2.memories.map((m) => m.id)).toEqual([]);
    expect(r2.abstained).toBe(true);

    // ── (3) EMPTY-CLEARANCE RETURNS NOTHING, NOT EVERYTHING (the fail-OPEN empty-IN trap, in the composed flow) ─
    // Re-write a fresh permitted fact so the corpus is NON-empty — an empty result here can only be the predicate
    // compiling to WHERE false, never "there was nothing to find".
    await writeMemory(query, seed({ statement: 'we now use vendor Globex for payments' }), { embed });
    const r3 = await retrieve(QUERY, { query, embed, rerank, floor: 0.5, ...grantNothing() });
    expect(r3.memories).toEqual([]); // WHERE false ⇒ zero rows, never the whole corpus
    expect(r3.abstained).toBe(true);
  });
});
