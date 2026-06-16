/**
 * Issue #14 — CONTENT EGRESS on the denied path. rerank() sends memory STATEMENTS to a new vendor (Voyage,
 * ADR 0003) on the retrieval path. The fail-closed guarantee is therefore stronger than "zero rows returned":
 * a principal who cannot see a memory must never cause its text to be SENT to the reranker at all. The
 * permission predicate filters in the WHERE of BOTH legs (#13), so a forbidden row never enters the fused set
 * and never reaches the reranker — this fixture PROVES that egress boundary with a spy, not just the output.
 *
 * This is a #36-class leak fixture: a forbidden statement reaching the reranker would be a red-line breach.
 */
import { describe, it, expect } from 'vitest';
import type { Principal } from '@aios/shared';
import { freshDb, vec, type Query } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION, type Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { grantNothing } from './helpers/grant.ts';
import { spyReranker } from './helpers/rerank.ts';

const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
const embed: Embedder = async (texts) => texts.map(() => E0);
const USER = (userId: string): Principal => ({ kind: 'user', userId });
const FORBIDDEN = 'SECRET: Acme contract margin is 42 percent';

async function insertMem(query: Query, o: { ns?: string; zone?: string; sens?: number; statement: string }) {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ($1,$2,$3,'semantic',$4,$5,'{}'::jsonb,$6,$7,$8::vector)`,
    [o.ns ?? 'org', o.zone ?? 'general', o.sens ?? 1, o.statement, `sha256:${o.statement}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(E0)],
  );
}
async function seedClearance(query: Query, userId: string, zones: string[], maxSensitivity: number, namespaces: string[]) {
  await query(
    `INSERT INTO user_clearance (principal_id, allowed_zones, max_sensitivity, allowed_namespaces)
     VALUES ($1, $2::text[], $3, $4::text[])`,
    [userId, zones, maxSensitivity, namespaces],
  );
}

describe('#14 reranker content egress (fail-closed)', () => {
  it('an empty clearance (denyAll) sends NOTHING to the reranker — zero content egress, not just zero rows', async () => {
    const { query } = await freshDb();
    await insertMem(query, { statement: FORBIDDEN, sens: 5 }); // an exact-match row the user must not see
    const spy = spyReranker();

    const out = await retrieve('Acme contract margin', { query, embed, rerank: spy.rerank, ...grantNothing() });

    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
    expect(spy.calls).toEqual([]); // the reranker was NEVER called — the forbidden text never left the DB
  });

  it('a namespace-forbidden row never reaches the reranker (filtered pre-rank, via the REAL resolver)', async () => {
    const { query } = await freshDb();
    // The only matching row is in client:acme; the principal is cleared for `org` only.
    await insertMem(query, { ns: 'client:acme', zone: 'general', sens: 1, statement: FORBIDDEN });
    await seedClearance(query, 'org_only', ['general'], 5, ['org']);
    const spy = spyReranker();

    const out = await retrieve('Acme contract margin', { query, embed, rerank: spy.rerank, principal: USER('org_only') });

    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
    // Even if the reranker was reached for some other (authorized) candidate, the FORBIDDEN statement must
    // never be among the documents sent — assert on the egress payload itself, not just the returned rows.
    const everySentDoc = spy.calls.flatMap((c) => c.documents);
    expect(everySentDoc).not.toContain(FORBIDDEN);
    expect(spy.calls).toEqual([]); // here there is no authorized candidate at all ⇒ no call
  });
});
