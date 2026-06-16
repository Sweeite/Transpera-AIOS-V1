/**
 * Issue #13 / #36-class LEAK FIXTURES — the milestone gate. retrieve() is FAIL-CLOSED on ALL THREE axes
 * (zone, sensitivity, namespace) end-to-end, through the REAL getClearance resolver (a seeded user_clearance
 * row — NOT an injected clearance), across BOTH stores (memories AND chunks). Each `it` is a permanent
 * regression test for one fail-OPEN shape; a single forbidden row surfacing here is a red-line breach.
 *
 * The headline #13 acceptance: a principal authorized for `org` CANNOT retrieve `client:acme` rows even when
 * cleared on zone + sensitivity (the namespace axis #13 absorbed — previously wide open).
 *
 * Method: seed a VISIBLE row (so the outcome is NOT abstained and the surfaced set is non-empty) alongside a
 * FORBIDDEN row on the axis under test; assert the forbidden row NEVER appears in memories OR chunks. Every
 * row sits at the SAME query vector (cosine 1), so only the permission filter — never relevance — hides it.
 */
import { describe, it, expect } from 'vitest';
import type { Principal } from '@aios/shared';
import { freshDb, vec, type Query } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';

const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
const embed: Embedder = async (texts) => texts.map(() => E0);
const USER = (userId: string): Principal => ({ kind: 'user', userId });

