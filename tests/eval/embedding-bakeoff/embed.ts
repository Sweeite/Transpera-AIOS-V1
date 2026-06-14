/**
 * Vendor embedding adapters for the bake-off (Issue #1).
 *
 * Chokepoint-safe by construction (#46): this lives OUTSIDE packages/core and imports NO provider SDK —
 * it speaks raw HTTPS. Only the WINNING model's call ever lands in `gateway.embed()`. Nothing here is the
 * production path; it is throwaway eval tooling.
 *
 * Keys are read from env (never committed): VOYAGE_API_KEY, OPENAI_API_KEY, COHERE_API_KEY.
 * Results are cached to ./corpus/.cache (gitignored) keyed on (vendor,model,dim,dtype,inputType,text) so
 * re-runs don't re-spend the client's BYO budget.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, Dtype } from './candidates.ts';

export type InputType = 'document' | 'query';
/** A vector is numbers whether float or int8 — cosine works on both; we calibrate on what we ship (#3). */
export type Vector = number[];

const CACHE_DIR = join(import.meta.dirname, 'corpus', '.cache');

function cacheKey(c: Candidate, inputType: InputType, text: string): string {
  const h = createHash('sha256');
  h.update(`${c.vendor}|${c.model}|${c.dim}|${c.dtype}|${inputType}|${text}`);
  return h.digest('hex');
}

function readCache(key: string): Vector | null {
  const f = join(CACHE_DIR, `${key}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Vector) : null;
}
function writeCache(key: string, v: Vector): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(v));
}

/** L2-normalize so cosine == dot and scales are comparable across candidates (the bake-off contract). */
export function l2normalize(v: Vector): Vector {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n === 0 ? v : v.map((x) => x / n);
}

function requireKey(name: string): string {
  const k = process.env[name];
  if (!k) throw new Error(`Missing ${name} in env — set the vendor's BYO key before running the bake-off.`);
  return k;
}

// ── vendor calls (one batch → many vectors) ────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * POST JSON with bounded retry on 429/5xx (the free-tier rate-limit + transient case; real-corpus scale hits
 * this too). Honours a Retry-After header when present, else exponential backoff. Throws on non-retriable
 * status or after the last attempt — never silently returns a partial/empty batch (silent-failure guard).
 */
async function postJSON<T>(url: string, key: string, body: unknown, label: string): Promise<T> {
  const backoff = [4000, 12000, 30000, 60000]; // covers a 3 RPM per-minute window
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as T;
    const text = await res.text();
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= backoff.length) throw new Error(`${label} ${res.status}: ${text}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff[attempt];
    console.warn(`  … ${label} ${res.status}; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${backoff.length})`);
    await sleep(wait);
  }
}

async function callVoyage(model: string, dim: number, dtype: Dtype, inputType: InputType, texts: string[]): Promise<Vector[]> {
  const j = await postJSON<{ data: { embedding: number[] }[] }>(
    'https://api.voyageai.com/v1/embeddings',
    requireKey('VOYAGE_API_KEY'),
    { model, input: texts, input_type: inputType, output_dimension: dim, output_dtype: dtype },
    'Voyage',
  );
  return j.data.map((d) => d.embedding);
}

async function callOpenAI(model: string, dim: number, _dtype: Dtype, _inputType: InputType, texts: string[]): Promise<Vector[]> {
  // OpenAI is symmetric (no input_type) and returns float; dimension reduction via `dimensions`.
  const j = await postJSON<{ data: { embedding: number[]; index: number }[] }>(
    'https://api.openai.com/v1/embeddings',
    requireKey('OPENAI_API_KEY'),
    { model, input: texts, dimensions: dim },
    'OpenAI',
  );
  return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function callCohere(model: string, _dim: number, dtype: Dtype, inputType: InputType, texts: string[]): Promise<Vector[]> {
  const embType = dtype === 'float' ? 'float' : dtype; // 'int8' | 'binary' | 'float'
  const res = await fetch('https://api.cohere.com/v2/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${requireKey('COHERE_API_KEY')}` },
    body: JSON.stringify({
      model,
      texts,
      input_type: inputType === 'document' ? 'search_document' : 'search_query',
      embedding_types: [embType],
    }),
  });
  if (!res.ok) throw new Error(`Cohere ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { embeddings: Record<string, number[][]> };
  return j.embeddings[embType];
}

/**
 * Embed a list of texts for one candidate at one input type. Batches, caches, and L2-normalizes float.
 * int8/binary are returned as the vendor quantized them (we score on the shipped representation, #3).
 */
export async function embedAll(c: Candidate, inputType: InputType, texts: string[], batch = 96): Promise<Vector[]> {
  const out: (Vector | null)[] = texts.map((t) => readCache(cacheKey(c, inputType, t)));
  const missingIdx = out.flatMap((v, i) => (v === null ? [i] : []));

  for (let i = 0; i < missingIdx.length; i += batch) {
    const slice = missingIdx.slice(i, i + batch);
    const sliceTexts = slice.map((idx) => texts[idx]);
    let vecs: Vector[];
    if (c.vendor === 'voyage') vecs = await callVoyage(c.model, c.dim, c.dtype, inputType, sliceTexts);
    else if (c.vendor === 'openai') vecs = await callOpenAI(c.model, c.dim, c.dtype, inputType, sliceTexts);
    else vecs = await callCohere(c.model, c.dim, c.dtype, inputType, sliceTexts);

    slice.forEach((idx, k) => {
      const v = c.dtype === 'float' ? l2normalize(vecs[k]) : vecs[k];
      out[idx] = v;
      writeCache(cacheKey(c, inputType, texts[idx]), v);
    });
  }
  return out as Vector[];
}
