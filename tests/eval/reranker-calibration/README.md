# Reranker-floor calibration (Issue #14)

Throwaway eval tooling that derives the **abstention floor** (`retrieval_min_relevance`) on the reranker score
scale — the direct analog of the #1 embedding bake-off, one layer up. RRF discards score magnitude, so the
abstention decision is made on a calibrated cross-encoder rerank score; this harness picks the floor for it.

It pins **nothing** — it produces a separation-score table + a proposed starting floor we review together, then
pin `system-config.ts::retrieval_min_relevance` and update `docs/adr/0003-reranker-pin.md` to **Accepted**.

**Chokepoint-safe (#46):** lives outside `packages/core`, imports no provider SDK (raw `fetch`). Only the
pinned reranker's call lands in `gateway.rerank()`. The model here (`rerank-2.5-lite`) tracks
`gateway.RERANKER_MODEL` — keep them in sync (ADR 0003 is the tripwire: change the model ⇒ re-calibrate).

## What it measures

- **The floor (the audit fix):** the **separation score** between gold-candidate rerank scores and no-answer
  top-1 rerank scores. Among thresholds keeping **TP recall ≥ 0.90** (the Acceptance bar), pick the one that
  rejects the most no-answer queries; back off so a gold hit at the threshold still clears. The derived floor is
  an **indicative STARTING value, not validated** (calibration set == test set) — **re-derived on real content
  at first-client onboarding (#43)**.

## Run

```bash
# 1. Labelled set in place (gitignored — see corpus/SCHEMA.md):
#      corpus/pairs.json   (copy corpus/pairs.example.json and fill in real de-identified cases)
# 2. Drop the BYO key into a gitignored .env in THIS folder:
#      tests/eval/reranker-calibration/.env
#      ──
#      VOYAGE_API_KEY=...
# 3. Run:
npx tsx --env-file=tests/eval/reranker-calibration/.env tests/eval/reranker-calibration/run.ts
```

Key missing? The run exits with a clear message. On synthetic content the ranking saturates and the floor is
indicative only (the #1 lesson) — the **real** number needs de-identified real content (#43).
