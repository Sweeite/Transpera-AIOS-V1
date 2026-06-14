/**
 * Issue #5 — runnable demo of THE DEMO: the complete M0 tracer bullet. Boots in-process Postgres+pgvector
 * (pglite), applies the real migrations, ingests an SOP, then asks two questions through the SAME
 * answerQuestion()/labelAnswer() the tests use:
 *   1) a question the SOP answers   → an honest "I know this" + source + as-of, per claim;
 *   2) a question nothing answers    → the honest abstention copy (NOT an invented answer).
 *
 *   pnpm ask:sop                                              # offline: synthetic embedder + fake model, no keys
 *   node --env-file=.env node_modules/.bin/tsx scripts/answer.ts   # real OpenAI embeddings + Claude synthesis
 *
 * Offline mode injects a deterministic embedder + a fake model so the labelling + structural guard run with
 * ZERO network — the same code path the real keys exercise, just with stubbed providers.
 */
import { createHash } from 'node:crypto';
import { freshDb } from '../tests/core/helpers/pglite.ts';
import { EMBEDDING_DIM } from '../packages/core/src/harness/gateway.ts';
import type { CallOptions, CallResult, Embedder } from '../packages/core/src/harness/gateway.ts';
import { ingestSop } from '../packages/core/src/memory/store.ts';
import { answerQuestion, type ModelCaller } from '../packages/core/src/harness/synthesis.ts';
import { renderAnswer } from '../packages/core/src/harness/provenance.ts';

/** Deterministic synthetic embedder (offline only) — NOT a real embedding, just enough geometry. */
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

/** Offline fake model: cites the FIRST listed source (a real retrieved id) for a grounded claim, and adds one
 *  UNCITED claim so the demo shows both labels. The structural guard still runs over whatever this returns. */
const fakeModel: ModelCaller = (async (opts: CallOptions<unknown>) => {
  const prompt = opts.messages.map((m) => m.content).join('\n');
  const id = prompt.match(/\[([^\]]+)\]/)?.[1];
  const claims = [
    ...(id ? [{ text: 'Create the workspace, invite the client team, and book the kickoff.', sourceId: id }] : []),
    { text: 'Most agencies aim to kick off within the first week.' }, // uncited → general inference
  ];
  const output = opts.schema ? opts.schema.parse({ claims }) : ('' as unknown);
  return { output, usage: { model: 'fake-offline', durationMs: 0 } } as CallResult<unknown>;
}) as ModelCaller;

async function main(): Promise<void> {
  const { query } = await freshDb();
  const useReal = !!process.env.OPENAI_API_KEY && !!process.env.ANTHROPIC_API_KEY;
  const deps = useReal ? { query } : { query, embed: synthEmbedder, callModel: fakeModel };
  console.log(
    `mode: ${useReal ? 'REAL (OpenAI embeddings + Claude synthesis)' : 'OFFLINE (synthetic embedder + fake model, no keys)'}\n`,
  );

  const sopText =
    'To onboard a new client: 1) create the workspace, 2) invite the client team, 3) book the kickoff within 5 business days, 4) send the welcome pack.';
  await ingestSop(
    query,
    {
      namespace: 'org',
      statement: sopText,
      sourceRef: 'upload://sop/new-client-onboarding.pdf#v3',
      author: 'ops@agency.example',
      capturedAt: '2026-02-01T00:00:00.000Z',
    },
    useReal ? {} : { embed: synthEmbedder },
  );

  // Real embeddings handle a paraphrase; the OFFLINE synthetic embedder is exact-text geometry (no semantics),
  // so offline we ask the stored text verbatim to exercise the HIT path. Both modes show the SAME label logic.
  const known = useReal ? 'What are the steps to onboard a new client?' : sopText;
  console.log(`Q: ${known}`);
  const a1 = await answerQuestion(known, deps);
  console.log(renderAnswer(a1.answer, a1.retrieval) + '\n');

  const unknown = 'What is our company refund policy?';
  console.log(`Q: ${unknown}`);
  const a2 = await answerQuestion(unknown, deps);
  console.log(renderAnswer(a2.answer, a2.retrieval) + '\n');
}

main().catch((err) => {
  console.error('[answer] failed:', err);
  process.exit(1);
});
