/**
 * LLM gateway — the single chokepoint through which EVERY model call passes (PRD §6.1).
 * Core, never plugins: model choice, fallback, embedding pinning, key isolation, cost tracking (§8.2).
 */
import type { TraceSpan } from '@aios/shared';

export type TaskClass = 'classify' | 'summarise' | 'extract' | 'reason' | 'synthesize';

/**
 * A function that turns texts into pinned-dimension vectors. `embed` (below) is the ONLY producer in
 * production; this type is exported so BOTH the write path (memory/store) and the read path (harness/
 * retrieval) can inject a deterministic stand-in in hermetic tests, without a network call. Defined here —
 * next to `embed` — so neither path imports an embedding type from the other (no layering inversion).
 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

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

/**
 * Embeddings are pinned to ONE model+version and NEVER cost-routed (§4.7). This is the FIRST real provider
 * call in the engine and the ONLY place embeddings are produced — every vector flows through here so the
 * pin (EMBEDDING_MODEL/DIM) is impossible to bypass (#46 chokepoint). The caller stamps EMBEDDING_VERSION.
 *
 * Direct REST (fetch) rather than the openai SDK: keeps the chokepoint test trivially green (no provider SDK
 * imported anywhere) and avoids a dependency for one endpoint. Batch-capable: N inputs → N vectors, in order.
 * Fails LOUD (never a partial/empty result silently) — a bad embed must surface, not poison the vector space.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []; // nothing to embed — no provider call
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — embeddings cannot run (fail loud, never a silent empty vector).');
  }

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // `dimensions` is REQUIRED: text-embedding-3-large defaults to 3072; we pin to EMBEDDING_DIM (1024).
    body: JSON.stringify({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIM, input: texts }),
  });
  if (!res.ok) {
    // Surface status only — never the input texts (no content in errors/logs, §11.10).
    const detail = await res.text().catch(() => '');
    throw new Error(`embed failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  const data = json.data ?? [];
  // OpenAI returns vectors in input order, but sort by `index` defensively so a pairing bug can't mislabel.
  const vectors = data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);

  if (vectors.length !== texts.length) {
    throw new Error(`embed returned ${vectors.length} vectors for ${texts.length} inputs`);
  }
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIM) {
      throw new Error(`embed returned dim ${v.length}, expected the pinned ${EMBEDDING_DIM}`);
    }
  }
  return vectors;
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
