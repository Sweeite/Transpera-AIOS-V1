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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠⚠⚠ PROVISIONAL EMBEDDING PIN — NOT VALIDATED. DO NOT TREAT AS THE FINAL ONE-WAY-DOOR DECISION. ⚠⚠⚠
//
// This is a *development default* so M0+ can build against a concrete vector space. It was chosen from a
// SYNTHETIC dry-run bake-off (Issue #1) that validated the harness, NOT the model — synthetic data saturates
// ranking and cannot pick a winner. The real pin is DEFERRED to first-client onboarding (#43), when real
// de-identified content exists to decide on. See docs/adr/0001-embedding-model-pin.md.
//
// Why these values:
//   model   text-embedding-3-large — OpenAI is the stability anchor (Issue #1 Watch note); least churn risk.
//   dim     1024 — supported by BOTH finalists (OpenAI reducible, Voyage native), so a later switch to the
//           real winner at the same N is cheap. Handed to #2 as vector(1024) + the HNSW DDL.
//   dtype   float — start un-quantized; an int8/binary decision (and its re-calibrated floor) is part of the
//           real first-client bake-off (#3), not assumed now.
//   version "0-provisional" — the leading 0 + suffix make it unmistakable in any vector's stamp that this
//           space is provisional. The first-client decision bumps this to a real version (a re-embed event).
//
// ❗ Changing the model OR the dim later = re-embed every existing client's corpus + re-derive the floor.
//    While "0-provisional" and no client data exists, that cost is ~zero — which is exactly why we defer.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const EMBEDDING_MODEL = 'text-embedding-3-large'; // PROVISIONAL (#1) — real pin deferred to #43
export const EMBEDDING_DIM = 1024; // → vector(1024) + HNSW in #2; one-way door once a corpus is embedded
export const EMBEDDING_DTYPE = 'float' as const; // un-quantized v0; int8/binary trade decided in #3
export const EMBEDDING_VERSION = '0-provisional'; // leading-0 = NOT the validated pin; bumped at first-client
