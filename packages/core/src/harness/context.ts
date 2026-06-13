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

/** NEVER includes a memory the asker can't see (clearance already applied at retrieval, §6.2). */
export async function assembleContext(_args: {
  clearance: Clearance;
  persona: string;
  retrieved: Array<Memory | Chunk>;
  recentThread: string[];
  tokenBudget: number;
}): Promise<AssembledContext> {
  // TODO: rank by relevance, truncate to budget, attach provenance metadata, log drops.
  throw new Error('TODO: assembleContext');
}
