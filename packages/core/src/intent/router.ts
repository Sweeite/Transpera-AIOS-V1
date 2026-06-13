/**
 * Intent router — the front of every chat turn (Brief §7.1, PRD §4.1).
 * Classifies each message: query (→ retrieval → provenance answer/abstain) or command (→ agent/workflow runner).
 */
export type Intent = { kind: 'query' } | { kind: 'command'; confidence: number };

/** Cheap/fast classification. Low confidence on a destructive command → confirm before acting (§9.2). */
export async function routeIntent(_message: string): Promise<Intent> {
  // TODO: cheap model or heuristic+small model; the user never decides "asking vs commanding".
  throw new Error('TODO: routeIntent');
}
