/**
 * Issue #3 — runnable demo of the write half of the M0 slice. Boots an in-process Postgres+pgvector (pglite),
 * applies the real migrations, and ingests an SOP through the SAME ingestSop()/writeMemory() the tests use —
 * proving "upload → one procedural memory with embedding + content-hash + provenance refs" end to end, then
 * re-ingesting the identical text to show namespace-scoped dedup (one row, no re-embed).
 *
 *   pnpm tsx scripts/ingest-sop.ts                       # synthetic embedder, zero external deps
 *   node --env-file=.env node_modules/.bin/tsx scripts/ingest-sop.ts   # real OpenAI embeddings (uses .env key)
 *
 * The HTTP POST /ingest route lands when the API server is built (it's stubbed in packages/api/src/server.ts);
 * #3 ships the engine entrypoint + this script, per the issue's "(or script)".
 */
import { createHash } from 'node:crypto';
import { freshDb } from '../tests/core/helpers/pglite.ts';
import { ingestSop, type Embedder } from '../packages/core/src/memory/store.ts';
import { embed as gatewayEmbed, EMBEDDING_DIM } from '../packages/core/src/harness/gateway.ts';

/** Deterministic synthetic embedder so the demo runs with NO key. With a key, pass undefined to use the real
 *  gateway path. NOT a real embedding — just enough geometry to populate the column. */
const synthEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const out = new Array<number>(EMBEDDING_DIM);
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      const h = createHash('sha256').update(`${t}|${i}`).digest();
      const v = (h.readUInt32BE(0) / 0xffffffff) * 2 - 1;
      out[i] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    return out.map((x) => x / norm);
  });

async function main(): Promise<void> {
  const { query } = await freshDb();
  const useReal = !!process.env.OPENAI_API_KEY;
  const opts = useReal ? {} : { embed: synthEmbedder };
  console.log(`embedder: ${useReal ? 'REAL gateway.embed (OpenAI)' : 'synthetic (no OPENAI_API_KEY)'}\n`);

  const sop = {
    namespace: 'org' as const,
    statement: 'SOP — New client onboarding: 1) create the workspace, 2) invite the client team, 3) book kickoff within 5 business days, 4) send the welcome pack.',
    sourceRef: 'upload://sop/new-client-onboarding.pdf#v3',
    author: 'ops@agency.example',
  };

  const first = await ingestSop(query, sop, opts);
  console.log('ingested:');
  console.log(`  id           ${first.memory.id}`);
  console.log(`  type         ${first.memory.type}`);
  console.log(`  namespace    ${first.memory.namespace}`);
  console.log(`  zone/sens    ${first.memory.zone} / s${first.memory.sensitivityLevel}`);
  console.log(`  content_hash ${first.memory.contentHash}`);
  console.log(`  model@ver    ${first.memory.embeddingModel}@${first.memory.embeddingVersion}`);
  console.log(`  provenance   refs=${JSON.stringify(first.memory.provenance.sourceRefs)} trust=${first.memory.provenance.trustLevel}`);
  console.log(`  deduped      ${first.deduped}\n`);

  // Re-ingest identical content (whitespace/case-shifted) → deduped, no new row, no re-embed.
  const again = await ingestSop(query, { ...sop, statement: `  ${sop.statement.toUpperCase()}  ` }, opts);
  const count = (await query(`SELECT count(*)::int AS n FROM memories`)).rows[0].n;
  console.log(`re-ingest (whitespace/case-shifted): deduped=${again.deduped}, sameRow=${again.memory.id === first.memory.id}, total memories=${count}`);
}

main().catch((err) => {
  console.error('[ingest-sop] failed:', err);
  process.exit(1);
});
