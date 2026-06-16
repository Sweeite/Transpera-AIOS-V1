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

/**
 * A function that scores each document's relevance to a query — the cross-encoder reranker (#14). `rerank`
 * (below) is the ONLY producer in production; this type is exported so the read path (harness/retrieval) can
 * inject a deterministic stand-in in hermetic tests, exactly like `Embedder`. Returns one score per document,
 * IN INPUT ORDER (parallel to how `embed` returns one vector per input). The score is the calibrated
 * abstention floor input (ADR 0003) — a DIFFERENT scale from the dense cosine it supersedes.
 */
export type Reranker = (query: string, documents: string[]) => Promise<number[]>;

export interface CallOptions<T = string> {
  taskClass: TaskClass; // drives Anthropic-tier routing (Haiku→Sonnet→Opus), quality-gated by eval fixtures (#32)
  system?: string; // stable prefix → prompt-cached (cache_control on the system block; ~0.1× on cache-read tokens, §5.3)
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** When set, the model is FORCED to emit structured output validated against this zod schema. */
  schema?: z.ZodType<T>;
  stream?: boolean; // #10 ships NON-streaming only; stream:true fails loud (real streaming deferred to #54).
  maxTokens?: number; // optional per-call override of the bounded `generation_max_tokens` config cap.
}

/**
 * What the gateway genuinely knows about a call. #11 folds this into a full `TraceSpan` with the run context
 * (taskId / principal / trigger) the gateway does not own. NOTE: `model` is the model that ACTUALLY answered
 * (a fallback may have served it — see `fallback`), while the token/cost figures are the AGGREGATE across
 * EVERY round-trip this call made (failed primary + repair + fallback), so cost is never under-reported.
 */
export interface ModelUsage {
  model: string; // the model that produced the returned answer (post-fallback)
  tokensIn?: number; // aggregate input tokens billed across all round-trips
  tokensOut?: number; // aggregate output tokens across all round-trips
  cacheReadTokens?: number; // prompt-cache hits — priced at the cache-read rate (the "reduced input cost", §5.3)
  cacheWriteTokens?: number; // prompt-cache writes — priced at the 5-min ephemeral write rate
  costUsd?: number; // aggregate spend across all round-trips, per the pricing table (§11.7)
  durationMs: number; // total wall time of the whole call (all attempts)
  attempts?: number; // number of transport round-trips made (observability + the bounded-ceiling guard)
  /** Set whenever the answering model is NOT the routed primary — a downgrade is a quality event, never silent. */
  fallback?: { from: string; reason: 'timeout' | 'transient' | 'validation' };
}

export interface CallResult<T = string> {
  output: T;
  usage: ModelUsage;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Transport seam (DI) + provider adapter. The transport is ONE provider HTTP round-trip — injectable so
// fallback / repair / cost / cache-hit behaviour is testable HERMETICALLY (a fake that simulates a timeout,
// malformed output, a cache-read) WITHOUT a global-fetch stub or the real API. All retry/repair/fallback
// orchestration sits ABOVE the transport, in callModel. The adapter (Anthropic, the only one today) is the
// per-provider concern: it builds the request body (incl. the cache_control prefix) and parses the response.
// Both live in THIS file so the #46 chokepoint stays singular — no provider SDK import, no host literal elsewhere.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A single provider HTTP call, as the adapter has prepared it. */
export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  model: string;
  timeoutMs: number; // effective per-call timeout = min(request timeout, remaining total deadline)
}

