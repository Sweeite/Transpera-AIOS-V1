/**
 * Issue #3 — ACCEPTANCE: the write half of the M0 slice.
 *   "Uploading an SOP produces one `procedural` memory with an embedding, content-hash, and provenance refs."
 *   "Re-uploading identical content is deduped by `content_hash`."
 *
 * Hermetic: pglite (the same migration SQL a client's Supabase runs) + an INJECTED deterministic embedder,
 * so this never touches the network. The REAL gateway.embed() (OpenAI) is exercised separately, gated on a
 * key, in embed.integration.test.ts — writeMemory()'s default embedder IS gateway.embed in production.
 *
 * The dedup tests are the load-bearing ones: dedup is NAMESPACE-SCOPED (#2 proved identical text coexists
 * across clients), and normalised (trivial whitespace/case diffs collapse). A regression here either evicts
 * one client's memory (global dedup) or silently re-embeds duplicates.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, synthVector } from './helpers/pglite.ts';
import { writeMemory, ingestSop } from '../../packages/core/src/memory/store.ts';
import type { Embedder } from '../../packages/core/src/memory/store.ts';
import type { Provenance } from '../../packages/shared/src/types.ts';
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';

/** A deterministic stand-in for gateway.embed() — counts calls so we can prove dedup skips re-embedding. */
function fakeEmbedder() {
  const calls: string[][] = [];
  const embed: Embedder = async (texts) => {
    calls.push(texts);
    return texts.map((t) => synthVector(t));
  };
  return { embed, calls };
}

const PROV: Provenance = {
  sourceRefs: ['upload://sop/client-onboarding.pdf#v1'],
  author: 'ops@agency.example',
  capturedAt: '2026-06-14T10:00:00.000Z',
  trustLevel: 'high', // a manual SOP upload is HIGH trust (§5 anti-poisoning)
};

