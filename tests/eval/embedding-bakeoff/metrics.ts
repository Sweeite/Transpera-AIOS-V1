/**
 * Bake-off metrics (Issue #1).
 *
 * Two distinct jobs, deliberately separated:
 *   1. RANK the candidates against each other       → recall@k (primary, tied to Acceptance), MRR, nDCG.
 *   2. DERIVE A STARTING dense-cosine floor          → the separation score (positives vs abstention cases).
 *
 * The floor produced here is the v1 DENSE-COSINE floor (Brief §4.7 pragmatic path): a pre-fusion cosine gate
 * on the dense leg. It lives on the CHOSEN MODEL'S cosine scale and is recalibrated when the reranker lands
 * (#14) — a different scale, a re-derivation, not a reuse. It is an INDICATIVE STARTING value, not validated:
 * deriving the floor and reporting recall on the same ~30 pairs is calibration-set == test-set (addition #2).
 */
import type { Vector } from './embed.ts';

export function cosine(a: Vector, b: Vector): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Cosine of the query against every passage, sorted desc. Returns [{idx, score}]. */
export function rankPassages(query: Vector, passages: Vector[]): { idx: number; score: number }[] {
  return passages
    .map((p, idx) => ({ idx, score: cosine(query, p) }))
    .sort((a, b) => b.score - a.score);
}

export interface RankingMetrics {
  recallAtK: Record<number, number>; // k → fraction of answerable pairs whose gold doc is in top-k
  mrr: number;
  ndcgAtK: number; // @10
  n: number; // answerable pairs scored
}

const KS = [1, 3, 5, 10];

/** ranked = per answerable pair, the sorted passage list; goldSets = the gold passage indices for that pair. */
export function rankingMetrics(ranked: { idx: number }[][], goldSets: Set<number>[]): RankingMetrics {
  const recallAtK: Record<number, number> = {};
  for (const k of KS) {
    let hit = 0;
    ranked.forEach((r, i) => {
      if (r.slice(0, k).some((x) => goldSets[i].has(x.idx))) hit++;
    });
    recallAtK[k] = ranked.length ? hit / ranked.length : 0;
  }

  let mrrSum = 0, ndcgSum = 0;
  ranked.forEach((r, i) => {
    const rank = r.findIndex((x) => goldSets[i].has(x.idx)); // 0-based; -1 if absent
    if (rank >= 0) mrrSum += 1 / (rank + 1);
    // nDCG@10 with binary relevance (ideal DCG for ≥1 gold = 1/log2(2) = 1)
    if (rank >= 0 && rank < 10) ndcgSum += 1 / Math.log2(rank + 2);
  });

  return {
    recallAtK,
    mrr: ranked.length ? mrrSum / ranked.length : 0,
    ndcgAtK: ranked.length ? ndcgSum / ranked.length : 0,
    n: ranked.length,
  };
}

export interface FloorDerivation {
  floor: number; // recommended STARTING dense-cosine floor (clamped to config bounds 0.5–0.95)
  rawFloor: number; // before clamping — surfaced so a value at a bound is visible, not hidden
  tpRecallAtFloor: number; // fraction of answerable pairs whose gold doc clears the floor
  abstainCorrectAtFloor: number; // fraction of no-answer pairs correctly rejected (top hit < floor)
  positives: { min: number; median: number; max: number; n: number }; // gold-pair cosine distribution
  negatives: { min: number; median: number; max: number; n: number }; // no-answer top-1 cosine distribution
  separation: number; // median(positives) − median(negatives): the headline gap
  warning?: string;
}

const FLOOR_MIN = 0.5; // config bounds for retrieval_min_relevance (system-config.ts)
const FLOOR_MAX = 0.95;

function stats(xs: number[]): { min: number; median: number; max: number; n: number } {
  if (xs.length === 0) return { min: 0, median: 0, max: 0, n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { min: s[0], median, max: s[s.length - 1], n: s.length };
}

/**
 * Separation-score floor derivation.
 *   positives = per answerable pair, the gold passage's cosine (max over its gold passages).
 *   negatives = per no-answer pair, the TOP-1 cosine over the whole corpus (what would be wrongly admitted).
 * Among thresholds that keep TP recall ≥ minRecall (default 0.90, the Acceptance bar), pick the one that
 * rejects the most no-answer cases; tie-break toward a higher floor. Then back off to the midpoint between
 * the floor and the nearest-below positive so a true hit at exactly the floor still clears it.
 */
export function deriveFloor(positives: number[], negatives: number[], minRecall = 0.9): FloorDerivation {
  const pos = stats(positives);
  const neg = stats(negatives);

  const candidates = [...new Set([...positives, ...negatives])].sort((a, b) => a - b);
  let best = { floor: pos.min, recall: 1, abstain: negatives.length ? negatives.filter((n) => n < pos.min).length / negatives.length : 1 };
  for (const t of candidates) {
    const recall = positives.length ? positives.filter((p) => p >= t).length / positives.length : 0;
    if (recall < minRecall) continue;
    const abstain = negatives.length ? negatives.filter((n) => n < t).length / negatives.length : 1;
    if (abstain > best.abstain || (abstain === best.abstain && t > best.floor)) best = { floor: t, recall, abstain };
  }

  // Back off to just below the chosen positive so the gold hit at the threshold isn't excluded by rounding.
  const belowPositives = positives.filter((p) => p < best.floor);
  const lowerNeighbour = belowPositives.length ? Math.max(...belowPositives) : best.floor - 0.02;
  const rawFloor = (best.floor + lowerNeighbour) / 2;
  const floor = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Number(rawFloor.toFixed(3))));

  let warning: string | undefined;
  if (rawFloor < FLOOR_MIN || rawFloor > FLOOR_MAX) warning = `raw floor ${rawFloor.toFixed(3)} fell outside config bounds [${FLOOR_MIN}, ${FLOOR_MAX}] and was clamped — investigate, don't ship blind.`;
  if (neg.n === 0) warning = (warning ? warning + ' ' : '') + 'No abstention pairs in the eval set — floor is unguarded against false-admits. Add no-answer pairs.';
  if (pos.min <= neg.max) warning = (warning ? warning + ' ' : '') + 'Positive/negative cosine distributions OVERLAP — no clean separation; this model+representation may be a poor fit.';

  return {
    floor,
    rawFloor: Number(rawFloor.toFixed(3)),
    tpRecallAtFloor: positives.length ? positives.filter((p) => p >= floor).length / positives.length : 0,
    abstainCorrectAtFloor: negatives.length ? negatives.filter((n) => n < floor).length / negatives.length : 1,
    positives: pos,
    negatives: neg,
    separation: Number((pos.median - neg.median).toFixed(4)),
    warning,
  };
}
