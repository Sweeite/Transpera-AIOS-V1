/**
 * Issue #14 — gateway.rerank(): the SECOND pinned provider call (after embed). These are HERMETIC unit tests
 * that stub global fetch — they prove the response parsing + the error-hygiene red lines WITHOUT a network
 * call. The real Voyage call is exercised key-gated in rerank.real.test.ts.
 *
 * Load-bearing properties:
 *   - scores are returned in INPUT order even when the provider sorts them by score (the index re-key);
 *   - a wrong score count / out-of-range index / non-finite score FAILS LOUD (never a mis-aligned score);
 *   - errors NEVER echo the documents (status-only, §11.10) — a leak here would defeat the egress guarantee;
 *   - an empty document list short-circuits with NO provider call (no key needed, no spend).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rerank, RERANKER_MODEL } from '../../packages/core/src/harness/gateway.ts';

const SECRET_DOC = 'SECRET: Acme margin is 42 percent';

function stubFetch(impl: (url: string, init: any) => { ok: boolean; status?: number; statusText?: string; json?: any; text?: string }) {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const r = impl(url, init);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.statusText ?? '',
      json: async () => r.json,
      text: async () => r.text ?? '',
    } as unknown as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VOYAGE_API_KEY;
});

describe('#14 gateway.rerank() (hermetic)', () => {
  it('returns one score per document IN INPUT ORDER even when the provider sorts by score', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    // Provider returns results sorted by relevance (index 1 first), to prove we re-key by index.
    stubFetch(() => ({
      ok: true,
      json: { data: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.5 }] },
    }));

    const scores = await rerank('q', ['doc-a', 'doc-b', 'doc-c']);
    expect(scores).toEqual([0.2, 0.9, 0.5]); // aligned to input order, not provider order
  });

  it('sends the pinned model + does NOT ask the provider to echo documents back', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    let sentBody: any;
    stubFetch((_url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: { data: [{ index: 0, relevance_score: 0.7 }] } };
    });

    await rerank('the query', ['only-doc']);
    expect(sentBody.model).toBe(RERANKER_MODEL);
    expect(sentBody.return_documents).toBe(false);
    expect(sentBody.documents).toEqual(['only-doc']);
  });

  it('returns [] for an empty document list WITHOUT a provider call (no key required)', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await rerank('q', [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('FAILS LOUD on a wrong score count (never a mis-aligned score)', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    stubFetch(() => ({ ok: true, json: { data: [{ index: 0, relevance_score: 0.7 }] } })); // 1 score for 2 docs
    await expect(rerank('q', ['a', 'b'])).rejects.toThrow(/1 scores for 2 documents/);
  });

  it('FAILS LOUD on an out-of-range index', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    stubFetch(() => ({ ok: true, json: { data: [{ index: 5, relevance_score: 0.7 }] } }));
    await expect(rerank('q', ['a'])).rejects.toThrow(/out-of-range index/);
  });

  it('an error response NEVER leaks the documents — status only, even when the 4xx body ECHOES the request (§11.10)', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    // A 4xx body that echoes our request payload back — the realistic Voyage failure mode (validation errors
    // quote the offending input). The error must surface NEITHER the document NOR any of the provider body.
    const echoBody = `400 invalid request: documents=["${SECRET_DOC}"] model=rerank-2.5-lite`;
    stubFetch(() => ({ ok: false, status: 400, statusText: 'Bad Request', text: echoBody }));

    await expect(rerank('the query', [SECRET_DOC])).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(SECRET_DOC), // never the document
      }),
    );
    // And not the provider body at all — status + statusText only (the regression: the body must not be appended).
    await expect(rerank('the query', [SECRET_DOC])).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('invalid request') }),
    );
    await expect(rerank('the query', [SECRET_DOC])).rejects.toThrow(/^rerank failed: 400 Bad Request$/);
  });

  it('fails loud when VOYAGE_API_KEY is missing (never a silent uncalibrated answer)', async () => {
    await expect(rerank('q', ['a'])).rejects.toThrow(/VOYAGE_API_KEY is not set/);
  });
});
