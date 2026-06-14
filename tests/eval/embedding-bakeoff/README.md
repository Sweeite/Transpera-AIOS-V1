# Embedding bake-off (Issue #1 — the #1 one-way door)

Throwaway eval tooling that picks the embedding model, **dimension**, and **representation (dtype)** before
anything sits on top. Changing any of these later = re-embed every client's corpus + re-calibrate the floor
(Brief §4.7, tech-stack §5.5). It pins **nothing** — it produces a results table + a proposed starting floor
that we review together, then we pin `gateway.ts` + `system-config.ts` and write ADR 0001.

**Chokepoint-safe (#46):** lives outside `packages/core`, imports no provider SDK (raw `fetch`). Only the
winner's call lands in `gateway.embed()`.

## What it measures

- **Ranking (which model wins):** recall@{1,3,5,10} (primary, the Acceptance bar is ≥90%), MRR, nDCG@10.
- **The v1 dense-cosine floor (the audit fix):** the **separation score** between gold-pair cosine and
  no-answer top-1 cosine. The derived floor is an **indicative STARTING value, not validated** (calibration
  set == test set on ~30 pairs) and is **re-derived when the reranker lands (#14)** — a different scale.
- All four conscious calls are surfaced for ADR 0001: **dimension** (#1, handed to #2 for `vector(N)`),
  **quantization** (floor calibrated on the int8 vectors we'd ship, #3), **passage length** and
  **multilingual** (#4).

## Run

```bash
# 1. Corpus in place (gitignored — see corpus/SCHEMA.md):
#      corpus/passages.jsonl + corpus/pairs.json   (synthetic dry-run set is already present)
# 2. Drop the vendor BYO keys into a gitignored .env in THIS folder:
#      tests/eval/embedding-bakeoff/.env
#      ──
#      VOYAGE_API_KEY=...
#      OPENAI_API_KEY=...
# 3. Run (results cached to corpus/.cache so re-runs don't re-spend the BYO budget):
npx tsx --env-file=tests/eval/embedding-bakeoff/.env tests/eval/embedding-bakeoff/run.ts
```

Keys missing? The run still completes — each keyless candidate is reported as an error row, the rest score normally.

Edit `candidates.ts` to trim the roster (2–3 per the issue) or change dim/dtype variants.
