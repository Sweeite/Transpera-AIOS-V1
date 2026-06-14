/**
 * Issue #5 — the STRUCTURAL CITATION GUARD + per-claim label mapping (the audit-fix core, Brief §6).
 *
 * labelAnswer() is PURE (no network): the model's draft claims ARE the injected fake response, so the guard
 * is tested with zero model call. The load-bearing properties (each a permanent regression test):
 *   • ★ MUST-HAVE: a claim citing an id that is NOT in the retrieved set is a FABRICATED citation → relabelled
 *     to general-inference, its sourceId/asOf STRIPPED, NEVER surfaced as "I know this", and signalled (not silent).
 *   • cited + in-set → 'memory' ("I know this") with sourceId + asOf (= the source's provenance.capturedAt).
 *   • uncited → 'general-inference' by exclusion.
 *   • only the two M0 labels ever appear (no 'live' / 'failed-fetch' — those are #23).
 *   • abstained retrieval → abstained Answer, NO business-fact claims, the honest M0 abstention copy (NOT a
 *     federation promise).
 */
import { describe, it, expect } from 'vitest';
import type { Provenance } from '@aios/shared';
import { labelAnswer, ABSTENTION_COPY, renderAnswer } from '../../packages/core/src/harness/provenance.ts';
import type { RetrievedMemory, RetrieveOutcome } from '../../packages/core/src/harness/retrieval.ts';

function prov(ref: string, capturedAt: string): Provenance {
  return { sourceRefs: [ref], capturedAt, trustLevel: 'high' };
}

/** A retrieved memory with just the fields the answer surface reads (id + provenance for source/as-of). */
function mem(id: string, statement: string, p: Provenance): RetrievedMemory {
  return {
    id,
    namespace: 'org',
    zone: 'general',
    sensitivityLevel: 1,
    type: 'procedural',
    statement,
    contentHash: `sha256:${id}`,
    provenance: p,
    embeddingModel: 'text-embedding-3-large',
    embeddingVersion: '0-provisional',
    createdAt: '2026-01-01T00:00:00.000Z',
    cosine: 0.9,
  };
}

function hit(memories: RetrievedMemory[]): RetrieveOutcome {
  return { abstained: false, score: 0.9, memories };
}

describe('labelAnswer() structural citation guard (#5 audit fix)', () => {
  it('★ relabels a claim citing a NON-retrieved id to general-inference — never "I know this" (the must-have)', () => {
    const retrieval = hit([mem('mem-real', 'Onboarding: create the workspace.', prov('upload://sop.pdf', '2026-02-01T00:00:00.000Z'))]);
    const signals: Array<{ claimText: string; citedId: string }> = [];

    const answer = labelAnswer({
      draftClaims: [{ text: 'Fabricated: invoices are paid in 7 days.', sourceId: 'mem-DOES-NOT-EXIST' }],
      retrieval,
      onFabricatedCitation: (i) => signals.push(i),
    });

    const claim = answer.claims[0]!;
    expect(claim.label).toBe('general-inference'); // NOT 'memory'
    expect(claim.label).not.toBe('memory');
    expect(claim.sourceId).toBeUndefined(); // the fake id is STRIPPED — cannot render a fake source
    expect(claim.asOf).toBeUndefined(); // no fake as-of date leaks
    expect(claim.text).toBe('Fabricated: invoices are paid in 7 days.'); // the text is kept, just demoted
    expect(signals).toEqual([{ claimText: claim.text, citedId: 'mem-DOES-NOT-EXIST' }]); // signalled, not silent
  });

  it('labels a claim citing a RETRIEVED id as memory ("I know this") with sourceId + asOf (capturedAt)', () => {
    const p = prov('upload://onboarding.pdf', '2026-02-01T00:00:00.000Z');
    const retrieval = hit([mem('mem-1', 'Create the workspace, invite the team.', p)]);

    const answer = labelAnswer({
      draftClaims: [{ text: 'To onboard, create the workspace and invite the team.', sourceId: 'mem-1' }],
      retrieval,
    });

    const claim = answer.claims[0]!;
    expect(claim.label).toBe('memory');
    expect(claim.sourceId).toBe('mem-1');
    expect(claim.asOf).toBe('2026-02-01T00:00:00.000Z'); // honest as-of = when the knowledge was captured
    expect(answer.abstained).toBe(false);
  });

  it('labels an UNCITED claim as general-inference by exclusion', () => {
    const retrieval = hit([mem('mem-1', 'x', prov('upload://x.pdf', '2026-02-01T00:00:00.000Z'))]);

    const answer = labelAnswer({
      draftClaims: [{ text: 'Generally, agencies kick off within a week.' }], // no sourceId
      retrieval,
    });

    const claim = answer.claims[0]!;
    expect(claim.label).toBe('general-inference');
    expect(claim.sourceId).toBeUndefined();
    expect(claim.asOf).toBeUndefined();
  });

  it('only the two M0 labels ever appear — never live / failed-fetch', () => {
    const retrieval = hit([mem('mem-1', 'a', prov('upload://a.pdf', '2026-02-01T00:00:00.000Z'))]);
    const answer = labelAnswer({
      draftClaims: [
        { text: 'cited-real', sourceId: 'mem-1' },
        { text: 'cited-fake', sourceId: 'nope' },
        { text: 'uncited' },
      ],
      retrieval,
    });
    const labels = new Set(answer.claims.map((c) => c.label));
    expect([...labels].sort()).toEqual(['general-inference', 'memory']);
    expect(labels.has('live')).toBe(false);
    expect(labels.has('failed-fetch')).toBe(false);
  });
});

describe('labelAnswer() abstention path (#5, honest M0 copy)', () => {
  it('an abstained retrieval yields an abstained answer with NO business-fact claims', () => {
    const retrieval: RetrieveOutcome = { abstained: true, score: 0.1, memories: [] };
    const answer = labelAnswer({ draftClaims: [], retrieval });
    expect(answer.abstained).toBe(true);
    expect(answer.claims).toEqual([]); // never an invented or empty-looking business fact
  });

  it('the M0 abstention copy is the honest version — it does NOT promise a federated SoR lookup (#23)', () => {
    expect(ABSTENTION_COPY).toMatch(/don't have durable knowledge/i);
    expect(ABSTENTION_COPY).toMatch(/capture an answer/i);
    // Must NOT imply it can already read the systems of record live (that is federation, deferred to #23).
    expect(ABSTENTION_COPY.toLowerCase()).not.toMatch(/system of record|systems of record|live|currently shows|here'?s what/);
  });

  it('renderAnswer prints the abstention copy when abstained (the surface shows it, never empty)', () => {
    const out = renderAnswer({ abstained: true, claims: [] });
    expect(out).toContain(ABSTENTION_COPY);
  });

  it('renderAnswer resolves a memory claim to its human source ref + as-of (the trust pitch)', () => {
    const p = prov('upload://onboarding.pdf', '2026-02-01T00:00:00.000Z');
    const retrieval = hit([mem('mem-1', 'Create the workspace.', p)]);
    const answer = labelAnswer({ draftClaims: [{ text: 'Create the workspace.', sourceId: 'mem-1' }], retrieval });

    const out = renderAnswer(answer, retrieval);
    expect(out).toMatch(/I know this/i);
    expect(out).toContain('upload://onboarding.pdf'); // the real source, not the uuid
    expect(out).toContain('2026-02-01'); // the as-of date
  });
});
