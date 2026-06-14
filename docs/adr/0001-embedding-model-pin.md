# ADR 0001 — Embedding model, dimension, dtype & abstention floor

- **Status:** **Provisional — pending first-client real-data bake-off.** (Not "Accepted".)
- **Date:** 2026-06-14
- **Issue:** #1 (the #1 one-way door). Real-data finalisation tracked under #43; floor re-calibration under #14.
- **Deciders:** Austin (owner), Claude (build).

## Context

The embedding model is the most expensive decision in the system to reverse. Three knobs are each a
one-way door **once a client's corpus is embedded**:

- **model** — the vector space itself (Brief §4.7: never cost-route, never mix spaces).
- **dimension N** — `vector(N)` + the HNSW index are fixed at DDL time (#2); changing N = full re-embed.
- **dtype (quantization)** — float vs int8/binary changes the cosine distribution, so it changes the floor (#3).

The abstention **floor** (`retrieval_min_relevance`) is the v1 **dense-cosine** gate (Brief §4.7 pragmatic
path): the dense leg's cosine must clear it before RRF fusion orders the survivors. It is a **different scale**
from the reranker/cross-encoder floor that lands in **#14**, so #14 **re-derives** it — never reuses this number.

**The constraint that shapes this ADR:** we have **no real data yet**, and the one-way door does not actually
close until a client's data accumulates. Deciding the true pin now would mean deciding it on synthetic content
that saturates every ranking metric — a non-decision dressed as one. So we set a **provisional development
default** and **defer the real pin to first-client onboarding (#43)**, when de-identified real content exists.

## Decision (provisional)

| Knob | Provisional value | Why this value (not a quality verdict) |
|---|---|---|
| model | **OpenAI `text-embedding-3-large`** | Stability anchor (Issue #1 *Watch* note) — lowest churn risk for a default we'll carry through M0–M8. |
| dimension **N** | **1024** | Supported by **both** finalists (OpenAI reducible via `dimensions`, Voyage native), so switching to the real winner **at the same N** is cheap. Handed to **#2** as `vector(1024)` + HNSW. |
| dtype | **float** (un-quantized) | Start un-quantized; the int8/binary RAM-vs-quality trade **and its re-calibrated floor** are part of the real bake-off (#3), not assumed now. |
| version | **`0-provisional`** | Leading `0` + suffix make it unmistakable in every vector's stamp that this space is provisional. First-client decision bumps it (a re-embed event). |
| floor (`retrieval_min_relevance`) | **0.608** | The `openai-3-large@1024/float` floor from the synthetic dry run. **Indicative starting value, not validated.** Re-derived on real data (#43) and again at the reranker (#14). |

Pinned in: `packages/core/src/harness/gateway.ts` (`EMBEDDING_MODEL` / `EMBEDDING_DIM` / `EMBEDDING_DTYPE` /
`EMBEDDING_VERSION`) and `packages/core/src/config/system-config.ts` (`retrieval_min_relevance`).

### Conscious calls recorded (additions #1–#4)

1. **Dimension** is a first-class pin (N=1024), handed to #2 — not left implicit.
2. **Floor is a STARTING value, not validated** — calibration set == test set on ~30 synthetic pairs. #14 re-derives.
3. **Floor calibrated on the shipped representation** — currently float; if an int8 variant wins the real bake-off, its floor is derived on the int8 vectors (#3).
4. **Passage length** — embed at production chunk length (the runner warns if avg is outside 15–400 words). **Multilingual** — default assumption **English-v1**; revisit if any client has non-English content (both finalists have multilingual variants).

## Candidates considered

- **OpenAI `text-embedding-3-large`** @3072 and @1024, float (symmetric).
- **Voyage `voyage-3-large`** @1024, float and int8 (asymmetric doc/query).
- **Cohere `embed-*-v3.0`** — *not run* (no API key this round; re-add for the real bake-off).

## The dry run — validation only, NOT a model verdict

Harness: `tests/eval/embedding-bakeoff/` — **outside `packages/core`**, raw `fetch`, no provider SDK
(chokepoint-safe, #46). L2-normalised float; int8 scored on the vendor-quantised vectors. Synthetic corpus
(26 passages / 30 pairs, 8 no-answer), gitignored.

| candidate | dim | dtype | R@1 | MRR | nDCG@10 | start floor | abstain✓ | separation |
|---|---|---|---|---|---|---|---|---|
| voyage-3-large | 1024 | float | 0.955 | 0.970 | 0.977 | 0.552 | 0.875 | 0.185 ⚠ overlap |
| voyage-3-large | 1024 | int8 | 0.955 | 0.970 | 0.977 | 0.552 | 0.875 | 0.185 ⚠ overlap |
| openai-3-large | 3072 | float | 1.000 | 1.000 | 1.000 | 0.584 | 1.000 | 0.264 |
| openai-3-large | 1024 | float | 1.000 | 1.000 | 1.000 | 0.608 | 1.000 | 0.254 |

**What the dry run did and did not establish:**

- ✅ The harness works end-to-end (ranking metrics, per-model floor derivation, overlap warnings, caching, rate-limit backoff).
- ✅ int8 ≈ float for Voyage (quantisation essentially free *on this data*) — the index-RAM lever (#3) is plausible.
- ✅ OpenAI @1024 ≈ @3072 — dimension reduction looks cheap *on this data*, supporting the N=1024 provisional choice.
- ✅ Floors differ by model on identical questions (0.552 / 0.584 / 0.608) — concrete proof the floor is model-specific (why #14 must re-derive).
- ❌ **Does NOT pick a model.** Ranking is at the ceiling (synthetic saturation); OpenAI's perfect scores are an artifact of easy data, not a quality win. Voyage's distribution overlap on 30 easy pairs is "interesting," not disqualifying.

## Deferred decision (the real one) — owned by #43

Before the first client's data accumulates, run the bake-off on **their de-identified real content** and
**finalise/confirm** the pin:

- [ ] Real corpus (real emails / SOPs / notes / client facts; ~30+ pairs incl. genuine near-duplicate-opposite and cross-client cases) per `tests/eval/embedding-bakeoff/corpus/SCHEMA.md`.
- [ ] Re-add Cohere to the roster (supply key).
- [ ] Decide model + **N** + **dtype** on real ranking + separation — bias a near-tie toward the stable/well-priced option (Watch note).
- [ ] Derive the floor **on the shipped representation** (int8 if quantised wins).
- [ ] Bump `EMBEDDING_VERSION` off `0-provisional`; update this ADR to **Accepted** with the real table.
- [ ] If the model or N changes from the provisional default, that is a re-embed — but at first-client there is ≤ one corpus, so the cost is still near-zero. **This is the last moment it's cheap.**

## Consequences

- M0–M8 build against a concrete, both-finalists-compatible vector space today.
- The provisional stamp (`0-provisional`) makes every vector self-identifying as not-yet-final.
- The obligation to finalise is recorded in **#1** (closed, deferred-pin) and **#43** (onboarding task) so it cannot be silently forgotten.
- **#14** re-derives the floor on the reranker scale regardless of what the real bake-off sets here.
