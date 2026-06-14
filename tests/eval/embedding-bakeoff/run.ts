/**
 * Embedding bake-off runner (Issue #1) — STOP-and-show tooling.
 *
 *   load corpus → embed passages (as documents) + queries (as queries) per candidate
 *   → rank → ranking metrics (recall@k / MRR / nDCG) → derive the v1 dense-cosine STARTING floor
 *   → print a results table + per-candidate proposed floor, and write results.md.
 *
 * It pins NOTHING. We review the table together and pick the winner before touching gateway.ts / system-config.ts.
 *
 * Run:  npx tsx tests/eval/embedding-bakeoff/run.ts
 * Needs: corpus/passages.jsonl + corpus/pairs.json (see SCHEMA.md), and VOYAGE_API_KEY / OPENAI_API_KEY
 *        — auto-loaded from the repo-root .env (no flag needed; see loadRootEnv below).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CANDIDATES, type Candidate } from './candidates.ts';
import { embedAll } from './embed.ts';
import { rankPassages, rankingMetrics, deriveFloor, type FloorDerivation, type RankingMetrics } from './metrics.ts';

interface Passage { id: string; type: string; namespace: string; zone: string; text: string }
interface Pair { name: string; query: string; gold: string[] }

const DIR = import.meta.dirname;
const ROOT_ENV = join(DIR, '..', '..', '..', '.env'); // repo root

/**
 * Auto-load the repo-root .env so a plain `npx tsx run.ts` picks up the BYO keys — no --env-file flag.
 * Uses Node's built-in loader (≥20.12, no dependency, chokepoint-safe: not a provider SDK); falls back to a
 * tiny parser on older Node. Never overrides a var already set in the real environment.
 */
