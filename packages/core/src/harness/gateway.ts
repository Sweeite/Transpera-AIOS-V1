/**
 * LLM gateway — the single chokepoint through which EVERY model call passes (PRD §6.1).
 * Core, never plugins: model choice, fallback, embedding pinning, key isolation, cost tracking (§8.2).
 */
import { z } from 'zod';
import { defaultFor } from '../config/system-config.js';

export type TaskClass = 'classify' | 'summarise' | 'extract' | 'reason' | 'synthesize';

/**
 * A function that turns texts into pinned-dimension vectors. `embed` (below) is the ONLY producer in
 * production; this type is exported so BOTH the write path (memory/store) and the read path (harness/
 * retrieval) can inject a deterministic stand-in in hermetic tests, without a network call. Defined here —
 * next to `embed` — so neither path imports an embedding type from the other (no layering inversion).
 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface CallOptions<T = string> {
  taskClass: TaskClass; // drives multi-provider routing (cheap vs strong), quality-gated by eval fixtures
  system?: string; // stable prefix → prompt-cached (~90% off cached input tokens, §5.3)
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** When set, the model is FORCED to emit structured output validated against this zod schema. */
  schema?: z.ZodType<T>;
  stream?: boolean; // #10 — streaming not wired in the M0 minimal call
}

/** What the gateway genuinely knows about a call. #10 folds this into a full `TraceSpan` with the run context
 *  (taskId / principal / trigger) the gateway does not own, and computes costUsd via the pricing table. */
export interface ModelUsage {
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
}

export interface CallResult<T = string> {
  output: T;
  usage: ModelUsage;
}

// The forced-tool name the structured path uses. The model is required to call exactly this tool, so its
// validated input IS the structured output — far more reliable than "return JSON + parse" (which matters
// because repair is deferred to #10).
const STRUCTURED_TOOL_NAME = 'emit_structured_output';

/**
 * MINIMAL M0 model call (Issue #5) — the single chokepoint for generation, mirroring `embed` below.
 *
 * Direct REST (fetch), no provider SDK imported → the #46 chokepoint test stays green. Structured calls use
 * Anthropic FORCED TOOL-USE (tool_choice) + zod validation of the tool input; malformed/empty output FAILS
 * LOUD (no silent malformed output, no repair yet). One pinned model — #10 adds the TaskClass routing table,
 * BYO keys, fallback chain, prompt caching, repair-or-fail retry, and the per-call cost → cost monitor (§11.7).
 */
export async function callModel<T = string>(opts: CallOptions<T>): Promise<CallResult<T>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — callModel cannot run (fail loud, never a silent empty answer).');
  }

  const maxTokens = defaultFor('generation_max_tokens') as number;
  const body: Record<string, unknown> = {
    model: GENERATION_MODEL,
    max_tokens: maxTokens,
    messages: opts.messages,
    ...(opts.system ? { system: opts.system } : {}),
  };

  if (opts.schema) {
    // JSON Schema for the tool input. Strip `$schema` — Anthropic wants a bare input_schema object.
    const jsonSchema = z.toJSONSchema(opts.schema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    body.tools = [
      {
        name: STRUCTURED_TOOL_NAME,
        description: 'Return the answer in exactly this structure. You MUST call this tool.',
        input_schema: jsonSchema,
      },
    ];
    body.tool_choice = { type: 'tool', name: STRUCTURED_TOOL_NAME }; // FORCE the tool — no free-text escape
  }

  const startedAt = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const durationMs = Date.now() - startedAt;

  if (!res.ok) {
    // Surface status only — never the prompt/messages content (no content in errors/logs, §11.10).
    const detail = await res.text().catch(() => '');
    throw new Error(`callModel failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; name?: string; text?: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const usage: ModelUsage = {
    model: GENERATION_MODEL,
    durationMs,
    ...(json.usage?.input_tokens !== undefined ? { tokensIn: json.usage.input_tokens } : {}),
    ...(json.usage?.output_tokens !== undefined ? { tokensOut: json.usage.output_tokens } : {}),
  };

  if (opts.schema) {
    const block = json.content?.find((b) => b.type === 'tool_use' && b.name === STRUCTURED_TOOL_NAME);
    if (!block) {
      throw new Error('callModel: forced tool-use returned no tool_use block (refusing to surface a malformed answer).');
    }
    // zod-validate the tool input — throws LOUD on any mismatch (the structural guarantee; #10 adds repair).
    const output = opts.schema.parse(block.input);
    return { output, usage };
  }

  // Plain-text path (no schema): concatenate text blocks. `T` is `string` here.
  const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return { output: text as unknown as T, usage };
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
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// GENERATION MODEL — the M0 minimal `callModel` pin. Generation is Claude-first (Brief §12); embeddings stay
// pinned to OpenAI (above). So #10 adds the TaskClass routing table ON Anthropic, not a provider swap. Haiku
// 4.5 is the cheap synthesis tier; #10 routes stronger tiers (Sonnet/Opus) for harder TaskClasses.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const GENERATION_MODEL = 'claude-haiku-4-5-20251001'; // Haiku 4.5 — cheap synthesis; #10 adds routing

export const EMBEDDING_MODEL = 'text-embedding-3-large'; // PROVISIONAL (#1) — real pin deferred to #43
export const EMBEDDING_DIM = 1024; // → vector(1024) + HNSW in #2; one-way door once a corpus is embedded
export const EMBEDDING_DTYPE = 'float' as const; // un-quantized v0; int8/binary trade decided in #3
export const EMBEDDING_VERSION = '0-provisional'; // leading-0 = NOT the validated pin; bumped at first-client
