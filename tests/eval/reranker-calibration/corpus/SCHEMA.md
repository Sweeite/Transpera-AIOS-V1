# Reranker-calibration corpus schema (Issue #14)

One file drives the calibration. **The real, de-identified `pairs.json` is gitignored** — we never commit
client content, even de-identified. `pairs.example.json` shows the shape only.

Unlike the embedding bake-off (which ranks the whole passage corpus), the reranker scores a **query against the
already-fused candidate set** — exactly what `retrieve()` feeds `rerank()`. So each pair carries its own
candidate list (the fused top-N for that query) and marks which candidates are the right answer.

## `pairs.json` — the labelled set (the arbiter)

```json
{
  "pairs": [
    {
      "name": "acme-reporting-cadence",
      "query": "How often does Acme want to be updated?",
      "candidates": [
        "Acme prefers monthly reporting, delivered async.",
        "Northwind wants weekly check-ins.",
        "The kickoff deck template lives in the shared drive."
      ],
      "goldIndices": [0]
    },
    {
      "name": "unknown-abstains",
      "query": "What is Acme's founder's dog's name?",
      "candidates": [
        "Acme prefers monthly reporting, delivered async.",
        "Acme's HQ is in Leeds."
      ],
      "goldIndices": []
    }
  ]
}
```

| field | meaning |
|---|---|
| `name` | stable case id |
| `query` | the user question |
| `candidates` | the fused candidate documents (memory statements) — what `retrieve()` would rerank |
| `goldIndices` | indices into `candidates` that correctly answer the query; **`[]` ⇒ a no-answer query** (nothing should clear the floor) |

**Deliberately include** (the floor is only as honest as the hard cases):
- **no-answer queries** (`goldIndices: []`) — these set the floor's lower guard; without them the floor is
  unguarded against false-admits (the harness warns).
- **near-duplicate-but-opposite** candidates ("prefers weekly" vs "prefers monthly", §4.5) — a high cosine,
  wrong answer; the reranker should score the right one higher.
- **keyword-strong, semantically-wrong** candidates — the case the reranker exists to catch.
- ~30+ pairs, spanning the memory types (§4.1) and a mix of answerable / no-answer.

The **target metric** is TP recall ≥ 0.90 while maximising correct abstention (ADR 0003). The derived floor is
**indicative on synthetic content** (ranking saturates) — the real number is set on real content at #43.