describe('writeMemory() happy path (#3)', () => {
  it('uploading an SOP produces one procedural memory with embedding + content-hash + provenance refs', async () => {
    const { query } = await freshDb();
    const { embed, calls } = fakeEmbedder();

    const { memory, deduped } = await writeMemory(
      query,
      {
        type: 'procedural',
        namespace: 'org',
        zone: 'general',
        sensitivityLevel: 1,
        statement: 'To onboard a new client: create the workspace, invite the team, set the kickoff.',
        provenance: PROV,
      },
      { embed },
    );

    expect(deduped).toBe(false);
    expect(calls).toHaveLength(1); // embedded exactly once

    const rows = (await query(`SELECT count(*)::int AS n FROM memories`)).rows;
    expect(rows[0].n).toBe(1);

    const row = (
      await query(
        `SELECT type, zone, sensitivity_level, content_hash, provenance,
                embedding_model, embedding_version, vector_dims(embedding) AS dims
           FROM memories WHERE id = $1`,
        [memory.id],
      )
    ).rows[0];

    expect(row.type).toBe('procedural');
    expect(row.zone).toBe('general');
    expect(row.sensitivity_level).toBe(1);
    expect(row.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.dims).toBe(1024);
    expect(row.embedding_model).toBe(EMBEDDING_MODEL);
    expect(row.embedding_version).toBe(EMBEDDING_VERSION);
    // provenance carries REFS, never raw content (#3 Watch).
    expect(row.provenance.sourceRefs).toEqual(PROV.sourceRefs);
    expect(row.provenance.trustLevel).toBe('high');
  });

  it('re-uploading identical content is deduped by content_hash — one row, no re-embed', async () => {
    const { query } = await freshDb();
    const { embed, calls } = fakeEmbedder();
    const input = {
      type: 'procedural' as const,
      namespace: 'org' as const,
      zone: 'general',
      sensitivityLevel: 1 as const,
      statement: 'Always BCC accounts on a signed SOW.',
      provenance: PROV,
    };

    const first = await writeMemory(query, input, { embed });
    const second = await writeMemory(query, input, { embed });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.memory.id).toBe(first.memory.id); // same row returned, not a new one
    expect(calls).toHaveLength(1); // the dup skipped embedding entirely
    expect((await query(`SELECT count(*)::int AS n FROM memories`)).rows[0].n).toBe(1);
  });

  it('normalises before hashing — trivial whitespace/case differences dedup', async () => {
    const { query } = await freshDb();
    const { embed } = fakeEmbedder();
    const base = { type: 'procedural' as const, namespace: 'org' as const, zone: 'general', sensitivityLevel: 1 as const, provenance: PROV };

    await writeMemory(query, { ...base, statement: 'Escalate blockers within one hour.' }, { embed });
    const dup = await writeMemory(query, { ...base, statement: '  ESCALATE   blockers within ONE hour.  ' }, { embed });

    expect(dup.deduped).toBe(true);
    expect((await query(`SELECT count(*)::int AS n FROM memories`)).rows[0].n).toBe(1);
  });

  it('dedup is NAMESPACE-SCOPED — identical content coexists across clients (guards #2)', async () => {
    const { query } = await freshDb();
    const { embed, calls } = fakeEmbedder();
    const statement = 'Invoices are net-30 unless the MSA says otherwise.';

    const acme = await writeMemory(query, { type: 'semantic', namespace: 'client:acme', zone: 'finance', sensitivityLevel: 3, statement, provenance: PROV }, { embed });
    const north = await writeMemory(query, { type: 'semantic', namespace: 'client:northwind', zone: 'finance', sensitivityLevel: 3, statement, provenance: PROV }, { embed });

    expect(acme.deduped).toBe(false);
    expect(north.deduped).toBe(false); // NOT deduped — different namespace
    expect(acme.memory.contentHash).toBe(north.memory.contentHash); // same hash, different rows
    expect(acme.memory.id).not.toBe(north.memory.id);
    expect(calls).toHaveLength(2); // both embedded — neither was a dup
    expect((await query(`SELECT count(*)::int AS n FROM memories`)).rows[0].n).toBe(2);
  });

  it('flags labelConflict when a dedup re-upload is MORE restrictive — does not silently under-classify (principle #2)', async () => {
    const { query } = await freshDb();
    const { embed } = fakeEmbedder();
    const statement = 'Client roster lives in the shared drive.';
    const base = { type: 'semantic' as const, namespace: 'org' as const, statement, provenance: PROV };

    // Stored at general / s1.
    const first = await writeMemory(query, { ...base, zone: 'general', sensitivityLevel: 1 }, { embed });
    expect(first.deduped).toBe(false);
    expect(first.labelConflict).toBe(false);

    // Re-upload demanding HIGHER sensitivity → deduped, but the restriction is NOT applied → conflict flagged.
    const hotter = await writeMemory(query, { ...base, zone: 'general', sensitivityLevel: 4 }, { embed });
    expect(hotter.deduped).toBe(true);
    expect(hotter.labelConflict).toBe(true);
    expect(hotter.memory.sensitivityLevel).toBe(1); // stored label unchanged (relabel is #12)

    // Re-upload into a DIFFERENT zone → also a conflict (zones aren't ordinal; any difference is surfaced).
    const elsewhere = await writeMemory(query, { ...base, zone: 'finance', sensitivityLevel: 1 }, { embed });
    expect(elsewhere.deduped).toBe(true);
    expect(elsewhere.labelConflict).toBe(true);

    // Re-upload LESS restrictive (same zone, lower-or-equal sensitivity) → no conflict; stored is already safe.
    const cooler = await writeMemory(query, { ...base, zone: 'general', sensitivityLevel: 1 }, { embed });
    expect(cooler.deduped).toBe(true);
    expect(cooler.labelConflict).toBe(false);
  });

  it('never writes raw statement text into provenance (refs only, #3 Watch)', async () => {
    const { query } = await freshDb();
    const { embed } = fakeEmbedder();
    const statement = 'SECRET-CANARY-PHRASE that must not appear in provenance.';
    const { memory } = await writeMemory(query, { type: 'procedural', namespace: 'org', zone: 'general', sensitivityLevel: 1, statement, provenance: PROV }, { embed });

    const provJson = JSON.stringify((await query(`SELECT provenance FROM memories WHERE id = $1`, [memory.id])).rows[0].provenance);
    expect(provJson).not.toContain('SECRET-CANARY-PHRASE');
  });
});

describe('memories schema additions (#3 migration 0002)', () => {
  it('persists type with a CHECK that excludes non-persistable working memory (§4.1)', async () => {
    const { query } = await freshDb();
    // 'working' memory never persists — the CHECK is a fail-closed guard against it landing in the table.
    await expect(
      query(
        `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance, embedding_model, embedding_version, embedding)
         VALUES ('org','general',1,'working','x','sha256:x','{}'::jsonb,$1,$2,$3::vector)`,
        [EMBEDDING_MODEL, EMBEDDING_VERSION, `[${synthVector('x').join(',')}]`],
      ),
    ).rejects.toThrow();
  });
});

describe('ingestSop() entrypoint (#3)', () => {
  it('turns an uploaded SOP into a HIGH-trust procedural memory with a sensible default access label', async () => {
    const { query } = await freshDb();
    const { embed } = fakeEmbedder();

    const { memory } = await ingestSop(
      query,
      { namespace: 'org', statement: 'SOP: weekly client status email every Friday by 4pm.', sourceRef: 'upload://sop/status-cadence.pdf' },
      { embed },
    );

    const row = (await query(`SELECT type, zone, sensitivity_level, provenance FROM memories WHERE id = $1`, [memory.id])).rows[0];
    expect(row.type).toBe('procedural');
    expect(row.zone).toBe('general'); // deliberate default — not most-permissive by accident
    expect(row.sensitivity_level).toBe(1);
    expect(row.provenance.trustLevel).toBe('high');
    expect(row.provenance.sourceRefs).toEqual(['upload://sop/status-cadence.pdf']);
  });
});
