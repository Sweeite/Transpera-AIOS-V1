/**
 * Issue #13 — retrieve() emits an observability signal (searchMode + per-leg candidate counts), not JUST the
 * return value. retrieve() does not own taskId/trigger (so it cannot write a permission-tagged `kind='retrieval'`
 * trace row itself — emitSpan requires them; that wiring is the caller's obligation, like gatewayOnSpan). It
 * therefore surfaces a structured diagnostics record through an injectable sink, fired on BOTH the hit and
 * abstain paths so the non-selective/HNSW route is never invisible.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, vec } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve, type RetrievalDiagnostics } from '../../packages/core/src/harness/retrieval.ts';
import { grantAll } from './helpers/grant.ts';

const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
const embed: Embedder = async (texts) => texts.map(() => E0);

async function insertMem(query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>, statement: string) {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ('org','general',1,'semantic',$1,$2,'{}'::jsonb,$3,$4,$5::vector)`,
    [statement, `sha256:${statement}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(E0)],
  );
}

describe('#13 retrieve() diagnostics sink', () => {
  it('fires onRetrieval with per-store mode + candidate counts (hit path)', async () => {
    const { query } = await freshDb();
    await insertMem(query, 'revenue forecast memory'); // matches the keyword leg too
    const seen: RetrievalDiagnostics[] = [];

    const out = await retrieve('revenue forecast', {
      query,
      embed,
      exactMaxRows: 100,
      onRetrieval: (d) => seen.push(d),
      ...grantAll(),
    });

    expect(seen).toHaveLength(1);
    const d = seen[0]!;
    expect(d.abstained).toBe(false);
    expect(d.score).toBe(out.score);
    expect(d.memories.mode).toBe('exact');
    expect(d.memories.denseCount).toBe(1);
    expect(d.memories.keywordCount).toBe(1); // the keyword leg matched 'revenue forecast'
    expect(d.chunks.mode).toBe('exact');
    expect(typeof d.durationMs).toBe('number');
  });

  it('fires onRetrieval even on abstention (the HNSW/empty route is never invisible)', async () => {
    const { query } = await freshDb();
    const seen: RetrievalDiagnostics[] = [];

    const out = await retrieve('nothing here', { query, embed, onRetrieval: (d) => seen.push(d), ...grantAll() });

    expect(out.abstained).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.abstained).toBe(true);
    expect(seen[0]!.memories.candidateCount).toBe(0);
  });
});
