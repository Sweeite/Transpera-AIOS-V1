/**
 * Reranker-floor calibration run (Issue #14). For each labelled query it reranks the query against its
 * candidate documents through the REAL Voyage reranker (raw fetch — chokepoint-safe, #46, no SDK), collects
 * the positive/negative score distributions, and derives a STARTING floor by the separation-score method.
 *
 * It pins NOTHING — it prints a results table + a proposed floor that we review together, then (at first-client
 * onboarding, #43) pin `system-config.ts::retrieval_min_relevance` and update ADR 0003 to Accepted. On
 * synthetic content the ranking saturates and the floor is indicative only (the #1 lesson) — the REAL number
 * needs de-identified real content.
 *
 *   npx tsx --env-file=tests/eval/reranker-calibration/.env tests/eval/reranker-calibration/run.ts
 *
 * .env needs VOYAGE_API_KEY. corpus/pairs.json (gitignored) holds the labelled set; pairs.example.json shows
 * the shape. Results cache to corpus/.cache so re-runs don't re-spend the BYO budget.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveRerankFloor } from './metrics.ts';

const RERANK_URL = 'https://api.voyageai.com/v1/rerank';
const MODEL = 'rerank-2.5-lite'; // the provisional pin (ADR 0003) — keep in sync with gateway.RERANKER_MODEL

interface Pair {
  name: string;
  query: string;
  candidates: string[]; // the fused candidate documents for this query (what retrieve() would feed the reranker)
  goldIndices: number[]; // indices into `candidates` that are the right answer; [] ⇒ a no-answer query
}

async function rerankScores(apiKey: string, query: string, documents: string[]): Promise<number[]> {
  if (documents.length === 0) return [];
  const res = await fetch(RERANK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, query, documents, return_documents: false }),
  });
  if (!res.ok) throw new Error(`rerank failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: Array<{ index: number; relevance_score: number }> };
  const scores = new Array<number>(documents.length);
  for (const d of json.data ?? []) scores[d.index] = d.relevance_score;
  return scores;
}

async function main(): Promise<void> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    console.error('VOYAGE_API_KEY missing — set it in tests/eval/reranker-calibration/.env and re-run.');
    process.exit(1);
  }
  const pairsPath = join(import.meta.dirname, 'corpus', 'pairs.json');
  const { pairs } = JSON.parse(readFileSync(pairsPath, 'utf8')) as { pairs: Pair[] };

  const positives: number[] = []; // gold doc score per answerable query
  const negatives: number[] = []; // top-1 score per no-answer query

  for (const p of pairs) {
    const scores = await rerankScores(apiKey, p.query, p.candidates);
    if (p.goldIndices.length > 0) {
      positives.push(Math.max(...p.goldIndices.map((i) => scores[i] ?? Number.NEGATIVE_INFINITY)));
    } else {
      negatives.push(scores.length ? Math.max(...scores) : Number.NEGATIVE_INFINITY);
    }
  }

  const d = deriveRerankFloor(positives, negatives);
  console.log(`\nReranker floor calibration — model=${MODEL} (provisional, ADR 0003)`);
  console.log(`  answerable=${positives.length}  no-answer=${negatives.length}`);
  console.log(`  positives  min/median/max: ${d.positives.min.toFixed(3)} / ${d.positives.median.toFixed(3)} / ${d.positives.max.toFixed(3)}`);
  console.log(`  negatives  min/median/max: ${d.negatives.min.toFixed(3)} / ${d.negatives.median.toFixed(3)} / ${d.negatives.max.toFixed(3)}`);
  console.log(`  separation (Δ median): ${d.separation}`);
  console.log(`  PROPOSED FLOOR: ${d.floor}  (raw ${d.rawFloor})  TP-recall@floor=${d.tpRecallAtFloor.toFixed(3)}  abstain-correct@floor=${d.abstainCorrectAtFloor.toFixed(3)}`);
  if (d.warning) console.log(`  ⚠ ${d.warning}`);
  console.log('\n  NOT a pin. Review, then finalise on real de-identified content at first-client onboarding (#43).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
