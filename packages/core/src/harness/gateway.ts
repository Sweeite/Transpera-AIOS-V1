/**
 * LLM gateway — the single chokepoint through which EVERY model call passes (PRD §6.1).
 * Core, never plugins: model choice, fallback, embedding pinning, key isolation, cost tracking (§8.2).
 */
import type { TraceSpan } from '@aios/shared';

export type TaskClass = 'classify' | 'summarise' | 'extract' | 'reason' | 'synthesize';

export interface CallOptions {
  taskClass: TaskClass; // drives multi-provider routing (cheap vs strong), quality-gated by eval fixtures
  system?: string; // stable prefix → prompt-cached (~90% off cached input tokens, §5.3)
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** When set, the model is forced to structured output validated against this schema (repair-or-fail). */
  schema?: unknown; // zod schema
  stream?: boolean;
}

export interface CallResult<T = string> {
  output: T;
  span: TraceSpan;
}

/**
 * Route → call → (fallback on error/timeout, bounded retries) → parse/validate → emit cost+trace.
 * Never emits silent malformed output: structured calls repair-or-fail.
 */
export async function callModel<T = string>(_opts: CallOptions): Promise<CallResult<T>> {
  // TODO: model routing table by TaskClass; per-client BYO keys; fallback chain; prompt caching;
  // structured-output validation (zod) with repair-or-fail; per-call token+cost → cost monitor (§11.7).
  throw new Error('TODO: callModel');
}

/** Embeddings are pinned to ONE model+version and NEVER cost-routed (§4.7). */
export async function embed(_texts: string[]): Promise<number[][]> {
  // TODO: call the single pinned embedding model; stamp embeddingModel/embeddingVersion on every vector.
  throw new Error('TODO: embed');
}

export const EMBEDDING_MODEL = 'TODO-pin-after-real-data-eval'; // #1 one-way door (tech-stack §5.5)
export const EMBEDDING_VERSION = '1';
