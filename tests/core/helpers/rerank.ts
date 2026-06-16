/**
 * Test stand-ins for gateway.rerank() — the #14 chokepoint, injected hermetically exactly like `embed`
 * (no network). The real reranker is Voyage (ADR 0003); these fakes make the abstention floor deterministic.
 *
 * The reranker receives only (query, documentStrings) — NOT vectors — so a fake scores off the document TEXT,
 * the same way synthVector keys the fake embedder off text. Three shapes cover every test need:
 *   • constReranker  — every candidate gets the same score (the workhorse for ranking/diagnostics/leak tests
 *                       where the floor is NOT the point: pick a high score so everything clears).
 *   • scriptedReranker — per-document-text score (the floor IS the point: craft drop/clear behaviour).
 *   • spyReranker    — wraps any reranker and records EVERY call (query + documents) — the egress probe:
 *                       proves a denied principal sends ZERO content to the reranker, not just zero rows back.
 *   • throwingReranker — simulates the provider being down (Decision A: abstain + alert).
 */
import type { Reranker } from '../../../packages/core/src/harness/gateway.ts';

/** Every document scored identically. Default 0.99 ⇒ clears any sane floor (use when the floor isn't the test). */
export function constReranker(score = 0.99): Reranker {
  return async (_query, documents) => documents.map(() => score);
}

/** Per-document-text score. Unlisted documents get `dflt`. Lets a test pin a candidate's rerank score exactly. */
export function scriptedReranker(byText: Record<string, number>, dflt = 0): Reranker {
  return async (_query, documents) => documents.map((d) => (d in byText ? byText[d]! : dflt));
}

/** Wrap a reranker and record every call — the content-egress probe (what text reached the provider). */
export function spyReranker(inner: Reranker = constReranker()): {
  rerank: Reranker;
  calls: Array<{ query: string; documents: string[] }>;
} {
  const calls: Array<{ query: string; documents: string[] }> = [];
  const rerank: Reranker = async (query, documents) => {
    calls.push({ query, documents });
    return inner(query, documents);
  };
  return { rerank, calls };
}

/** The provider is down — every call throws (Decision A: retrieve() must abstain + alert, never fall back). */
export function throwingReranker(message = 'rerank failed: 503 Service Unavailable'): Reranker {
  return async () => {
    throw new Error(message);
  };
}