async function seedClearance(query: Query, userId: string, zones: string[], maxSensitivity: number, namespaces: string[]) {
  await query(
    `INSERT INTO user_clearance (principal_id, allowed_zones, max_sensitivity, allowed_namespaces)
     VALUES ($1, $2::text[], $3, $4::text[])`,
    [userId, zones, maxSensitivity, namespaces],
  );
}
async function insertMem(query: Query, o: { ns?: string; zone: string; sens?: number; statement: string }) {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ($1,$2,$3,'semantic',$4,$5,'{}'::jsonb,$6,$7,$8::vector)`,
    [o.ns ?? 'org', o.zone, o.sens ?? 1, o.statement, `sha256:${o.statement}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(E0)],
  );
}
async function insertChunk(query: Query, o: { ns?: string; zone: string; sens?: number; text: string }) {
  await query(
    `INSERT INTO chunks (namespace, zone, sensitivity_level, text, content_hash, provenance,
                         embedding_model, embedding_version, embedding)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8::vector)`,
    [o.ns ?? 'org', o.zone, o.sens ?? 1, o.text, `sha256:${o.text}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(E0)],
  );
}

/** Run retrieve() through the REAL resolver (seeded row) and return the surfaced statements/texts. */
async function visible(query: Query, userId: string) {
  const out = await retrieve('q', { query, embed, principal: USER(userId) });
  return {
    out,
    memTexts: out.memories.map((m) => m.statement),
    chunkTexts: out.chunks.map((c) => c.text),
  };
}

describe('#13 / #36 leak fixtures — retrieve() fail-closed on every axis, both stores', () => {
  it('(namespace leak) org-authorized CANNOT read client:acme — even cleared on zone + sensitivity', async () => {
    const { query } = await freshDb();
    await seedClearance(query, 'u', ['general'], 5, ['org']); // org only; zone+sensitivity deliberately permissive
    await insertMem(query, { ns: 'org', zone: 'general', statement: 'VISIBLE org memory' });
    await insertMem(query, { ns: 'client:acme', zone: 'general', sens: 1, statement: 'LEAK acme memory' });
    await insertChunk(query, { ns: 'org', zone: 'general', text: 'VISIBLE org chunk' });
    await insertChunk(query, { ns: 'client:acme', zone: 'general', sens: 1, text: 'LEAK acme chunk' });

    const { out, memTexts, chunkTexts } = await visible(query, 'u');
    expect(out.abstained).toBe(false);
    expect(memTexts).toEqual(['VISIBLE org memory']);
    expect(chunkTexts).toEqual(['VISIBLE org chunk']);
    expect(memTexts).not.toContain('LEAK acme memory');
    expect(chunkTexts).not.toContain('LEAK acme chunk');
  });

  it('(zone leak) general-cleared CANNOT read finance — both stores', async () => {
    const { query } = await freshDb();
    await seedClearance(query, 'u', ['general'], 5, ['org']);
    await insertMem(query, { zone: 'general', statement: 'VISIBLE general memory' });
    await insertMem(query, { zone: 'finance', statement: 'LEAK finance memory' });
    await insertChunk(query, { zone: 'general', text: 'VISIBLE general chunk' });
    await insertChunk(query, { zone: 'finance', text: 'LEAK finance chunk' });

    const { memTexts, chunkTexts } = await visible(query, 'u');
    expect(memTexts).toEqual(['VISIBLE general memory']);
    expect(chunkTexts).toEqual(['VISIBLE general chunk']);
  });

  it('(sensitivity leak) max s2 CANNOT read an s5 row in an allowed zone — both stores', async () => {
    const { query } = await freshDb();
    await seedClearance(query, 'u', ['general'], 2, ['org']);
    await insertMem(query, { zone: 'general', sens: 2, statement: 'VISIBLE s2 memory' });
    await insertMem(query, { zone: 'general', sens: 5, statement: 'LEAK s5 memory' });
    await insertChunk(query, { zone: 'general', sens: 2, text: 'VISIBLE s2 chunk' });
    await insertChunk(query, { zone: 'general', sens: 5, text: 'LEAK s5 chunk' });

    const { memTexts, chunkTexts } = await visible(query, 'u');
    expect(memTexts).toEqual(['VISIBLE s2 memory']);
    expect(chunkTexts).toEqual(['VISIBLE s2 chunk']);
  });

  it('(empty-IN fail-open) an empty-clearance row ⇒ WHERE false ⇒ ZERO rows on both stores (not everything)', async () => {
    const { query } = await freshDb();
    await seedClearance(query, 'u', [], 5, []); // explicit empty on every axis
    await insertMem(query, { zone: 'general', statement: 'must-not-surface memory' });
    await insertChunk(query, { zone: 'general', text: 'must-not-surface chunk' });

    const { out, memTexts, chunkTexts } = await visible(query, 'u');
    expect(out.abstained).toBe(true);
    expect(memTexts).toEqual([]);
    expect(chunkTexts).toEqual([]);
    // sanity: the data really is there — the filter hides it, not an empty table
    expect((await query(`SELECT count(*)::int n FROM memories`)).rows[0].n).toBe(1);
    expect((await query(`SELECT count(*)::int n FROM chunks`)).rows[0].n).toBe(1);
  });

  it('(unprovisioned leak) a principal with NO clearance row ⇒ ZERO rows on both stores', async () => {
    const { query } = await freshDb();
    // No seedClearance — the real resolver denies a missing row.
    await insertMem(query, { zone: 'general', statement: 'must-not-surface memory' });
    await insertChunk(query, { zone: 'general', text: 'must-not-surface chunk' });

    const { out, memTexts, chunkTexts } = await visible(query, 'never-provisioned');
    expect(out.abstained).toBe(true);
    expect(memTexts).toEqual([]);
    expect(chunkTexts).toEqual([]);
  });

  it('(service leak) a SERVICE principal sees nothing on the retrieval axis — both stores', async () => {
    const { query } = await freshDb();
    await seedClearance(query, 'svc', ['general', 'finance'], 5, ['org']); // a user row with the SAME id string
    await insertMem(query, { zone: 'general', statement: 'must-not-surface memory' });
    await insertChunk(query, { zone: 'general', text: 'must-not-surface chunk' });

    const out = await retrieve('q', { query, embed, principal: { kind: 'service', serviceId: 'svc' } });
    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
    expect(out.chunks).toEqual([]);
  });
});