function loadRootEnv(): void {
  if (!existsSync(ROOT_ENV)) {
    console.warn(`⚠ No repo-root .env at ${ROOT_ENV} — relying on the ambient environment for API keys.`);
    return;
  }
  const builtin = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof builtin === 'function') { builtin(ROOT_ENV); return; }
  for (const line of readFileSync(ROOT_ENV, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    const val = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function loadCorpus(): { passages: Passage[]; pairs: Pair[] } {
  const pPath = join(DIR, 'corpus', 'passages.jsonl');
  const qPath = join(DIR, 'corpus', 'pairs.json');
  if (!existsSync(pPath) || !existsSync(qPath)) {
    throw new Error(
      `Corpus not found. Expected:\n  ${pPath}\n  ${qPath}\n` +
        `Create them from the real de-identified content per corpus/SCHEMA.md (the *.example.* files show the shape).`,
    );
  }
  const passages = readFileSync(pPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Passage);
  const pairs = (JSON.parse(readFileSync(qPath, 'utf8')) as { pairs: Pair[] }).pairs;

  // Validate gold ids resolve — a typo'd gold id would silently understate recall (a silent failure, principle #1).
  const ids = new Set(passages.map((p) => p.id));
  for (const pr of pairs) for (const g of pr.gold) if (!ids.has(g)) throw new Error(`pair "${pr.name}" references unknown gold id "${g}"`);

  // Sanity-check passage length so we're not optimizing on the wrong granularity (addition #4).
  const wordCounts = passages.map((p) => p.text.split(/\s+/).length);
  const avg = wordCounts.reduce((a, b) => a + b, 0) / Math.max(wordCounts.length, 1);
  if (avg < 15 || avg > 400) console.warn(`⚠ avg passage length ${avg.toFixed(0)} words — confirm this matches production chunk size (addition #4).`);

  return { passages, pairs };
}

interface CandidateResult { c: Candidate; rank: RankingMetrics; floor: FloorDerivation; error?: string }

async function scoreCandidate(c: Candidate, passages: Passage[], pairs: Pair[]): Promise<CandidateResult> {
  const passageVecs = await embedAll(c, 'document', passages.map((p) => p.text));
  // Symmetric models reuse the document embedder for queries; asymmetric ones use the query input type.
  const queryVecs = await embedAll(c, c.asymmetric ? 'query' : 'document', pairs.map((p) => p.query));

  const idToIdx = new Map(passages.map((p, i) => [p.id, i]));
  const answerable = pairs.map((p, i) => ({ p, i })).filter(({ p }) => p.gold.length > 0);
  const noAnswer = pairs.map((p, i) => ({ p, i })).filter(({ p }) => p.gold.length === 0);

  const rankedAnswerable = answerable.map(({ i }) => rankPassages(queryVecs[i], passageVecs));
  const goldSets = answerable.map(({ p }) => new Set(p.gold.map((g) => idToIdx.get(g)!)));
  const rank = rankingMetrics(rankedAnswerable, goldSets);

  // positives = gold passage cosine (max over gold); negatives = top-1 cosine for a no-answer query.
  const positives = answerable.map(({ p, i }) => Math.max(...p.gold.map((g) => rankPassages(queryVecs[i], [passageVecs[idToIdx.get(g)!]])[0].score)));
  const negatives = noAnswer.map(({ i }) => rankPassages(queryVecs[i], passageVecs)[0]?.score ?? 0);
  const floor = deriveFloor(positives, negatives);

  return { c, rank, floor };
}

function fmt(n: number): string { return n.toFixed(3); }

function renderTable(results: CandidateResult[]): string {
  const lines: string[] = [];
  lines.push('# Embedding bake-off results (Issue #1)\n');
  lines.push('> ⚠ The floor below is the **v1 dense-cosine** floor (Brief §4.7 pragmatic path) — an **indicative STARTING value**, not validated (calibration set == test set on ~30 pairs, addition #2). It is re-derived when the reranker lands (#14, a different scale). Floors for `int8` candidates are calibrated on the int8 vectors we would ship (addition #3).\n');
  lines.push('| candidate | dim | dtype | R@1 | R@5 | MRR | nDCG@10 | start floor | TP recall@floor | abstain✓@floor | separation |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.error) { lines.push(`| ${r.c.id} | ${r.c.dim} | ${r.c.dtype} | — error: ${r.error} | | | | | | | |`); continue; }
    lines.push(
      `| ${r.c.id} | ${r.c.dim} | ${r.c.dtype} | ${fmt(r.rank.recallAtK[1])} | ${fmt(r.rank.recallAtK[5])} | ${fmt(r.rank.mrr)} | ${fmt(r.rank.ndcgAtK)} | **${fmt(r.floor.floor)}** | ${fmt(r.floor.tpRecallAtFloor)} | ${fmt(r.floor.abstainCorrectAtFloor)} | ${fmt(r.floor.separation)} |`,
    );
  }
  lines.push('\n## Floor detail (positives vs no-answer cosine distributions)\n');
  for (const r of results) {
    if (r.error) continue;
    const f = r.floor;
    lines.push(`- **${r.c.id}** — gold cosine min/med/max = ${fmt(f.positives.min)}/${fmt(f.positives.median)}/${fmt(f.positives.max)} (n=${f.positives.n}); no-answer top-1 min/med/max = ${fmt(f.negatives.min)}/${fmt(f.negatives.median)}/${fmt(f.negatives.max)} (n=${f.negatives.n}); rawFloor=${fmt(f.rawFloor)}${f.warning ? ` — ⚠ ${f.warning}` : ''}`);
  }
  lines.push('\n_Next: pick the winner (quality first; near-tie → stable/well-priced per the issue Watch note), record dim+dtype+floor as conscious calls in ADR 0001, then pin gateway.ts + system-config.ts._');
  return lines.join('\n');
}

async function main(): Promise<void> {
  loadRootEnv(); // pull VOYAGE_API_KEY / OPENAI_API_KEY from repo-root .env before any vendor call
  const { passages, pairs } = loadCorpus();
  console.log(`Loaded ${passages.length} passages, ${pairs.length} pairs (${pairs.filter((p) => p.gold.length === 0).length} no-answer).`);

  const results: CandidateResult[] = [];
  for (const c of CANDIDATES) {
    try {
      console.log(`\n▶ ${c.id} …`);
      results.push(await scoreCandidate(c, passages, pairs));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ${c.id}: ${msg}`);
      results.push({ c, rank: { recallAtK: {}, mrr: 0, ndcgAtK: 0, n: 0 }, floor: {} as FloorDerivation, error: msg });
    }
  }

  const md = renderTable(results);
  writeFileSync(join(DIR, 'results.md'), md);
  console.log('\n' + md + `\n\nWrote ${join(DIR, 'results.md')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
