/**
 * Context assembly — builds the prompt for a turn (PRD §6.2).
 * Token budgeting: ranks + truncates to fit the window; what-was-dropped is logged, never silent.
 */
import type { Clearance, Memory, Chunk } from '@aios/shared';

export interface AssembledContext {
  system: string; // stable prefix (persona + tool defs) → prompt-cached (§5.3)
  retrieved: Array<Memory | Chunk>; // already permission + namespace filtered
  droppedForBudget: number;
  tokenEstimate: number;
}

/**
 * NEVER includes a memory the asker can't see (clearance already applied at retrieval, §6.2).
 * `recentThread` is sourced from the `threads`/`messages` store (#48) — NOT working memory, which never
 * persists. It is what lets the intent router + agents resolve "do it" → do WHAT across turns.
 */
export async function assembleContext(_args: {
  clearance: Clearance;
  persona: string;
  retrieved: Array<Memory | Chunk>;
  recentThread: string[]; // from threads/messages (#48)
  tokenBudget: number;
}): Promise<AssembledContext> {
  // TODO: rank by relevance, truncate to budget, attach provenance metadata, log drops.
  throw new Error('TODO: assembleContext');
}
