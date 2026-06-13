/**
 * Decay cron (weekly) — type-aware utility decay (Brief §4.6, PRD §6.8).
 * Procedural EXEMPT. Episodic decays aggressively — but only once a confirmed semantic child back-references it;
 * episodic with no consolidated child decays slowly / flags for review (no silent data loss). Semantic slow.
 * A *wrong* fact is INVALIDATED (§4.4), not decayed (feedback split).
 */

/**
 * utility_score = recency×0.4 + frequency×0.3 + feedback×0.3 (§4.6). Invalidate below decay_min_utility_score.
 */
export async function runDecay(): Promise<{ decayed: number; flaggedForReview: number }> {
  // TODO: compute utility on eligible (episodic + gently semantic) only; require semantic child before reaping episodic;
  // emit consolidation-coverage metric (aging episodic w/o semantic child) to the Quality Monitor (§11.8).
  throw new Error('TODO: runDecay');
}

/** Prune index-in-place chunks past chunk_ttl_days (§6.8). */
export async function pruneExpiredChunks(): Promise<number> {
  // TODO
  throw new Error('TODO: pruneExpiredChunks');
}
