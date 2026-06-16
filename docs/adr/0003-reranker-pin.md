# ADR 0003 — Reranker model, version & the calibrated abstention floor

- **Status:** **Provisional — pending first-client real-data calibration.** (Not "Accepted".)
- **Date:** 2026-06-16
- **Issue:** #14 (the reranker floor). Real calibration tracked under #43 (first-client onboarding).
- **Deciders:** Austin (owner), Claude (build).
- **Supersedes:** the floor half of ADR 0001 — the v1 dense-cosine gate (`retrieval_min_relevance` = 0.608 on
  the cosine scale) is replaced by the reranker score. ADR 0001's *embedding* pin stands unchanged.

## Context

RRF (Reciprocal Rank Fusion, #13) deliberately **discards score magnitude** — it fuses *ranks*, so the fused
order carries no calibrated "how relevant is the top hit?" signal. The abstention decision (Brief §4.7, §6 —
"abstain when unsure, never reach for a weak match to look non-empty") therefore cannot be made on the RRF sum.
The v1 interim used the **pre-fusion dense cosine** of the nearest candidate (ADR 0001, #4). Two problems:

1. **A cosine is not calibrated relevance** — a high cosine can be a near-duplicate of the *wrong* memory.
2. **It was dense-only** — a strong KEYWORD-only candidate (below the dense cosine floor) could never clear,
   even when it was the right answer (the deferral logged on #13).

#14 makes the floor a **cross-encoder reranker score** over the **top-N of the fused union (dense ∪ keyword)**.
The reranker reads the (query, document) pair jointly, so its score is a far better calibrated relevance signal
than either leg's similarity — and feeding it the fused union closes the keyword-only deferral.

## Decision (provisional)

| Knob | Provisional value | Why this value (not a quality verdict) |
|---|---|---|
| reranker model | **Voyage `rerank-2.5-lite`** | Voyage was an Issue #1 finalist (key already provisioned), so we can run *real* calibration now; `-lite` is the cheap tier (the #14 Watch: "keep it cheap" — one model call per query, protects the client's bill via #15). |
| reranker version | **`0-provisional`** | Leading `0` + suffix = unmistakably not the validated pin. First-client decision bumps it. |
| floor (`retrieval_min_relevance`) | **0.5** on **[0, 1]** | The reranker emits a normalised [0,1] relevance score, so the cosine-era bounds [0.5, 0.95] are wrong and were **re-scaled to [0, 1]**. 0.5 is a **provisional, fixture-validated** starting value — **NOT** calibrated on real data. |

Pinned in: `packages/core/src/harness/gateway.ts` (`RERANKER_MODEL` / `RERANKER_VERSION` — **constants**, like
`EMBEDDING_MODEL`, NOT a `system_config` key: a model name is not a threshold/weight/floor, so it sits outside
the §4.8 config red line, and a per-namespace-overridable model could silently diverge from the floor it was
calibrated on). The floor + `reranker_top_n` + `reranker_timeout_ms` ARE bounded `system_config` keys (real
dials). See `packages/core/src/config/system-config.ts`.

### The tripwire (why this ADR exists)

**Changing the reranker model OR version = re-calibrate the floor.** The floor is a number on *this* reranker's
score distribution; a different reranker has a different distribution, so the old floor is meaningless on it —
exactly the model-specific-floor lesson ADR 0001 proved for embeddings (the 0.552 / 0.584 / 0.608 spread). The
pin is a constant + this ADR so the binding cannot be silently broken by a config edit.

## The calibration procedure (the Tier-2 audit fix — NAMED, deferred number)

The floor is derived on a **held-out labelled set**, by the **separation-score** method (the direct analog of
the #1 embedding bake-off, `tests/eval/embedding-bakeoff/metrics.ts::deriveFloor`):

- **Held-out set:** (query, candidate-document, relevant?) triples — **answerable** pairs (the gold document is
  among the fused candidates) **and no-answer** pairs (no document should clear). Real, de-identified client
  content per `tests/eval/reranker-calibration/corpus/SCHEMA.md`.
- **Positives** = the gold document's rerank score per answerable query. **Negatives** = the top-1 rerank score
  over the candidates per no-answer query (what would be *wrongly* admitted).
- **Target metric:** among thresholds that keep **true-positive recall ≥ 0.90** (the Acceptance bar), pick the
  one that **rejects the most no-answer cases**; tie-break toward a higher floor; back off to the midpoint
  below the chosen positive so a gold hit at the threshold still clears. *(The 0.90 target lives here, in the
  ADR — not hard-coded in engine code.)*

The harness ships now (`tests/eval/reranker-calibration/`, raw REST to Voyage, no SDK, gitignored corpus). The
**provisional 0.5 floor is validated only by the eval fixtures** (it makes the intended drop/clear cases pass);
the **real number is deferred to first-client onboarding (#43)**, when de-identified real content exists —
synthetic data saturates ranking and cannot pick a real floor (the #1 lesson; not pretending otherwise).

## New content subprocessor (DPA tripwire)

`rerank()` sends **memory statements** (and, when chunk-abstention lands under #24, chunk text) to **Voyage AI**
on the retrieval path. This is the **same trust class** as `embed()` → OpenAI, but a **new vendor** processing
client content. Before the first client goes live (#43):

- [ ] Add **Voyage AI** to the client DPA / subprocessor list (alongside OpenAI for embeddings, Anthropic for
      generation). Confirm data-handling / retention terms are acceptable for the client's content sensitivity.
- [ ] Confirm the egress boundary holds: the permission predicate filters BOTH legs before the rerank call, so
      a forbidden statement never reaches Voyage (locked by `tests/core/reranker-egress.test.ts`).
- [ ] If a client forbids Voyage, the reranker is swappable behind the gateway (the chokepoint) — but swapping
      it **re-triggers the tripwire above** (re-calibrate the floor). Self-hosting the cross-encoder on GPU is
      the out-of-scope #14 note (revisit at scale).

## Provider response contract — verified MANUALLY, not by CI (a tripwire)

`rerank()` parses the Voyage REST response as `{ data: [{ index, relevance_score }], … }`. **Verified against
the live API on 2026-06-16** — the raw wire wrapper is **`data`** (the Python SDK's `.results` attribute is an
SDK-side rename, NOT the wire shape), and results come back **score-sorted**, which is exactly why `rerank()`
re-keys by `index` into input order. The on-topic document scored 0.605 vs 0.252 off-topic.

⚠ **The hermetic tests assert OUR assumption of this shape, so a green CI cannot detect a Voyage response-format
change** — the real lane has no `VOYAGE_API_KEY`, so `rerank.real.test.ts` self-skips there. If Voyage renames
the wrapper, `json.data ?? []` → `[]` → "rerank returned 0 scores" throws on every live call → retrieve() goes
`degraded` and abstains on EVERY query in prod, while all hermetic tests stay green. **The contract check is the
manual local run of `rerank.real.test.ts` with the key** (`VOYAGE_API_KEY=… npx vitest run tests/core/rerank.real.test.ts`).
**Forward refinement:** wire `VOYAGE_API_KEY` into the CI real lane the way `SUPABASE_DB_URL` is, so the response
contract is checked continuously rather than only on a developer's machine.

## Reranker-unavailable behaviour (Decision A)

A rerank outage (timeout / 5xx) ⇒ **ABSTAIN fail-safe + alert**, never the uncalibrated cosine and never a
silent answer. It is observable on `RetrieveOutcome.degraded`, the retrieval diagnostics span (`degraded:true`),
and a loud alert sink (`onRerankerUnavailable`, default `console.error`). An outage is **not** a knowledge gap,
so it logs **no** `retrieval_miss` (recording one would teach the self-improvement loop a false gap).

## Consequences

- The abstention floor is now a calibrated relevance score; "wrong memory above the cosine floor" cases drop,
  and keyword-only right answers below the cosine floor can clear (acceptance: `reranker-floor.test.ts`).
- One extra model call per query (the Watch) — bounded to `reranker_top_n` documents, one call, post-fusion.
- `RetrieveOutcome.score` changes MEANING (reranker score, not cosine) — no consumer hard-codes the cosine
  scale (`provenance.shouldAbstain` is a scale-agnostic comparator; synthesis reads `.abstained`/`.memories`).
- The obligation to finalise (real model + floor + DPA) is recorded on **#14**, **#43**, and here, so it cannot
  be silently forgotten. **#43** re-derives the floor on the shipped reranker regardless of this provisional.
