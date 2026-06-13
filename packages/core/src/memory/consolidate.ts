/**
 * Consolidation cron (nightly) — episodic → semantic (Brief §4.5, PRD §6.8).
 * Watermark + same-namespace dedup; auto-merge ≥0.97, review 0.92–0.97.
 */

/**
 * For each new episodic (after watermark), distil a semantic candidate, then on a high-similarity match
 * in the SAME namespace run a duplicate/entails/contradicts/unrelated classifier:
 *   duplicate → drop · entails → merge · CONTRADICTS → supersede (invalidate-old + write-new, §4.4) · unrelated → keep
 * Slot-able (entity, attribute, value) facts supersede DETERMINISTICALLY (same slot, new value) — no classifier.
 * Sensitivity inherits max/union but NEVER auto-broadens (review-queue flag instead, §4.5).
 * Watermark advances only on success. Cold-start: throttle auto-merge toward review (§10.3).
 */
export async function runConsolidation(): Promise<{ merged: number; superseded: number; toReview: number }> {
  // TODO
  throw new Error('TODO: runConsolidation');
}
