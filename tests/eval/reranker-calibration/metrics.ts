/**
 * Reranker-floor calibration metrics (Issue #14) — the direct analog of the #1 embedding bake-off's
 * `deriveFloor`, on the RERANKER score scale instead of cosine.
 *
 * The floor produced here is the #14 abstention floor (`retrieval_min_relevance`): a gate on the MAX rerank
 * score over the fused top-N. It lives on the chosen reranker's normalised [0,1] scale and is re-derived if the
 * reranker changes (ADR 0003 tripwire). It is an INDICATIVE value: deriving the floor and reporting recall on
 * the same labelled set is calibration-set == test-set — the real number needs a held-out set on real client
 * content (#43), which is why #14 ships the PROCEDURE + a provisional, not a final number.
 */

export interface FloorDerivation {
  floor: number; // recommended floor (clamped to the config bounds [0, 1])
  rawFloor: number; // before clamping — surfaced so a value at a bound is visible, not hidden
  tpRecallAtFloor: number; // fraction of answerable queries whose gold doc clears the floor
  abstainCorrectAtFloor: number; // fraction of no-answer queries correctly rejected (top hit < floor)
  positives: Stats; // gold rerank-score distribution
  negatives: Stats; // no-answer top-1 rerank-score distribution
  separation: number; // median(positives) − median(negatives): the headline gap
  warning?: string;
}
interface Stats {
  min: number;
  median: number;
  max: number;
  n: number;
}

const FLOOR_MIN = 0; // config bounds for retrieval_min_relevance on the rerank scale (system-config.ts, #14)
const FLOOR_MAX = 1;

function stats(xs: number[]): Stats {
  if (xs.length === 0) return { min: 0, median: 0, max: 0, n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { min: s[0]!, median, max: s[s.length - 1]!, n: s.length };
}

/**
 * Separation-score floor derivation (the NAMED #14 procedure, ADR 0003).
 *   positives = per answerable query, the gold document's rerank score (max over its gold docs).
 *   negatives = per no-answer query, the TOP-1 rerank score over the candidate set (what would be admitted).
 * Among thresholds that keep TP recall ≥ minRecall (default 0.90, the Acceptance bar), pick the one that
 * rejects the most no-answer cases; tie-break toward a higher floor. Then back off to the midpoint between the
 * floor and the nearest-below positive so a true hit at exactly the floor still clears it.
 */
export function deriveRerankFloor(positives: number[], negatives: number[], minRecall = 0.9): FloorDerivation {
  const pos = stats(positives);
  const neg = stats(negatives);

  const candidates = [...new Set([...positives, ...negatives])].sort((a, b) => a - b);
  let best = {
    floor: pos.min,
    recall: 1,
    abstain: negatives.length ? negatives.filter((n) => n < pos.min).length / negatives.length : 1,
  };
  for (const t of candidates) {
    const recall = positives.length ? positives.filter((p) => p >= t).length / positives.length : 0;
    if (recall < minRecall) continue;
    const abstain = negatives.length ? negatives.filter((n) => n < t).length / negatives.length : 1;
    if (abstain > best.abstain || (abstain === best.abstain && t > best.floor)) best = { floor: t, recall, abstain };
  }

  const belowPositives = positives.filter((p) => p < best.floor);
  const lowerNeighbour = belowPositives.length ? Math.max(...belowPositives) : best.floor - 0.02;
  const rawFloor = (best.floor + lowerNeighbour) / 2;
  const floor = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Number(rawFloor.toFixed(3))));

  let warning: string | undefined;
  if (rawFloor < FLOOR_MIN || rawFloor > FLOOR_MAX)
    warning = `raw floor ${rawFloor.toFixed(3)} fell outside config bounds [${FLOOR_MIN}, ${FLOOR_MAX}] and was clamped — investigate, don't ship blind.`;
  if (neg.n === 0)
    warning = (warning ? warning + ' ' : '') + 'No no-answer queries in the set — the floor is unguarded against false-admits. Add no-answer pairs.';
  if (pos.min <= neg.max)
    warning = (warning ? warning + ' ' : '') + 'Positive/negative rerank-score distributions OVERLAP — no clean separation; the floor cannot both admit all gold and reject all no-answer.';

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