/** The raw provider JSON the adapter knows how to parse (Anthropic messages shape). */
export interface ProviderRawResponse {
  content?: Array<{ type: string; name?: string; text?: string; input?: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export type Transport = (req: ProviderRequest) => Promise<ProviderRawResponse>;

/** Why a transport call failed — drives the orchestration: fatal short-circuits, transient/timeout retry+fallback. */
export type TransportErrorKind = 'timeout' | 'transient' | 'fatal';

/** A typed transport failure. `fatal` (4xx except 429) must surface immediately — a bad key/model id will
 *  fail identically on retry/fallback, so masking it behind a downgrade would hide the real bug. */
export class GatewayTransportError extends Error {
  constructor(
    public readonly kind: TransportErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayTransportError';
  }
}

/** The gateway-known slice of a trace span (#11 attaches run context + writes the store). */
export interface GatewaySpan {
  model: string;
  taskClass: TaskClass;
  structured: boolean;
  ok: boolean; // false ⇒ the call exhausted its chain and threw — the spend is still recorded (no silent failure)
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  durationMs: number;
  attempts: number;
  fallback?: { from: string; reason: 'timeout' | 'transient' | 'validation' };
}

/** Bounded dials — every one a `system_config` key (no magic numbers, §4.8). Resolved per call. */
export interface GatewayConfig {
  retryCount: number; // transient/timeout retries per model BEFORE advancing to the fallback
  retryBackoffMs: number; // base linear backoff between retries
  repairAttempts: number; // THE audit cap — structured-validation repairs on the PRIMARY (default 1)
  requestTimeoutMs: number; // per-call abort timeout
  totalDeadlineMs: number; // overall wall-clock ceiling across all attempts (caps N × per-call)
  maxTokens: number; // output cap (generation_max_tokens)
}

export interface GatewayDeps {
  transport?: Transport; // default: the real Anthropic fetch transport
  onSpan?: (span: GatewaySpan) => void; // trace sink (#11). Absent ⇒ no span (caller's choice); fallback still on usage.
  now?: () => number; // injectable clock (deadline checks) — default Date.now
  sleep?: (ms: number) => Promise<void>; // injectable backoff — default real timer
  /** Scope-resolved config overrides. Absent keys fall back to the sync declared `defaultFor` (no flag-day, per
   *  the #8 carry-forward: gateway stays on `defaultFor`). A caller WITH a `query` can pass getConfig values here. */
  config?: Partial<GatewayConfig>;
}

// The forced-tool name the structured path uses. The model is required to call exactly this tool, so its
// validated input IS the structured output — far more reliable than "return JSON + parse".
const STRUCTURED_TOOL_NAME = 'emit_structured_output';

// ── Generation models: Anthropic tiers (generation is Claude-first, Brief §12). Embeddings stay pinned to
//    OpenAI (below) and are NEVER routed (#1) — out of scope here. ────────────────────────────────────────
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'; // dated id — the cheap synthesis tier
export const SONNET_MODEL = 'claude-sonnet-4-6'; // the safe default for structured/hard classes (until #32)
export const OPUS_MODEL = 'claude-opus-4-8'; // the strongest fallback

// Pricing — $ per 1,000,000 tokens. Source: claude-api skill, "Current Models (cached: 2026-06-04)".
// Cache-read = 0.1× input, cache-write (5-min ephemeral) = 1.25× input — claude-api prompt-caching reference.
const PRICING: Record<string, { inPerMtok: number; outPerMtok: number }> = {
  [HAIKU_MODEL]: { inPerMtok: 1.0, outPerMtok: 5.0 },
  [SONNET_MODEL]: { inPerMtok: 3.0, outPerMtok: 15.0 },
  [OPUS_MODEL]: { inPerMtok: 5.0, outPerMtok: 25.0 },
};
const CACHE_READ_MULT = 0.1; // claude-api: cache reads ~0.1× base input price
const CACHE_WRITE_MULT = 1.25; // claude-api: 5-minute ephemeral cache writes ~1.25× base input price

// Routing MAP (declared structure, not a scalar dial — allowed by the no-magic-numbers rule). Ordered chain:
// [primary, fallback]. CONSERVATIVE UNTIL #32 (the Watch): a STRUCTURED call never STARTS on Haiku — a cheap
// model bad at JSON burns the saving in repair cost. #32's eval fixtures will validate cheaper routes later.
const TIER_CHAIN: Record<TaskClass, readonly [string, string]> = {
  classify: [HAIKU_MODEL, SONNET_MODEL],
  summarise: [HAIKU_MODEL, SONNET_MODEL],
  extract: [SONNET_MODEL, OPUS_MODEL],
  reason: [SONNET_MODEL, OPUS_MODEL],
  synthesize: [SONNET_MODEL, OPUS_MODEL],
};

function routeChain(taskClass: TaskClass, structured: boolean): readonly [string, string] {
  const base = TIER_CHAIN[taskClass];
  // A structured call on a Haiku-primary class is upgraded to the safe chain until #32 clears the cheap route.
  if (structured && base[0] === HAIKU_MODEL) return [SONNET_MODEL, OPUS_MODEL];
  return base;
}

function resolveConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  // Each key reads the scope-resolved override, else the bounded declared default (sync, no DB — #8 carry-forward).
  return {
    retryCount: overrides?.retryCount ?? (defaultFor('gateway_retry_count') as number),
    retryBackoffMs: overrides?.retryBackoffMs ?? (defaultFor('gateway_retry_backoff_ms') as number),
    repairAttempts: overrides?.repairAttempts ?? (defaultFor('gateway_repair_attempts') as number),
    requestTimeoutMs: overrides?.requestTimeoutMs ?? (defaultFor('gateway_request_timeout_ms') as number),
    totalDeadlineMs: overrides?.totalDeadlineMs ?? (defaultFor('gateway_total_deadline_ms') as number),
    maxTokens: overrides?.maxTokens ?? (defaultFor('generation_max_tokens') as number),
  };
}

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
}

