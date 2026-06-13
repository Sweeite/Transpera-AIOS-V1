/**
 * Provenance & abstention layer (PRD §6.5, Brief §6).
 * Per-claim grounding by citation (NOT per-span): model cites source per claim; a verification pass
 * confirms each citation; uncited text → "general inference" by exclusion. Abstain over confabulate.
 */
import type { Answer, Claim, RetrievalResult } from '@aios/shared';

/** Turn a generated draft + its retrieval into a provenance-labelled Answer. */
export async function labelAnswer(_args: {
  draftClaims: Claim[];
  retrieval: RetrievalResult;
  verify: boolean; // conditional: only low-confidence / high-stakes answers (§5.3 cost lever)
}): Promise<Answer> {
  // TODO: confirm each cited claim is supported by its source; mark uncited as general-inference;
  // a failed live fetch shows last-known + timestamp, never a guess.
  throw new Error('TODO: labelAnswer');
}

/** Below the relevance floor → abstain and log a miss (the learning signal, §6). */
export function shouldAbstain(score: number, floor: number): boolean {
  return score < floor;
}
