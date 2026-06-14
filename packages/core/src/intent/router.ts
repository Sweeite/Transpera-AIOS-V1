/**
 * Intent router — the front of every chat turn (Brief §7.1, PRD §4.1).
 * Classifies each message: query (→ retrieval → provenance answer/abstain) or command (→ agent/workflow runner).
 */
/** Confidence is symmetric on BOTH arms (#22) — a weak "query" guess might be a destructive command. */
export type Intent =
  | { kind: 'query'; confidence: number }
  | { kind: 'command'; confidence: number };

/**
 * Cheap/fast classification. Below `intent_min_confidence` → CLARIFY-BACK ("did you want me to answer or
 * do that?") rather than guessing — the router only coarse-routes. The real destructive-action stop is #26's
 * blast-radius confirmation gate (blast-radius is a tool property, unknown at intent time). Eval-gated by an
 * intent-fixture suite, like every other classifier (§6.10).
 */
export async function routeIntent(_message: string, _recentThread?: string[]): Promise<Intent> {
  // recentThread (from threads/messages) is needed to disambiguate "do it" → do WHAT (#48).
  // TODO: cheap model or heuristic+small model; never decide for the user when below the confidence floor.
  throw new Error('TODO: routeIntent');
}