/** Build the Anthropic request body for one model. Prompt caching is a per-provider adapter concern: the stable
 *  `system` prefix carries cache_control so its tokens bill at the cache-read rate on repeat (per-model by
 *  construction — each model builds its own body, so a Haiku-cached prefix is never sent on a Sonnet call). */
function buildAnthropicBody<T>(
  opts: CallOptions<T>,
  model: string,
  maxTokens: number,
  messages: CallOptions<T>['messages'],
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages };
  if (opts.system) {
    // Array form with cache_control — the stable prefix is prompt-cached (input-token savings; NOT a response cache).
    body.system = [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }];
  }
  if (opts.schema) {
    const jsonSchema = z.toJSONSchema(opts.schema) as Record<string, unknown>;
    delete jsonSchema.$schema; // Anthropic wants a bare input_schema object
    body.tools = [
      {
        name: STRUCTURED_TOOL_NAME,
        description: 'Return the answer in exactly this structure. You MUST call this tool.',
        input_schema: jsonSchema,
      },
    ];
    body.tool_choice = { type: 'tool', name: STRUCTURED_TOOL_NAME }; // FORCE the tool — no free-text escape
  }
  return body;
}

interface RoundTripUsage {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function parseUsage(raw: ProviderRawResponse): RoundTripUsage {
  const u = raw.usage ?? {};
  return {
    tokensIn: u.input_tokens ?? 0,
    tokensOut: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Cost of ONE round-trip, priced by the model that served it — so a mixed-model chain (Sonnet → Opus) is
 *  priced correctly, and cache-read tokens bill at 0.1× (how "a cached prefix shows reduced input cost" shows up). */
function priceRoundTrip(model: string, u: RoundTripUsage): number {
  const p = PRICING[model];
  if (!p) {
    // Untracked cost is a silent failure (§11.7) — fail loud rather than bill $0 for an unpriced model.
    throw new Error(`callModel: no pricing for model '${model}' — declare it in PRICING (no untracked cost).`);
  }
  return (
    (u.tokensIn * p.inPerMtok +
      u.cacheReadTokens * p.inPerMtok * CACHE_READ_MULT +
      u.cacheWriteTokens * p.inPerMtok * CACHE_WRITE_MULT +
      u.tokensOut * p.outPerMtok) /
    1_000_000
  );
}

/** Append one content-free repair turn naming the validation failure (field paths only — never prompt content). */
function withRepairTurn<T>(base: CallOptions<T>['messages'], reason: string): CallOptions<T>['messages'] {
  return [
    ...base,
    {
      role: 'user',
      content:
        `Your previous response did not satisfy the required structure (${reason}). ` +
        `Re-emit a corrected response by calling the ${STRUCTURED_TOOL_NAME} tool with valid fields.`,
    },
  ];
}

type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

function validateStructured<T>(raw: ProviderRawResponse, schema: z.ZodType<T>): Validation<T> {
  const block = (raw.content ?? []).find((b) => b.type === 'tool_use' && b.name === STRUCTURED_TOOL_NAME);
  if (!block) return { ok: false, reason: `no ${STRUCTURED_TOOL_NAME} tool_use block` };
  const parsed = schema.safeParse(block.input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const summary = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return { ok: false, reason: summary };
}

function textOf(raw: ProviderRawResponse): string {
  return (raw.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** The real transport: ONE Anthropic HTTP round-trip via direct fetch (no SDK → #46 stays green). Classifies
 *  failures so the orchestrator can decide: abort 4xx fatally, retry/fallback 429/5xx/timeout. */
const defaultTransport: Transport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new GatewayTransportError('timeout', `callModel: request timed out after ${req.timeoutMs}ms`);
    }
    throw new GatewayTransportError('transient', `callModel: network error (${String(e)})`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Surface status only — never the prompt/messages content (no content in errors/logs, §11.10).
    const detail = await res.text().catch(() => '');
    // 429 (rate limit) + 5xx (incl. 529 overloaded) are transient/retryable; every other 4xx is fatal.
    const kind: TransportErrorKind = res.status === 429 || res.status >= 500 ? 'transient' : 'fatal';
    throw new GatewayTransportError(kind, `callModel failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as ProviderRawResponse;
};

/**
 * The bound on TOTAL transport round-trips — the PRODUCT of the levers, not each alone (so total wall-cost can't
 * blow up). validationAttempts = primary(initial + repairs) + one single-shot per fallback model; each attempt
 * may incur up to (1 + retryCount) transient/timeout retries. Defaults: structured 3 × 3 = 9; plain 2 × 3 = 6.
 */
function maxTransportCalls(cfg: GatewayConfig, chainLen: number, structured: boolean): number {
  const validationAttempts = structured ? 1 + cfg.repairAttempts + (chainLen - 1) : chainLen;
  return validationAttempts * (1 + cfg.retryCount);
}

/**
 * THE single chokepoint for generation (PRD §6.1) — extends the #5 minimal call with TaskClass routing across
 * Anthropic tiers, a bounded fallback chain, bounded structured-output repair (the ⚠ audit fix), per-provider
 * prompt caching, and aggregate cost + a trace span. Direct REST only, no provider SDK (#46). BYO key per client
 * from env (fail loud if missing). Streaming is deferred to #54 — stream:true fails loud here.
 *
 * Fallback is NEVER silent: usage.model is the model that ACTUALLY answered and usage.fallback records the
 * downgrade. Repair is bounded: 1 repair on the primary → escalate to the fallback (single shot) → throw LOUD.
 * Fatal (4xx) short-circuits with no retry/fallback. Cost + the span AGGREGATE every round-trip, not just the
 * answering call. An overall deadline caps total wall-time so it can't reach N × per-call timeout.
 */
export async function callModel<T = string>(opts: CallOptions<T>, deps: GatewayDeps = {}): Promise<CallResult<T>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — callModel cannot run (fail loud, never a silent empty answer).');
  }
  if (opts.stream) {
    // No silent non-stream, and no un-traced streamed call — real streaming is deferred to #54.
    throw new Error('callModel: streaming requested (stream:true) but deferred to #54 — #10 is non-streaming.');
  }

  const cfg = resolveConfig(deps.config);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const transport = deps.transport ?? defaultTransport;
  const headers = anthropicHeaders(apiKey);

  const structured = !!opts.schema;
  const maxTokens = opts.maxTokens ?? cfg.maxTokens;
  const chain = routeChain(opts.taskClass, structured);
  const ceiling = maxTransportCalls(cfg, chain.length, structured);
  const start = now();

  // Aggregates across EVERY round-trip (failed primary + repair + fallback) — so cost is never under-reported.
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let attempts = 0;

  /** One transport call: bumps the counter, enforces the ceiling + the overall deadline, accumulates cost. */
  const callOnce = async (model: string, messages: CallOptions<T>['messages']): Promise<ProviderRawResponse> => {
    const elapsed = now() - start;
    if (elapsed >= cfg.totalDeadlineMs) {
      throw new GatewayTransportError('timeout', `callModel: total deadline ${cfg.totalDeadlineMs}ms exceeded`);
    }
    if (attempts >= ceiling) {
      // Defensive backstop — the loop structure already bounds this; tripping it is a bug, surfaced loudly.
      throw new Error(`callModel: exceeded the ${ceiling}-round-trip ceiling (bounded retry × repair × models).`);
    }
    attempts += 1;
    const timeoutMs = Math.min(cfg.requestTimeoutMs, cfg.totalDeadlineMs - elapsed);
    const body = buildAnthropicBody(opts, model, maxTokens, messages);
    const raw = await transport({ url: ANTHROPIC_MESSAGES_URL, headers, body, model, timeoutMs });
    const u = parseUsage(raw);
    tokensIn += u.tokensIn;
    tokensOut += u.tokensOut;
    cacheReadTokens += u.cacheReadTokens;
    cacheWriteTokens += u.cacheWriteTokens;
    costUsd += priceRoundTrip(model, u); // priced by the serving model — correct across a mixed chain
    return raw;
  };

  /** Transient/timeout retries on ONE model, with backoff. Fatal (4xx) rethrows immediately (no retry). */
  const attemptModel = async (model: string, messages: CallOptions<T>['messages']): Promise<ProviderRawResponse> => {
    let lastErr: unknown;
    for (let r = 0; r <= cfg.retryCount; r++) {
      try {
        return await callOnce(model, messages);
      } catch (e) {
        if (e instanceof GatewayTransportError && e.kind === 'fatal') throw e; // short-circuit — no retry, no fallback
        if (!(e instanceof GatewayTransportError)) throw e; // ceiling/deadline/programming error — surface it
        lastErr = e;
        if (r < cfg.retryCount) await sleep(cfg.retryBackoffMs * (r + 1));
      }
    }
    throw lastErr; // transient/timeout exhausted on this model
  };

  let answering: string = chain[0]; // readonly [string, string] — index 0 always present
  let output: T | undefined;
  let succeeded = false;
  let fallbackInfo: ModelUsage['fallback'];
  let lastReason = '';

  // Walk the chain. The PRIMARY gets up to `repairAttempts` structured repairs; later models get a single shot.
  chainLoop: for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi]!; // bounded by chain.length
    const repairsAllowed = mi === 0 && structured ? cfg.repairAttempts : 0;
    let messages = opts.messages;

    for (let rep = 0; rep <= repairsAllowed; rep++) {
      let raw: ProviderRawResponse;
      try {
        raw = await attemptModel(model, messages);
      } catch (e) {
        if (e instanceof GatewayTransportError && e.kind === 'fatal') {
          // A bad key / wrong model id fails identically on any model — surface it, never mask with a fallback.
          answering = model;
          lastReason = e.message;
          break chainLoop;
        }
        // transient/timeout exhausted on this model → advance to the fallback (recording the downgrade reason)
        const reason: 'timeout' | 'transient' =
          e instanceof GatewayTransportError && e.kind === 'timeout' ? 'timeout' : 'transient';
        lastReason = e instanceof Error ? e.message : String(e);
        if (mi < chain.length - 1) fallbackInfo = { from: model, reason };
        continue chainLoop;
      }

      if (!structured) {
        const text = textOf(raw);
        if (text.trim() === '') {
          // No silent empty answer (red line, §3.2): an empty completion is NOT a valid answer. Escalate like a
          // validation failure (non-structured gets no repair) → fallback, and a dry chain throws loud below.
          lastReason = 'empty text completion';
          if (mi < chain.length - 1) fallbackInfo = { from: model, reason: 'validation' };
          continue chainLoop;
        }
        answering = model;
        output = text as unknown as T;
        succeeded = true;
        break chainLoop;
      }

      const v = validateStructured(raw, opts.schema!);
      if (v.ok) {
        answering = model;
        output = v.value;
        succeeded = true;
        break chainLoop;
      }
      lastReason = v.reason;
      if (rep < repairsAllowed) {
        // Bounded repair on the same (primary) model. Chain from the CURRENT messages (not opts.messages) so a
        // 2nd repair appends to the 1st — the model sees every prior failure, not just the latest (config max 2).
        messages = withRepairTurn(messages, v.reason);
        continue;
      }
      // repairs exhausted on this model → escalate to the fallback (a validation downgrade, recorded)
      if (mi < chain.length - 1) fallbackInfo = { from: model, reason: 'validation' };
      continue chainLoop;
    }
  }

  const durationMs = now() - start;
  const usage: ModelUsage = {
    model: answering,
    durationMs,
    attempts,
    ...(tokensIn ? { tokensIn } : {}),
    ...(tokensOut ? { tokensOut } : {}),
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    costUsd,
    ...(succeeded && fallbackInfo ? { fallback: fallbackInfo } : {}),
  };

  // Every call records a span — even a total failure (the spend is real, and the failure must be alertable).
  if (deps.onSpan) {
    deps.onSpan({
      model: answering,
      taskClass: opts.taskClass,
      structured,
      ok: succeeded,
      durationMs,
      attempts,
      costUsd,
      ...(tokensIn ? { tokensIn } : {}),
      ...(tokensOut ? { tokensOut } : {}),
      ...(cacheReadTokens ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
      // #10 carry-forward (1): record fallback on the span REGARDLESS of success — a call that fell back and
      // THEN failed must still show on its span that a downgrade was attempted (not only on a successful usage).
      ...(fallbackInfo ? { fallback: fallbackInfo } : {}),
    });
  }

  if (!succeeded) {
    // LOUD — never surface a malformed/empty answer. The aggregate spend is on the span above; #10 carry-forward
    // (2): also surface costUsd in the throw so a failed call's spend is visible even with NO onSpan sink wired.
    throw new Error(
      `callModel: exhausted ${chain.length} model(s) for taskClass=${opts.taskClass} after ${attempts} round-trip(s) ` +
        `(last: ${lastReason}, costUsd=${costUsd}) — refusing to surface a malformed/empty answer.`,
    );
  }

  return { output: output as T, usage };
}

/** The cheap synthesis tier id, kept exported for callers/tests that reference the Haiku pin by name. */
export const GENERATION_MODEL = HAIKU_MODEL;

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

/**
 * The cross-encoder RERANKER — the SECOND pinned provider call (after `embed`), and the second place the #46
 * chokepoint owns. It scores the top-N FUSED candidates against the query; the max score is the calibrated
 * abstention floor (#14, Brief §4.7). Like `embed` it is PINNED and NEVER cost-routed (a reranker swap =
 * re-calibrate the floor, ADR 0003), speaks raw REST (no SDK → #46 stays green), and fails LOUD with
 * STATUS-ONLY errors — the documents (memory statements) are NEVER echoed into an error or log (§11.10).
 *
 * Returns one relevance score per document, in INPUT ORDER. The caller (retrieve) passes ONLY the documents a
 * principal is authorized to see — the permission predicate already filtered both legs (#13), so a forbidden
 * statement never reaches this call (proved by reranker-egress.test.ts). One call per query (the Watch).
 */
export async function rerank(query: string, documents: string[]): Promise<number[]> {
  if (documents.length === 0) return []; // nothing to score — no provider call
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY is not set — the reranker cannot run (fail loud, never a silent uncalibrated answer).');
  }

  const timeoutMs = defaultFor('reranker_timeout_ms') as number;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(VOYAGE_RERANK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // return_documents:false — we only need the scores; never ask the provider to echo the documents back.
      body: JSON.stringify({ model: RERANKER_MODEL, query, documents, return_documents: false }),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`rerank: request timed out after ${timeoutMs}ms`); // no content — just the timeout
    }
    throw new Error(`rerank: network error (${String(e)})`); // String(e) is the transport error, never a document
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Surface status only — never the query/documents (no content in errors/logs, §11.10).
    const detail = await res.text().catch(() => '');
    throw new Error(`rerank failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data?: Array<{ index: number; relevance_score: number }> };
  const data = json.data ?? [];
  if (data.length !== documents.length) {
    throw new Error(`rerank returned ${data.length} scores for ${documents.length} documents`);
  }
  // Voyage returns results that may be sorted by score; re-key by `index` so scores align to INPUT order
  // (defensively, exactly as embed() sorts by index) — a pairing bug here would mis-score the wrong document.
  const scores = new Array<number>(documents.length);
  for (const d of data) {
    if (!Number.isInteger(d.index) || d.index < 0 || d.index >= documents.length) {
      throw new Error(`rerank returned an out-of-range index ${d.index} for ${documents.length} documents`);
    }
    if (typeof d.relevance_score !== 'number' || !Number.isFinite(d.relevance_score)) {
      throw new Error(`rerank returned a non-finite relevance_score at index ${d.index}`);
    }
    scores[d.index] = d.relevance_score;
  }
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] === undefined) throw new Error(`rerank returned no score for document ${i}`);
  }
  return scores;
}

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ PROVISIONAL RERANKER PIN (#14, ADR 0003) — NOT VALIDATED on real data. The MODEL is the vendor we send
//   memory statements to (a new content subprocessor, ADR 0003 §subprocessor); the floor it binds is in
//   system-config (`retrieval_min_relevance`). Changing EITHER value = re-calibrate the floor (the tripwire).
//   It is a CONSTANT (not a system_config key): a model name is not a threshold/weight/floor (so it sits
//   outside the §4.8 config red line), and EMBEDDING_MODEL is the precedent — a pin lives in code + an ADR,
//   never a per-namespace-overridable row (which could silently diverge from the floor it was calibrated on).
//   Real model + floor decided at first-client onboarding (#43), on the shipped representation. ⚠
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const RERANKER_MODEL = 'rerank-2.5-lite'; // Voyage; provisional (#14) — cheap (the Watch), real pin → #43
export const RERANKER_VERSION = '0-provisional'; // leading-0 = NOT the validated pin; bumped at first-client (#43)

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
// NOTE: generation model tiers (Haiku/Sonnet/Opus), the routing MAP, and pricing live next to `callModel`
// above (#10). Embeddings stay pinned to OpenAI and are NEVER routed (#1) — out of scope for the generation path.
export const EMBEDDING_MODEL = 'text-embedding-3-large'; // PROVISIONAL (#1) — real pin deferred to #43
export const EMBEDDING_DIM = 1024; // → vector(1024) + HNSW in #2; one-way door once a corpus is embedded
export const EMBEDDING_DTYPE = 'float' as const; // un-quantized v0; int8/binary trade decided in #3
export const EMBEDDING_VERSION = '0-provisional'; // leading-0 = NOT the validated pin; bumped at first-client
